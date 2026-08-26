import {
  DEFAULT_BACKOFF_BASE_MS,
  DEFAULT_BACKOFF_CAP_MS,
  enveloped,
  isTransientFailure,
} from "@azx/ribo-core";
import type { Enveloped, ExtractionTarget, ToolAdapterExample } from "@azx/ribo-core";
import { z } from "zod";
import { describe, expect, test } from "vitest";

import { ChatError } from "./chat-client.js";
import type { ChatClient, ChatCompletion, ChatFinishReason, ChatRequest } from "./chat-client.js";
import { deriveMaxRetries, perGroupExtractor } from "./per-group.js";
import { splitExtractionSchema } from "./split-schema.js";

/**
 * Key-free CI tests for the per-group extractor, exercised against a small,
 * SELF-CONTAINED generic target — the same approach as `single-shot.test.ts`.
 * This package is tool-agnostic and must not depend on any adapter, so the
 * fixtures are synthetic field sets rather than a real adapter's. A FAKE
 * {@link ChatClient} captures every request and returns a canned response per
 * group, so nothing here touches the network.
 *
 * Six things are proved — the plan's must-fail tests for Task 2:
 *   1. N groups produce N calls, and the merged result carries every group's fields.
 *   2. A response that fails its group's schema fails the extraction rather than
 *      being merged.
 *   3. The merged result is validated against the full schema — a merge producing
 *      a bad shape is caught even when every individual response parsed cleanly.
 *   4. `normalize` is called once, not once per group.
 *   5. A truncated response (`finishReason: "length"`) is terminal, not retried.
 *   6. The non-grouped fallback still works — one call, exactly as today.
 */

// --- Grouped fixture ---------------------------------------------------------

/**
 * A grouped patch schema — mirrors Snugg Pro's structure: top-level properties
 * are nested objects, each a group of leaves. `enveloped()` recurses into them,
 * so the extraction schema keeps the same top-level keys, and
 * `splitExtractionSchema` produces one group per key.
 */
