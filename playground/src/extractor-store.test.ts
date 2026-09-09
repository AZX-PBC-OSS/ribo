import { expect, test } from "vitest";

import {
  DEFAULT_BACKOFF_BASE_MS,
  DEFAULT_BACKOFF_CAP_MS,
  type SessionItem,
  type Transcript,
} from "@azx/ribo-core";
import { ONDEVICE_CHAT_ENGINE } from "@azx/ribo-extractor-ondevice";
import {
  MAX_ENVELOPED_LEAVES_PER_GROUP,
  splitExtractionSchema,
  type ChatClient,
  type ChatCompletion,
  type ChatRequest,
  type ExtractionGroup,
} from "@azx/ribo-extractor-openai";
import { z } from "zod";
import {
  SNUGGPRO_ADAPTER_NAME,
  snuggExamples,
  snuggExtractionSchema,
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
 *   2. Running the step makes one call per partitioned piece — more than one for
 *      a group whose leaves exceed the per-call cap (see `snuggPieces` below) —
 *      and each call's system message is a per-group prompt, not the full
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
 * The real per-group split, including leaf-count partitioning — the same list
 * `perGroupExtractor` builds internally for the Snugg target (see
 * `ribo-extractor-openai/src/per-group.ts`). Every group whose leaves exceed
 * {@link MAX_ENVELOPED_LEAVES_PER_GROUP} is split into entries sharing one key;
 * every other group is untouched. Building this here (rather than assuming
 * "one entry per group") is what keeps the fake's request naming and response
 * shaping honest as that split evolves.
 */
const snuggPieces = splitExtractionSchema(snuggExtractionSchema, MAX_ENVELOPED_LEAVES_PER_GROUP);

/**
 * The `response_format.json_schema.name` `perGroupExtractor` sends for one
 * prepared entry — mirrors its own construction exactly (`per-group.ts`):
 * `${target.name}-${group.key}` for an unpartitioned group, with a `-${part}`
 * suffix appended for a partitioned piece.
 */
function groupRequestName(group: ExtractionGroup): string {
  const suffix = group.part !== undefined ? `-${group.part}` : "";
  return group.key ? `${SNUGGPRO_ADAPTER_NAME}-${group.key}${suffix}` : SNUGGPRO_ADAPTER_NAME;
}

/**
 * The leaf keys ONE prepared entry asks for — the whole group's keys when
 * unpartitioned, or just this piece's subset when partitioned. Mirrors
 * `per-group.ts`'s own `partitionedLeafKeys`, reading it back out of the entry's
 * own schema so it can never drift from what the real call is pinned to.
 */
function entryLeafKeys(group: ExtractionGroup): readonly string[] {
  const shape = (group.schema as z.ZodObject).shape;
  const value = shape[group.key]!;
  const candidate = value instanceof z.ZodArray ? (value.element as z.ZodType) : value;
  return Object.keys((candidate as z.ZodObject).shape);
}

/** Narrow one instance object (or singleton group object) down to `leafKeys`. */
function narrowToLeaves(value: unknown, leafKeys: readonly string[]): unknown {
  if (Array.isArray(value)) return value.map((element) => narrowToLeaves(element, leafKeys));
  const source = value as Record<string, unknown>;
  const narrowed: Record<string, unknown> = {};
  for (const key of leafKeys) if (key in source) narrowed[key] = source[key];
  return narrowed;
}

/**
 * A fake {@link ChatClient} that returns a valid response for each request,
 * projected from the Delgado fixture. Dispatches by
 * `response_format.json_schema.name` against {@link snuggPieces}, so a
 * partitioned piece (e.g. `hvac`'s two calls) gets back exactly its own leaf
 * subset — the same shape `perGroupExtractor` narrows its few-shot examples to,
 * and the only shape a `z.strictObject` piece schema accepts. The single-shot
 * extractor's un-suffixed, whole-schema name still falls through to the full
 * fixture, so this fake serves both strategies.
 */
function fakeGroupChat(): { chat: ChatClient; requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  const fixtureFields = snuggExamples[0]!.fields as Record<string, unknown>;
  const byName = new Map(snuggPieces.map((group) => [groupRequestName(group), group]));

  const chat: ChatClient = {
    complete: (request: ChatRequest): Promise<ChatCompletion> => {
      requests.push(request);
      const name = request.response_format.json_schema.name;
      const group = byName.get(name);
      const response =
        group === undefined
          ? fixtureFields // the single-shot extractor's whole-schema name
          : (() => {
              const full = fixtureFields[group.key];
              if (full === undefined) return {};
              const value =
                group.part === undefined ? full : narrowToLeaves(full, entryLeafKeys(group));
              return { [group.key]: value };
            })();
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

  // One call per partitioned piece, not one per group: the over-cap groups
  // (see `snuggPieces` above) each split into several calls, so the total is
  // larger than the group count. The single-shot extractor makes 1 call
  // total — this is the assertion that catches a wiring change the status
  // alone might miss (e.g. always constructing `singleShotExtractor`
  // regardless of `strategy`).
  expect(requests).toHaveLength(snuggPieces.length);
  expect(requests).toHaveLength(55);

  // Each call's system message is a per-group prompt, not the full
  // `snuggProInstructions` the single-shot extractor sends. This catches
  // `groupInstructions: snuggGroupInstructions` being dropped from the
  // `perGroupExtractor` call — the extractor would still make the same number
  // of calls, but every call would carry the full prompt instead of its own
  // slice.
  for (const req of requests) {
    const system = req.messages[0]!;
    expect(system.role).toBe("system");
    expect(system.content).not.toBe(snuggProInstructions);
    // The per-group output section asserts "exactly one top-level key"; the
    // single-shot output section asserts the full key list instead.
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

/** Snugg Pro's schema splits into eight top-level groups. */
const SNUGG_GROUPS = 8;

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
