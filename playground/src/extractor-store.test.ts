import { expect, test } from "vitest";

import {
  DEFAULT_BACKOFF_BASE_MS,
  DEFAULT_BACKOFF_CAP_MS,
  type SessionItem,
  type Transcript,
} from "@azx/ribo-core";
import { ONDEVICE_CHAT_ENGINE } from "@azx/ribo-extractor-ondevice";
import type { ChatClient, ChatCompletion, ChatRequest } from "@azx/ribo-extractor-openai";
import {
  SNUGGPRO_ADAPTER_NAME,
  snuggExamples,
  snuggProInstructions,
} from "@azx/ribo-adapter-snuggpro";

import {
  buildExtractorStep,
  buildExtractorWiring,
  MANAGED_PER_GROUP_TIMING,
} from "./extractor-store.js";

/**
 * @file R3 Task 5 — the playground's live extractor is the per-group one.
 *
 * `buildExtractorStep` is the testable factory extracted from the module singleton
 * (see `extractor-store.ts`'s file header). These tests call it with a fake API key
 * and an injected {@link ChatClient} — no network, no `import.meta.env` stubbing —
 * and assert two things that only the per-group wiring provides:
 *
 *   1. The status identifies the `"per-group"` strategy (not `"single-shot"`).
 *   2. Running the step makes one call per top-level group (7, not 1), and each
 *      call's system message is a per-group prompt — not the full
 *      `snuggProInstructions` the single-shot extractor sends.
 *
 * Deleting the wiring — reverting to `singleShotExtractor`, or dropping
 * `groupInstructions: snuggGroupInstructions` — turns at least one of these red.
 * `singleShotExtractor` stays reachable as the alternative strategy (pass
 * `strategy: "single-shot"` to the factory); it is not the default.
 */

// `toExtractStep` reads only `transcript.text`, never `item` — same honest stub
// as `packages/ribo-core/src/extractor.test.ts`.
const transcript: Transcript = {
  recordingId: "rec-1",
  text: "A dictated audit transcript, contents irrelevant to the wiring test.",
  engine: "fake",
};
const session: SessionItem = {
  id: "session-1",
  status: "extracting",
  openedAt: "2026-07-23T14:00:00.000Z",
  ctx: { assessmentId: "assessment-1" },
  ref: "assessment-1",
  attempts: 0,
  nextAttemptAt: "2026-07-23T14:00:00.000Z",
  idempotencyKey: "key-session-1",
};

/**
 * A fake {@link ChatClient} that returns a valid per-group response for each
 * request, projected from the Delgado fixture. The per-group extractor names each
 * request `"{adapter}-{groupKey}"`, so the fake parses the group key off the
 * `response_format.json_schema.name` and returns that group's enveloped fields
 * from the fixture — the same shape `projectExample` produces.
 */
function fakeGroupChat(): { chat: ChatClient; requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  const fixtureFields = snuggExamples[0]!.fields as Record<string, unknown>;
  const chat: ChatClient = {
    complete: (request: ChatRequest): Promise<ChatCompletion> => {
      requests.push(request);
      const name = request.response_format.json_schema.name;
      // The per-group extractor names each request `"{adapter}-{groupKey}"`;
      // the single-shot extractor names it just `"{adapter}"`. Return the
      // one-key projection for per-group, the full fixture for single-shot.
      const sepIdx = name.indexOf("-", SNUGGPRO_ADAPTER_NAME.length);
      const response =
        sepIdx >= 0
          ? (() => {
              const groupKey = name.slice(sepIdx + 1);
              return groupKey in fixtureFields ? { [groupKey]: fixtureFields[groupKey] } : {};
            })()
          : fixtureFields;
      return Promise.resolve({
        content: JSON.stringify(response),
        finishReason: "stop",
      });
    },
  };
  return { chat, requests };
}

test("with an API key, the live extractor is the per-group strategy", async () => {
  const { chat, requests } = fakeGroupChat();
  const { extractStep, status } = buildExtractorStep({
    apiKey: "sk-test",
    baseUrl: "http://test",
    model: "test-model",
    chat,
  });

  // Status identifies the per-group strategy — deleting the per-group branch
  // (or reverting the default to "single-shot") turns this red.
  expect(status).toMatchObject({ mode: "live", strategy: "per-group" });

  // Run the step end to end. The fake chat returns valid per-group responses, so
  // the extraction succeeds and the call count is observable.
  await extractStep({ session, transcript: transcript.text, recordingIds: ["rec-1"] });

  // 7 groups → 7 calls. The single-shot extractor makes 1 — this is the
  // assertion that catches a wiring change the status alone might miss (e.g.
  // always constructing `singleShotExtractor` regardless of `strategy`).
  expect(requests).toHaveLength(7);

  // Each call's system message is a per-group prompt, not the full
  // `snuggProInstructions` the single-shot extractor sends. This catches
  // `groupInstructions: snuggGroupInstructions` being dropped from the
  // `perGroupExtractor` call — the extractor would still make 7 calls, but
  // every call would carry the full 14 KB prompt instead of its own slice.
  for (const req of requests) {
    const system = req.messages[0]!;
    expect(system.role).toBe("system");
    expect(system.content).not.toBe(snuggProInstructions);
    // The per-group output section asserts "exactly one top-level key"; the
    // single-shot output section asserts "exactly seven top-level keys".
    expect(system.content).toContain("exactly one top-level key");
  }
});

test("without an API key, the extractor is the fake", () => {
  const { status } = buildExtractorStep({
    apiKey: undefined,
    baseUrl: "http://test",
    model: "test-model",
  });
  expect(status).toMatchObject({ mode: "fake" });
});