const groupedPatch = z
  .object({
    hvac: z
      .object({
        equipmentType: z.string().nullable().optional(),
        fuel: z.string().nullable().optional(),
      })
      .strict()
      .optional(),
    attic: z
      .object({
        insulationDepth: z.string().nullable().optional(),
        insulationRValue: z.number().nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const groupedExtraction = enveloped(groupedPatch);
type GroupedValues = z.infer<typeof groupedPatch>;
type GroupedExtraction = Enveloped<GroupedValues>;

const groupedExample: ToolAdapterExample<GroupedExtraction> = {
  transcript: "The unit is a boiler, natural gas. Attic has about ten inches, R-30.",
  fields: {
    hvac: {
      equipmentType: { value: "Boiler", confidence: 0.9, sourceSpan: "The unit is a boiler" },
      fuel: { value: "Natural Gas", confidence: 0.8, sourceSpan: "natural gas" },
    },
    attic: {
      insulationDepth: { value: "10-12", confidence: 0.9, sourceSpan: "about ten inches" },
      insulationRValue: { value: 30, confidence: 0.7, sourceSpan: "R-30" },
    },
  },
};

const groupedTarget: ExtractionTarget<GroupedValues> = {
  name: "demo-grouped",
  extractionSchema: groupedExtraction,
  instructions: "Extract the hvac and attic fields. Emit a null for anything you cannot ground.",
  examples: [groupedExample],
};

/** A valid hvac-only response — shaped like the final answer with one top-level key. */
const hvacResponse = {
  hvac: {
    equipmentType: { value: "Boiler", confidence: 0.9, sourceSpan: "it's a boiler" },
    fuel: { value: "Natural Gas", confidence: 0.8, sourceSpan: "natural gas" },
  },
};

/** A valid attic-only response. */
const atticResponse = {
  attic: {
    insulationDepth: { value: "10-12", confidence: 0.9, sourceSpan: "about ten inches" },
    insulationRValue: { value: 30, confidence: 0.7, sourceSpan: "R-30" },
  },
};

// --- Non-grouped fixture -----------------------------------------------------

/**
 * A flat patch schema — top-level properties are leaves. `enveloped()` wraps
 * each in an envelope, so the extraction schema's top-level properties ARE
 * envelopes — not nested groups. `splitExtractionSchema` yields one fallback
 * entry covering the whole schema: one call, today's behaviour.
 */
const flatPatch = z
  .object({
    rValue: z.number().nullable().optional(),
    area: z.number().nullable().optional(),
  })
  .strict();

const flatExtraction = enveloped(flatPatch);
type FlatValues = z.infer<typeof flatPatch>;
type FlatExtraction = Enveloped<FlatValues>;

const flatExample: ToolAdapterExample<FlatExtraction> = {
  transcript: "The wall is R-13, about four hundred square feet.",
  fields: {
    rValue: { value: 13, confidence: 0.9, sourceSpan: "R-13" },
    area: { value: 400, confidence: 0.8, sourceSpan: "four hundred square feet" },
  },
};

const flatTarget: ExtractionTarget<FlatValues> = {
  name: "demo-flat",
  extractionSchema: flatExtraction,
  instructions: "Extract the rValue and area. Emit a null for anything you cannot ground.",
  examples: [flatExample],
};

const flatResponse = {
  rValue: { value: 13, confidence: 1.2, sourceSpan: "R-13" },
  area: { value: 400, confidence: 0.8, sourceSpan: "four hundred square feet" },
};

// --- Helpers -----------------------------------------------------------------

const clamp = (n: number): number => Math.max(0, Math.min(1, n));

/**
 * A ChatClient that records every request and replays a canned response per
 * group, dispatching by `response_format.json_schema.name`. The name is
 * `${target.name}-${group.key}` for grouped schemas, or just `target.name` for
 * the non-grouped fallback.
 */
function fakeGroupChat(
  responses: Record<string, string>,
  finishReason?: ChatFinishReason,
): { chat: ChatClient; requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  const chat: ChatClient = {
    complete: (request) => {
      requests.push(request);
      const name = request.response_format.json_schema.name;
      const content = responses[name] ?? "{}";
      return Promise.resolve({ content, finishReason });
    },
  };
  return { chat, requests };
}

/** Schema name for a grouped call — `${target.name}-${group.key}`. */
// Mirrors perGroupExtractor's naming. `-`, not `:` — a structured-output schema
// name is constrained to [A-Za-z0-9_-] by at least one platform route.
const groupedName = (key: string): string => `${groupedTarget.name}-${key}`;

// --- Retry-test helper -------------------------------------------------------

/**
 * A {@link ChatClient} that tracks per-group call counts and delegates to a
 * per-group handler, dispatching by `response_format.json_schema.name`. The
 * handler receives the 1-based attempt number and the {@link AbortSignal}, so a
 * test can fail the first N attempts, succeed on attempt N+1, or check whether
 * the signal was passed. If a handler throws, the error propagates as a
 * rejected promise — simulating a transport failure or other transient error.
 */
function fakeRetryChat(
  handlers: Record<string, (attempt: number, signal?: AbortSignal) => ChatCompletion>,
): {
  chat: ChatClient;
  requests: ChatRequest[];
  callCounts: Record<string, number>;
  signals: (AbortSignal | undefined)[];
} {
  const requests: ChatRequest[] = [];
  const callCounts: Record<string, number> = {};
  const signals: (AbortSignal | undefined)[] = [];
  const chat: ChatClient = {
    complete: async (request, options) => {
      const name = request.response_format.json_schema.name;
      callCounts[name] = (callCounts[name] ?? 0) + 1;
      requests.push(request);
      signals.push(options?.signal);
      const attempt = callCounts[name]!;
      const handler = handlers[name] ?? handlers["*"];
      if (!handler) throw new Error(`fakeRetryChat: no handler for "${name}"`);
      return handler(attempt, options?.signal);
    },
  };
  return { chat, requests, callCounts, signals };
}

/** A delay that resolves immediately — so tests do not sleep on backoff. */
const noDelay = (): Promise<void> => Promise.resolve();

// --- Tests -------------------------------------------------------------------

describe("perGroupExtractor — N groups produce N calls", () => {
  test("two groups produce two calls, each pinned to its own schema, and the merged result carries every group's fields", async () => {
    const { chat, requests } = fakeGroupChat({
      [groupedName("hvac")]: JSON.stringify(hvacResponse),
      [groupedName("attic")]: JSON.stringify(atticResponse),
    });
    const extractor = perGroupExtractor({ target: groupedTarget, chat, model: "m" });

    const result = await extractor.extract("Furnace is a Carrier, natural gas. Attic has R-38.");

    expect(requests).toHaveLength(2);
    expect(result.usage.calls).toBe(2);

    // Each request's response_format is pinned to ITS group's schema, not the
    // full schema. The name identifies the group; the schema is the group's
    // strict one-key JSON Schema, not the whole extraction schema.
    const groups = splitExtractionSchema(groupedExtraction);
    for (const group of groups) {
      const req = requests.find(
        (r) => r.response_format.json_schema.name === groupedName(group.key),
      );
      expect(req, `request for group "${group.key}"`).toBeDefined();
      expect(req!.response_format.type).toBe("json_schema");
      expect(req!.response_format.json_schema.strict).toBe(true);
      expect(req!.response_format.json_schema.schema).toEqual(
        z.toJSONSchema(group.schema, { target: "draft-2020-12" }),
      );
    }

    // The merged result carries every group's fields.
    expect(result.fields.hvac.equipmentType.value).toBe("Boiler");
    expect(result.fields.hvac.fuel.value).toBe("Natural Gas");
    expect(result.fields.attic.insulationDepth.value).toBe("10-12");
    expect(result.fields.attic.insulationRValue.value).toBe(30);

    // raw is the merged pre-normalization model output, kept for provenance.
    expect((result.raw as Record<string, unknown>).hvac).toBeDefined();
    expect((result.raw as Record<string, unknown>).attic).toBeDefined();
  });

  test("without groupInstructions, every group gets the same messages — instructions, examples, then transcript last", async () => {
    const { chat, requests } = fakeGroupChat({
      [groupedName("hvac")]: JSON.stringify(hvacResponse),
      [groupedName("attic")]: JSON.stringify(atticResponse),
    });
    const transcript = "Furnace is a Carrier, natural gas. Attic has R-38.";
    await perGroupExtractor({ target: groupedTarget, chat, model: "m" }).extract(transcript);

    // Without `groupInstructions`, both requests carry the SAME messages — the
    // target's full instructions and unprojected examples, with the transcript
    // last. This is today's behaviour (R3 Task 2); Task 4's per-group prompts are
    // opt-in via `groupInstructions`.
    for (const req of requests) {
      expect(req.messages).toEqual([
        { role: "system", content: groupedTarget.instructions },
        { role: "user", content: groupedExample.transcript },
        { role: "assistant", content: JSON.stringify(groupedExample.fields) },
        { role: "user", content: transcript },
      ]);
    }
  });

  test("with groupInstructions, each group gets its own instructions and a projected example", async () => {
    const hvacInstructions = "Extract only the hvac fields.";
    const atticInstructions = "Extract only the attic fields.";
    const groupInstructions = (key: string): string =>
      key === "hvac" ? hvacInstructions : atticInstructions;

    const { chat, requests } = fakeGroupChat({
      [groupedName("hvac")]: JSON.stringify(hvacResponse),
      [groupedName("attic")]: JSON.stringify(atticResponse),
    });
    const transcript = "Furnace is a Carrier, natural gas. Attic has R-38.";
    await perGroupExtractor({ target: groupedTarget, chat, model: "m", groupInstructions }).extract(
      transcript,
    );

    const hvacReq = requests.find(
      (r) => r.response_format.json_schema.name === groupedName("hvac"),
    );
    const atticReq = requests.find(
      (r) => r.response_format.json_schema.name === groupedName("attic"),
    );
    expect(hvacReq, "hvac request").toBeDefined();
    expect(atticReq, "attic request").toBeDefined();

    // Each call gets its own instructions — not the target's full `instructions`.
    expect(hvacReq!.messages[0]).toEqual({ role: "system", content: hvacInstructions });
    expect(atticReq!.messages[0]).toEqual({ role: "system", content: atticInstructions });

    // The example is projected: the assistant turn carries only the group's key,
    // not the whole `fields` object. The transcript (user turn) is unchanged.
    const hvacAssistant = hvacReq!.messages[2]!;
    expect(hvacAssistant.role).toBe("assistant");
    const hvacFields = JSON.parse(hvacAssistant.content) as Record<string, unknown>;
    expect(Object.keys(hvacFields)).toEqual(["hvac"]);
    expect(hvacFields.hvac).toEqual(groupedExample.fields.hvac);

    const atticAssistant = atticReq!.messages[2]!;
    expect(atticAssistant.role).toBe("assistant");
    const atticFields = JSON.parse(atticAssistant.content) as Record<string, unknown>;
    expect(Object.keys(atticFields)).toEqual(["attic"]);
    expect(atticFields.attic).toEqual(groupedExample.fields.attic);

    // The example transcript is unchanged in both.
    expect(hvacReq!.messages[1]).toEqual({ role: "user", content: groupedExample.transcript });
    expect(atticReq!.messages[1]).toEqual({ role: "user", content: groupedExample.transcript });

    // The live transcript is the final user message in both.
    expect(hvacReq!.messages[3]).toEqual({ role: "user", content: transcript });
    expect(atticReq!.messages[3]).toEqual({ role: "user", content: transcript });
  });
});

describe("perGroupExtractor — trust boundary", () => {
  test("a response that fails its group's schema fails the extraction rather than being merged", async () => {
    // The hvac response has a bare string where an envelope object is required.
    // It passes JSON parse but fails the hvac group's zod schema. The extraction
    // must reject — the invalid response is not silently merged.
    const { chat } = fakeGroupChat({
      [groupedName("hvac")]: JSON.stringify({ hvac: "not an envelope object" }),
      [groupedName("attic")]: JSON.stringify(atticResponse),
    });
    const extractor = perGroupExtractor({
      target: groupedTarget,
      chat,
      model: "m",
      delay: noDelay,
    });

    await expect(extractor.extract("t")).rejects.toThrow(/did not match the schema/);
  });

  test("the merged result is validated against the full schema — a bad merge is caught even when every individual response parsed cleanly", async () => {
    // Each group's response passes its own group schema. To prove the SECOND
    // trust-boundary parse runs, we make the full schema's `safeParse` reject
    // the merged result. If the extractor skipped the second parse, this test
    // would succeed instead of throwing.
    //
    // The override is safe because `splitExtractionSchema` reads `.shape` (not
    // `safeParse`) at construction time, so the split is unaffected. Only the
    // full-schema parse at extract time calls the overridden `safeParse`.
    const schema = enveloped(groupedPatch);
    const originalSafeParse = schema.safeParse;
    let fullParseCalled = false;
    schema.safeParse = ((_data: unknown) => {
      fullParseCalled = true;
      return { success: false, error: { message: "merge shape rejected by full schema" } };
    }) as typeof schema.safeParse;

    try {
      const { chat } = fakeGroupChat({
        [groupedName("hvac")]: JSON.stringify(hvacResponse),
        [groupedName("attic")]: JSON.stringify(atticResponse),
      });
      const extractor = perGroupExtractor({
        target: { ...groupedTarget, extractionSchema: schema },
        chat,
        model: "m",
      });

      await expect(extractor.extract("t")).rejects.toThrow(/did not match the schema/);
      expect(fullParseCalled).toBe(true);
    } finally {
      schema.safeParse = originalSafeParse;
    }
  });

  test("normalize is called once, not once per group", async () => {
    // A normalize that counts its own calls. With 2 groups, a per-group
    // normalize would be called 2 times; the correct merged-result normalize
    // is called exactly once.
    let normalizeCalls = 0;
    function countingNormalize(fields: GroupedExtraction): GroupedExtraction {
      normalizeCalls++;
      return {
        hvac: {
          equipmentType: {
            ...fields.hvac.equipmentType,
            confidence: clamp(fields.hvac.equipmentType.confidence),
          },
          fuel: { ...fields.hvac.fuel, confidence: clamp(fields.hvac.fuel.confidence) },
        },
        attic: {
          insulationDepth: {
            ...fields.attic.insulationDepth,
            confidence: clamp(fields.attic.insulationDepth.confidence),
          },
          insulationRValue: {
            ...fields.attic.insulationRValue,
            confidence: clamp(fields.attic.insulationRValue.confidence),
          },
        },
      };
    }

    const { chat } = fakeGroupChat({
      [groupedName("hvac")]: JSON.stringify(hvacResponse),
      [groupedName("attic")]: JSON.stringify(atticResponse),
    });
    const result = await perGroupExtractor({
      target: groupedTarget,
      chat,
      model: "m",
      normalize: countingNormalize,
    }).extract("t");

    expect(normalizeCalls).toBe(1);
    // The single normalize pass clamped confidence across the whole shape.
    expect(result.fields.hvac.equipmentType.confidence).toBe(0.9);
    expect(result.fields.attic.insulationRValue.confidence).toBe(0.7);
  });
});

describe("perGroupExtractor — failure classification", () => {
  test("a truncated response (finishReason 'length') is terminal, not retried", async () => {
    // Both groups return a truncated response. The first one to be processed
    // triggers the TerminalQueueError; the extraction fails. The error must be
    // terminal (not transient) so the queue does not burn eight retries on a
    // deterministic truncation.
    const { chat } = fakeGroupChat(
      {
        [groupedName("hvac")]: JSON.stringify(hvacResponse),
        [groupedName("attic")]: JSON.stringify(atticResponse),
      },
      "length",
    );
    const extractor = perGroupExtractor({ target: groupedTarget, chat, model: "m" });

    const error = await extractor.extract("t").then(
      () => {
        throw new Error("expected extract() to reject on a truncated response");
      },
      (caught: unknown) => caught,
    );

    expect((error as Error).message).toContain("maxTokens");
    expect((error as Error).message).not.toContain("did not match the schema");
    expect(isTransientFailure(error)).toBe(false);
  });

  test("a content-filtered response (finishReason 'content_filter') is terminal, not retried", async () => {
    const { chat } = fakeGroupChat(
      {
        [groupedName("hvac")]: JSON.stringify(hvacResponse),
        [groupedName("attic")]: JSON.stringify(atticResponse),
      },
      "content_filter",
    );
    const extractor = perGroupExtractor({ target: groupedTarget, chat, model: "m" });

    const error = await extractor.extract("t").then(
      () => {
        throw new Error("expected extract() to reject on a content-filtered response");
      },
      (caught: unknown) => caught,
    );

    expect((error as Error).message).toContain("content_filter");
    expect(isTransientFailure(error)).toBe(false);
  });

  test("a schema-invalid group response is transient (queue retries)", async () => {
    // A response that passes JSON parse but fails the group schema throws a
    // plain Error — which isTransientFailure classifies as transient, so the
    // queue retries rather than marking the recording dead.
    const { chat } = fakeGroupChat({
      [groupedName("hvac")]: JSON.stringify({ hvac: "not an envelope" }),
      [groupedName("attic")]: JSON.stringify(atticResponse),
    });
    const extractor = perGroupExtractor({
      target: groupedTarget,
      chat,
      model: "m",
      delay: noDelay,
    });

    const error = await extractor.extract("t").then(
      () => {
        throw new Error("expected extract() to reject");
      },
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("did not match the schema");
    expect(isTransientFailure(error)).toBe(true);
  });
});

describe("perGroupExtractor — non-grouped fallback", () => {
  test("a non-grouped schema makes one call, exactly as today", async () => {
    // A flat enveloped schema whose top-level properties are leaf envelopes
    // (not nested groups) yields one fallback entry from splitExtractionSchema.
    // The per-group extractor makes exactly one call — the same as
    // singleShotExtractor.
    const { chat, requests } = fakeGroupChat({
      [flatTarget.name]: JSON.stringify(flatResponse),
    });
    const extractor = perGroupExtractor({ target: flatTarget, chat, model: "m" });

    const result = await extractor.extract("The wall is R-13, four hundred square feet.");

    expect(requests).toHaveLength(1);
    expect(result.usage.calls).toBe(1);

    // The single request's response_format carries the FULL extraction schema,
    // not a one-key slice — the fallback entry's schema IS the whole schema.
    expect(requests[0]!.response_format.json_schema.name).toBe(flatTarget.name);
    expect(requests[0]!.response_format.json_schema.schema).toEqual(
      z.toJSONSchema(flatExtraction, { target: "draft-2020-12" }),
    );

    // The result carries the fields from the single call.
    expect(result.fields.rValue.value).toBe(13);
    expect(result.fields.area.value).toBe(400);
  });

  test("a non-JSON response in the fallback is transient (queue retries)", async () => {
    const { chat } = fakeGroupChat({ [flatTarget.name]: "Sorry, I can't help. {not json" });
    const extractor = perGroupExtractor({ target: flatTarget, chat, model: "m", delay: noDelay });

    const error = await extractor.extract("t").then(
      () => {
        throw new Error("expected extract() to reject on a non-JSON response");
      },
      (caught: unknown) => caught,
    );

    expect((error as Error).message).toContain("was not valid JSON");
    expect(isTransientFailure(error)).toBe(true);
  });

  test("a truncated response in the fallback is terminal, not retried", async () => {
    const { chat } = fakeGroupChat({ [flatTarget.name]: JSON.stringify(flatResponse) }, "length");
    const extractor = perGroupExtractor({ target: flatTarget, chat, model: "m" });

    const error = await extractor.extract("t").then(
      () => {
        throw new Error("expected extract() to reject on a truncated response");
      },
      (caught: unknown) => caught,
    );

    expect((error as Error).message).toContain("maxTokens");
    expect(isTransientFailure(error)).toBe(false);
  });
});

// --- Task 3: bounded per-group retry -----------------------------------------

/**
 * Five must-fail tests for Task 3 — bounded per-group retry, inside the step
 * budget:
 *   1. A transient failure on one group is retried and the extraction still
 *      succeeds, with the other groups' results intact and not re-requested.
 *   2. A group that fails past its retry budget fails the extraction.
 *   3. A terminal failure is not retried — one call, then the throw, and never delays.
 *   4. The worst case fits the step timeout — every group failing its full
 *      budget, including backoff, does not exceed it. Asserts the relationship,
 *      not wall-clock.
 *   5. No new work starts after a failure.
 *   6. Attempts are separated by a backoff delay — called between attempts with
 *      a growing value, not before the first attempt.
 */
describe("perGroupExtractor — bounded retry (Task 3)", () => {
  test("a transient failure on one group is retried and the extraction still succeeds, with other groups not re-requested", async () => {
    // hvac fails transiently on attempt 1, succeeds on attempt 2. attic
    // succeeds on attempt 1. The extraction succeeds, and attic is NOT
    // re-requested — its first result is held, not discarded.
    const { chat, callCounts } = fakeRetryChat({
      [groupedName("hvac")]: (attempt) => {
        if (attempt < 2) throw ChatError.transport("transient blip");
        return { content: JSON.stringify(hvacResponse), finishReason: "stop" };
      },
      [groupedName("attic")]: () => ({
        content: JSON.stringify(atticResponse),
        finishReason: "stop",
      }),
    });
    const extractor = perGroupExtractor({
      target: groupedTarget,
      chat,
      model: "m",
      maxRetries: 2,
      delay: noDelay,
    });

    const result = await extractor.extract("Furnace is a Carrier. Attic has R-38.");

    // hvac was called twice (1 initial + 1 retry); attic was called once.
    expect(callCounts[groupedName("hvac")]).toBe(2);
    expect(callCounts[groupedName("attic")]).toBe(1);
    // usage.calls reports the real call count, including the retry.
    expect(result.usage.calls).toBe(3);

    // Both groups' fields are in the merged result.
    expect(result.fields.hvac.equipmentType.value).toBe("Boiler");
    expect(result.fields.hvac.fuel.value).toBe("Natural Gas");
    expect(result.fields.attic.insulationDepth.value).toBe("10-12");
    expect(result.fields.attic.insulationRValue.value).toBe(30);
  });

  test("a group that fails past its retry budget fails the extraction", async () => {
    // hvac fails transiently on every attempt. With maxRetries=2, it is called
    // 3 times (1 initial + 2 retries), then the extraction throws.
    const { chat, callCounts } = fakeRetryChat({
      [groupedName("hvac")]: () => {
        throw ChatError.transport("persistent blip");
      },
      [groupedName("attic")]: () => ({
        content: JSON.stringify(atticResponse),
        finishReason: "stop",
      }),
    });
    const extractor = perGroupExtractor({
      target: groupedTarget,
      chat,
      model: "m",
      maxRetries: 2,
      delay: noDelay,
    });

    await expect(extractor.extract("t")).rejects.toThrow("persistent blip");

    // hvac exhausted its budget: 3 calls (1 initial + 2 retries).
    expect(callCounts[groupedName("hvac")]).toBe(3);
  });

  test("a terminal failure is not retried — one call, then the throw, and never delays", async () => {
    // hvac returns a truncated response (finishReason: "length"). This is a
    // TerminalQueueError — it must not be retried. One call to hvac, then the
    // extraction throws. The delay function is never called: terminal failures
    // short-circuit before the backoff.
    const delays: number[] = [];
    const recordingDelay = (ms: number): Promise<void> => {
      delays.push(ms);
      return Promise.resolve();
    };
    const { chat, callCounts } = fakeRetryChat({
      [groupedName("hvac")]: () => ({
        content: JSON.stringify(hvacResponse),
        finishReason: "length",
      }),
      [groupedName("attic")]: () => ({
        content: JSON.stringify(atticResponse),
        finishReason: "stop",
      }),
    });
    const extractor = perGroupExtractor({
      target: groupedTarget,
      chat,
      model: "m",
      maxRetries: 2,
      delay: recordingDelay,
    });

    const error = await extractor.extract("t").then(
      () => {
        throw new Error("expected extract() to reject on a terminal failure");
      },
      (caught: unknown) => caught,
    );

    // hvac was called exactly once — the terminal failure was not retried.
    expect(callCounts[groupedName("hvac")]).toBe(1);
    expect((error as Error).message).toContain("maxTokens");
    expect(isTransientFailure(error)).toBe(false);
    // The delay function was never called — terminal failures don't back off.
    expect(delays).toHaveLength(0);
  });

  test("the worst case — every group failing its full budget, including backoff — fits inside the step timeout", async () => {
    // Every group fails transiently on every attempt. With maxRetries=2, each
    // group is called 3 times, with backoff delays between attempts. The total
    // calls = G * (maxRetries + 1). We verify the budget is bounded and then
    // assert the mathematical relationship to stepTimeoutMs — including
    // accumulated backoff, not a wall-clock duration.
    const { chat, callCounts } = fakeRetryChat({
      [groupedName("hvac")]: () => {
        throw ChatError.transport("blip");
      },
      [groupedName("attic")]: () => {
        throw ChatError.transport("blip");
      },
    });
    const maxRetries = 2;
    const stepTimeoutMs = 900_000;
    const concurrency = 4;
    const extractor = perGroupExtractor({
      target: groupedTarget,
      chat,
      model: "m",
      maxRetries,
      stepTimeoutMs,
      concurrency,
      delay: noDelay,
    });

    await expect(extractor.extract("t")).rejects.toThrow("blip");

    const G = splitExtractionSchema(groupedExtraction).length;
    const totalCalls = Object.values(callCounts).reduce((a, b) => a + b, 0);

    // The budget is bounded: total calls = G * (maxRetries + 1).
    expect(totalCalls).toBe(G * (maxRetries + 1));

    // The worst case — call time PLUS accumulated backoff — fits within the
    // step timeout. The relay wraps extract() in withTimeout(stepTimeoutMs).
    // The worst case per batch is one group's full budget:
    //   (maxRetries + 1) * PER_CALL_CEILING_MS + maxAccumulatedBackoff
    // across ceil(G / concurrency) sequential batches. This asserts the
    // relationship, not a timing duration — a timing-dependent test is a
    // flaky test.
    const perCallCeilingMs = 120_000;
    const baseMs = DEFAULT_BACKOFF_BASE_MS;
    const capMs = DEFAULT_BACKOFF_CAP_MS;
    let accumulatedBackoff = 0;
    for (let i = 0; i < maxRetries; i++) {
      accumulatedBackoff += Math.min(capMs, baseMs * 2 ** i);
    }
    const worstCasePerGroup = (maxRetries + 1) * perCallCeilingMs + accumulatedBackoff;
    const worstCase = Math.ceil(G / concurrency) * worstCasePerGroup;
    expect(worstCase).toBeLessThanOrEqual(stepTimeoutMs);

    // Also verify for the production Snugg target (7 groups) — the tighter
    // bound that motivated the default.
    const snuggGroups = 7;
    const snuggWorstCase = Math.ceil(snuggGroups / concurrency) * worstCasePerGroup;
    expect(snuggWorstCase).toBeLessThanOrEqual(stepTimeoutMs);

    // The backoff-aware cap kicks in: with a stepTimeoutMs too tight for
    // maxRetries=2 including backoff (363_001 would fit, 362_999 would not),
    // the effective retries are capped to 1 — the old call-time-only formula
    // would still allow 2, so this is the assertion that catches a derivation
    // that ignores backoff.
    const tightTimeout = 362_999;
    const { chat: tightChat, callCounts: tightCounts } = fakeRetryChat({
      [groupedName("hvac")]: () => {
        throw ChatError.transport("blip");
      },
      [groupedName("attic")]: () => {
        throw ChatError.transport("blip");
      },
    });
    const tightExtractor = perGroupExtractor({
      target: groupedTarget,
      chat: tightChat,
      model: "m",
      maxRetries,
      stepTimeoutMs: tightTimeout,
      concurrency,
      delay: noDelay,
    });
    await expect(tightExtractor.extract("t")).rejects.toThrow("blip");
    const tightTotal = Object.values(tightCounts).reduce((a, b) => a + b, 0);
    // effectiveMaxRetries is capped to 1 (not 2) because maxRetries=2 with
    // backoff would exceed the tight timeout: 3 * 120_000 + 3_000 = 363_000 >
    // 362_999. Total calls = G * (1 + 1) = 4, not 6.
    expect(tightTotal).toBe(G * 2);
  });

  test("no new work starts after a failure — the pool stops pulling", async () => {
    // Three groups, concurrency 2. Two workers start: one pulls hvac, one
    // pulls attic. hvac fails immediately (maxRetries=0, one attempt). The
    // failing worker sets the `failed` flag and calls abort. When the attic
    // worker finishes its in-flight call, it checks `failed` and returns
    // WITHOUT pulling wall. wall must NEVER be called.
    //
    // This test needs more items than workers — with concurrency 1 the
    // single worker exits by throwing, so "no new work" is trivially true
    // even without the pool fix. Three groups with concurrency 2 is the
    // minimal setup where the fix is observable: there IS a remaining item
    // (wall) that a worker could pull after a sibling fails.
    const tripledPatch = z
      .object({
        hvac: z.object({ equipmentType: z.string().nullable().optional() }).strict().optional(),
        attic: z.object({ insulationDepth: z.string().nullable().optional() }).strict().optional(),
        wall: z.object({ rValue: z.number().nullable().optional() }).strict().optional(),
      })
      .strict();

    const tripledTarget: ExtractionTarget<z.infer<typeof tripledPatch>> = {
      name: "demo-tripled",
      extractionSchema: enveloped(tripledPatch),
      instructions: "Extract the fields.",
      examples: [],
    };
    const tripledName = (key: string): string => `${tripledTarget.name}-${key}`;

    const { chat, callCounts, signals } = fakeRetryChat({
      [tripledName("hvac")]: () => {
        throw ChatError.transport("fail immediately");
      },
      [tripledName("attic")]: () => ({
        content: JSON.stringify({
          attic: {
            insulationDepth: { value: "10-12", confidence: 0.9, sourceSpan: "about ten inches" },
          },
        }),
        finishReason: "stop",
      }),
      [tripledName("wall")]: () => ({
        content: JSON.stringify({
          wall: { rValue: { value: 13, confidence: 0.9, sourceSpan: "R-13" } },
        }),
        finishReason: "stop",
      }),
    });
    const extractor = perGroupExtractor({
      target: tripledTarget,
      chat,
      model: "m",
      maxRetries: 0,
      concurrency: 2,
    });

    await expect(extractor.extract("t")).rejects.toThrow("fail immediately");

    // hvac was called once (maxRetries=0). attic was called once (it was
    // in-flight when hvac failed). wall was NEVER started — the pool stopped
    // pulling after the failure.
    expect(callCounts[tripledName("hvac")]).toBe(1);
    expect(callCounts[tripledName("attic")]).toBe(1);
    expect(callCounts[tripledName("wall")]).toBeUndefined();

    // The abort signal was wired — each call receives an AbortSignal.
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });

  test("attempts are separated by a delay — called between attempts with a growing value, not before the first", async () => {
    // A single group (the non-grouped fallback) fails on the first two
    // attempts and succeeds on the third. The injected delay records every
    // value it is called with. With random=1 and base=1000, fullJitterDelay
    // returns the full window: 1000 after attempt 0, 2000 after attempt 1.
    // The delay must NOT be called before the first attempt.
    const delays: number[] = [];
    const recordingDelay = (ms: number): Promise<void> => {
      delays.push(ms);
      return Promise.resolve();
    };
    const { chat, callCounts } = fakeRetryChat({
      [flatTarget.name]: (attempt) => {
        if (attempt <= 2) throw ChatError.transport("blip");
        return { content: JSON.stringify(flatResponse), finishReason: "stop" };
      },
    });
    const extractor = perGroupExtractor({
      target: flatTarget,
      chat,
      model: "m",
      maxRetries: 2,
      delay: recordingDelay,
      random: () => 1,
      baseMs: 1000,
    });

    const result = await extractor.extract("The wall is R-13, four hundred square feet.");

    // Three calls: attempt 0 (fail), attempt 1 (fail), attempt 2 (succeed).
    expect(callCounts[flatTarget.name]).toBe(3);
    expect(result.fields.rValue.value).toBe(13);

    // The delay was called exactly twice — between attempt 0→1 and 1→2.
    // It was NOT called before the first attempt, and NOT after the
    // successful third attempt.
    expect(delays).toHaveLength(2);
    // The values are the full-jitter windows with random=1: base * 2^0 = 1000,
    // base * 2^1 = 2000. Growing — a 429 re-sent immediately is the bug this
    // fixes.
    expect(delays[0]).toBe(1000);
    expect(delays[1]).toBe(2000);
    expect(delays[1]).toBeGreaterThan(delays[0]!);
  });
});

describe("perGroupExtractor — per-call ceiling derivation (Task 1)", () => {
  const snuggGroups = 7;

  test("default ceiling keeps existing callers at the requested retry count", () => {
    expect(
      deriveMaxRetries(
        2,
        Math.ceil(snuggGroups / 4),
        900_000,
        120_000,
        DEFAULT_BACKOFF_BASE_MS,
        DEFAULT_BACKOFF_CAP_MS,
      ),
    ).toBe(2);
  });

  test("serializing under the default ceiling yields zero retries", () => {
    expect(
      deriveMaxRetries(
        2,
        snuggGroups,
        900_000,
        120_000,
        DEFAULT_BACKOFF_BASE_MS,
        DEFAULT_BACKOFF_CAP_MS,
      ),
    ).toBe(0);
  });

  test("a lower ceiling lets a serial delegate honour the requested retries", () => {
    expect(
      deriveMaxRetries(
        4,
        snuggGroups,
        900_000,
        15_000,
        DEFAULT_BACKOFF_BASE_MS,
        DEFAULT_BACKOFF_CAP_MS,
      ),
    ).toBe(4);
  });
});

test("every per-group schema name is within the structured-output name charset", async () => {
  // Platform routes constrain `response_format.json_schema.name` to
  // [A-Za-z0-9_-]{1,64}. A name outside it is rejected with a generic validation
  // error that reads identically to an over-cap schema — an expensive thing to
  // diagnose, so pin the charset here rather than rediscover it against a route.
  const { chat, requests } = fakeGroupChat({
    [groupedName("hvac")]: JSON.stringify(hvacResponse),
    [groupedName("attic")]: JSON.stringify(atticResponse),
  });

  await perGroupExtractor({ target: groupedTarget, chat, model: "m" }).extract("t");

  expect(requests.length).toBeGreaterThan(1);
  for (const request of requests) {
    expect(request.response_format.json_schema.name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  }
});
