import { expect, test } from "vitest";

import type { ExtractStepInput, OutboxItem, Transcript } from "@azx/ribo-core";
import type { ChatClient, ChatCompletion, ChatRequest } from "@azx/ribo-extractor-openai";
import { snuggExamples, snuggProInstructions } from "@azx/ribo-adapter-snuggpro";

import { buildExtractorStep } from "./extractor-store.js";

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
const item = { id: "item-1" } as OutboxItem;

/**
 * A fake {@link ChatClient} that returns a valid per-group response for each
 * request, projected from the Delgado fixture. The per-group extractor names each
 * request `"{adapter}:{groupKey}"`, so the fake parses the group key off the
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
      // The per-group extractor names each request `"{adapter}:{groupKey}"`;
      // the single-shot extractor names it just `"{adapter}"`. Return the
      // one-key projection for per-group, the full fixture for single-shot.
      const colonIdx = name.indexOf(":");
      const response =
        colonIdx >= 0
          ? (() => {
              const groupKey = name.slice(colonIdx + 1);
              return groupKey in fixtureFields
                ? { [groupKey]: fixtureFields[groupKey] }
                : {};
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
  await extractStep({ item, transcript } as ExtractStepInput);

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

  await extractStep({ item, transcript } as ExtractStepInput);

  // The single-shot extractor makes ONE call carrying the whole schema.
  expect(requests).toHaveLength(1);
  // That one call's system message IS the full instructions.
  expect(requests[0]!.messages[0]!.content).toBe(snuggProInstructions);
});