test("strategy: 'single-shot' is reachable as the alternative (Task 6's baseline)", async () => {
  const { chat, requests } = fakeGroupChat();
  const { extractStep, status } = buildExtractorStep({
    apiKey: "sk-test",
    baseUrl: "http://test",
    model: "test-model",
    strategy: "single-shot",
    chat,
  });

  expect(status).toMatchObject({ mode: "live", strategy: "single-shot" });

  await extractStep({ session, transcript: transcript.text, recordingIds: ["rec-1"] });

  // The single-shot extractor makes ONE call carrying the whole schema.
  expect(requests).toHaveLength(1);
  // That one call's system message IS the full instructions.
  expect(requests[0]!.messages[0]!.content).toBe(snuggProInstructions);
});

// --- Task 10: the two extraction delegates and their timing model --------------

/** Snugg Pro's schema splits into seven top-level groups. */
const SNUGG_GROUPS = 7;

/**
 * Worst-case accumulated backoff when every retry draws the un-jittered cap.
 * Mirrors the derivation in `perGroupExtractor` so the tests can reason about
 * the actual timing constants without importing the private helper.
 */
function maxAccumulatedBackoff(retries: number, baseMs: number, capMs: number): number {
  let total = 0;
  for (let i = 0; i < retries; i++) {
    total += Math.min(capMs, baseMs * 2 ** Math.min(i, 32));
  }
  return total;
}

/**
 * How many retries the per-group budget actually grants, given the timing
 * constants wired into the production pair. Mirrors `deriveMaxRetries`.
 */
function derivedRetries(
  requested: number,
  groups: number,
  concurrency: number,
  perCallCeilingMs: number,
  stepTimeoutMs: number,
  baseMs: number,
  capMs: number,
): number {
  const batches = Math.ceil(groups / concurrency);
  for (let r = Math.max(0, requested); r >= 0; r--) {
    const perGroup = (r + 1) * perCallCeilingMs + maxAccumulatedBackoff(r, baseMs, capMs);
    if (batches * perGroup <= stepTimeoutMs) return r;
  }
  return 0;
}

// The four on-device retry-budget guards that stood here are gone with the strategy
// they guarded. They asserted that `deriveMaxRetries` granted the on-device delegate at
// least nine retries at an 8s ceiling with near-zero backoff — correct arithmetic for a
// strategy that no longer runs. The on-device path is now `threePhaseExtractor`, which
// degenerated zero times in 283 calls and needs no retry budget to defend.
// `docs/implementation/19-ondevice-extraction-strategies.md` records what they measured.

test("managed delegate keeps the pre-existing defaults", () => {
  expect(MANAGED_PER_GROUP_TIMING.concurrency).toBe(4);
  expect(MANAGED_PER_GROUP_TIMING.perCallCeilingMs).toBe(120_000);
  expect(MANAGED_PER_GROUP_TIMING.maxRetries).toBe(2);
});

test("managed delegate's derived retry count is the pre-existing default of 2", () => {
  const retries = derivedRetries(
    MANAGED_PER_GROUP_TIMING.maxRetries,
    SNUGG_GROUPS,
    MANAGED_PER_GROUP_TIMING.concurrency,
    MANAGED_PER_GROUP_TIMING.perCallCeilingMs,
    MANAGED_PER_GROUP_TIMING.stepTimeoutMs,
    DEFAULT_BACKOFF_BASE_MS,
    DEFAULT_BACKOFF_CAP_MS,
  );
  expect(retries).toBe(2);
});

test("composite order is managed-first, on-device-second", () => {
  const { entries } = buildExtractorWiring({
    apiKey: "sk-test",
    baseUrl: "http://test",
    model: "m",
  });
  expect(entries).toHaveLength(2);
  expect(entries[0]!.source.engine).toBe("openai");
  expect(entries[1]!.source.engine).toBe(ONDEVICE_CHAT_ENGINE);
});

// ---------------------------------------------------------------------------
// Which global the Prompt API actually lives on
//
// Measured rather than assumed: `globalThis.LanguageModel`, under Chrome 149 and
// 151 — see packages/ribo-extractor-ondevice/src/prompt-api-availability.browser.test.ts.
// An earlier draft of this wiring read `globalThis.ai.languageModel`, the older
// experimental shape, which finds nothing today.
//
// Nothing else in this suite would notice that mistake. The on-device entry would
// report `unavailable` forever, the composite would fall back to managed on every
// extraction, and the offline path this feature exists for would never once run —
// with no error and nothing in a log. The only symptom is silence.
// ---------------------------------------------------------------------------

test("the on-device delegate resolves from globalThis.LanguageModel", async () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const hadLanguageModel = "LanguageModel" in globals;
  const previousLanguageModel = globals.LanguageModel;
  const hadAi = "ai" in globals;
  const previousAi = globals.ai;

  // The current global says `available`; the legacy path, if anything read it,
  // says `unavailable`. So the capability answer identifies which one was used.
  globals.LanguageModel = { availability: async () => "available" };
  globals.ai = { languageModel: { availability: async () => "unavailable" } };

  try {
    const { entries } = buildExtractorWiring({
      apiKey: "sk-test",
      baseUrl: "http://test",
      model: "m",
    });
    const onDevice = entries[1]!;
    expect(onDevice.source.engine).toBe(ONDEVICE_CHAT_ENGINE);
    expect(await onDevice.source.capability()).toEqual({ status: "ready" });
  } finally {
    if (hadLanguageModel) globals.LanguageModel = previousLanguageModel;
    else delete globals.LanguageModel;
    if (hadAi) globals.ai = previousAi;
    else delete globals.ai;
  }
});
