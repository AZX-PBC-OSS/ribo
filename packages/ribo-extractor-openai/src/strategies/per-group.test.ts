import {
  ChatError,
  DEFAULT_BACKOFF_BASE_MS,
  DEFAULT_BACKOFF_CAP_MS,
  enveloped,
  isTransientFailure,
  SchemaParseError,
} from "@azx/ribo-core";
import type {
  ChatClient,
  ChatCompletion,
  ChatFinishReason,
  ChatRequest,
  Enveloped,
  ExtractionTarget,
  ExtractOptions,
  GroupUnit,
  RetryBudget,
  ToolAdapterExample,
} from "@azx/ribo-core";
import { z } from "zod";
import { describe, expect, test } from "vitest";

import { perGroupExtractor, perGroupPlan } from "./per-group.js";
import { splitExtractionSchema } from "../schema/split-schema.js";

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
 * handler receives the 1-based attempt number and the `AbortSignal`, so a
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
      const attempt = callCounts[name];
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
  test("token usage is summed across every group call, cache counts included", async () => {
    // The point of the whole seam: one extraction is N calls, and the only place
    // the per-call totals can be added up is here. `helixChat` reports a prefix
    // cache hit per call; a consumer asking "is the cache working" needs the sum,
    // and before this the extractor reported `{ calls }` and dropped the rest.
    const requests: ChatRequest[] = [];
    const chat: ChatClient = {
      complete: (request) => {
        requests.push(request);
        const name = request.response_format.json_schema.name;
        const content = name.endsWith("-hvac")
          ? JSON.stringify(hvacResponse)
          : JSON.stringify(atticResponse);
        return Promise.resolve({
          content,
          finishReason: "stop",
          // Deliberately different per call, so a sum cannot be mistaken for
          // either one of them, and a cold/warm split is visible.
          usage: name.endsWith("-hvac")
            ? {
                promptTokens: 1000,
                completionTokens: 100,
                cachedPromptTokens: 0,
                cacheCreationPromptTokens: 900,
              }
            : {
                promptTokens: 1200,
                completionTokens: 150,
                cachedPromptTokens: 900,
                cacheCreationPromptTokens: 0,
              },
        });
      },
    };

    const result = await perGroupExtractor({ target: groupedTarget, chat, model: "m" }).extract({
      text: "Furnace is a Carrier, natural gas. Attic has R-38.",
      annotations: {},
    });

    expect(result.usage.calls).toBe(2);
    expect(result.usage.promptTokens).toBe(2200);
    expect(result.usage.completionTokens).toBe(250);
    expect(result.usage.cachedPromptTokens).toBe(900);
    expect(result.usage.cacheCreationPromptTokens).toBe(900);
  });

  test("a transport that reports tokens but no cache counts leaves the cache totals absent", async () => {
    // The distinction `addUsage` exists to protect, and the one a naive `?? 0`
    // destroys: this transport DOES report usage, just not cache counts. Summing a
    // missing count as 0 would answer "the cache is not being hit" to a question
    // whose real answer is "this endpoint does not say".
    const chat: ChatClient = {
      complete: (request) => {
        const name = request.response_format.json_schema.name;
        return Promise.resolve({
          content: name.endsWith("-hvac")
            ? JSON.stringify(hvacResponse)
            : JSON.stringify(atticResponse),
          finishReason: "stop",
          usage: { promptTokens: 500, completionTokens: 50 },
        });
      },
    };

    const result = await perGroupExtractor({ target: groupedTarget, chat, model: "m" }).extract({
      text: "x",
      annotations: {},
    });

    expect(result.usage.promptTokens).toBe(1000);
    expect(result.usage.cachedPromptTokens).toBeUndefined();
    expect(result.usage.cacheCreationPromptTokens).toBeUndefined();
  });

  test("token totals stay absent when the transport reports no usage", async () => {
    // Every fake in this file, and any on-device engine, reports no usage. An
    // absent total must stay absent rather than becoming a misleading 0.
    const { chat } = fakeGroupChat({
      [groupedName("hvac")]: JSON.stringify(hvacResponse),
      [groupedName("attic")]: JSON.stringify(atticResponse),
    });

    const result = await perGroupExtractor({ target: groupedTarget, chat, model: "m" }).extract({
      text: "x",
      annotations: {},
    });

    expect(result.usage.calls).toBe(2);
    expect(result.usage.promptTokens).toBeUndefined();
    expect(result.usage.cachedPromptTokens).toBeUndefined();
  });

  test("two groups produce two calls, each pinned to its own schema, and the merged result carries every group's fields", async () => {
    const { chat, requests } = fakeGroupChat({
      [groupedName("hvac")]: JSON.stringify(hvacResponse),
      [groupedName("attic")]: JSON.stringify(atticResponse),
    });
    const extractor = perGroupExtractor({ target: groupedTarget, chat, model: "m" });

    const result = await extractor.extract({
      text: "Furnace is a Carrier, natural gas. Attic has R-38.",
      annotations: {},
    });

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
    await perGroupExtractor({ target: groupedTarget, chat, model: "m" }).extract({
      text: transcript,
      annotations: {},
    });

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
      { text: transcript, annotations: {} },
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

    await expect(extractor.extract({ text: "t", annotations: {} })).rejects.toThrow(
      /did not match the schema/,
    );
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
    // Bound immediately — this reference is only restored in `finally`, never called.
    const originalSafeParse = schema.safeParse.bind(schema);
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

      await expect(extractor.extract({ text: "t", annotations: {} })).rejects.toThrow(
        /did not match the schema/,
      );
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
    }).extract({ text: "t", annotations: {} });

    expect(normalizeCalls).toBe(1);
    // The single normalize pass clamped confidence across the whole shape.
    expect(result.fields.hvac.equipmentType.confidence).toBe(0.9);
    expect(result.fields.attic.insulationRValue.confidence).toBe(0.7);
  });
});

describe("perGroupExtractor — failure classification", () => {
  test("a truncated response (finishReason 'length') is terminal, not retried", async () => {
    // Both groups return a truncated response. The first one to be processed
    // triggers the TerminalError; the extraction fails. The error must be
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

    const error = await extractor.extract({ text: "t", annotations: {} }).then(
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

    const error = await extractor.extract({ text: "t", annotations: {} }).then(
      () => {
        throw new Error("expected extract() to reject on a content-filtered response");
      },
      (caught: unknown) => caught,
    );

    expect((error as Error).message).toContain("content_filter");
    expect(isTransientFailure(error)).toBe(false);
  });

  test("a schema-invalid group response is a sampled parse failure (transient, so the queue retries)", async () => {
    // A response that passes JSON parse but fails the group schema is a sampled
    // miss: the same request can pass zod on re-send. It is therefore transient
    // (the queue retries) but also recognisable (SchemaParseError) so a strategy
    // ladder can fall through. The failing group is retried; the sibling group is
    // called once and held while the failing group retries.
    const { chat, callCounts } = fakeRetryChat({
      [groupedName("hvac")]: () => ({
        content: JSON.stringify({ hvac: "not an envelope" }),
        finishReason: "stop",
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
      delay: noDelay,
    });

    const error = await extractor.extract({ text: "t", annotations: {} }).then(
      () => {
        throw new Error("expected extract() to reject");
      },
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(SchemaParseError);
    expect((error as Error).message).toContain("did not match the schema");
    expect((error as Error).message).toContain("hvac");
    expect(isTransientFailure(error)).toBe(true);

    // The failing group was retried, not marked dead immediately.
    expect(callCounts[groupedName("hvac")]).toBeGreaterThan(1);
    // The sibling group was not re-requested.
    expect(callCounts[groupedName("attic")]).toBe(1);
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

    const result = await extractor.extract({
      text: "The wall is R-13, four hundred square feet.",
      annotations: {},
    });

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

    const error = await extractor.extract({ text: "t", annotations: {} }).then(
      () => {
        throw new Error("expected extract() to reject on a non-JSON response");
      },
      (caught: unknown) => caught,
    );

    expect((error as Error).message).toContain("was not valid JSON");
    expect(isTransientFailure(error)).toBe(true);
    expect(error).not.toBeInstanceOf(SchemaParseError);
  });

  test("a truncated response in the fallback is terminal, not retried", async () => {
    const { chat } = fakeGroupChat({ [flatTarget.name]: JSON.stringify(flatResponse) }, "length");
    const extractor = perGroupExtractor({ target: flatTarget, chat, model: "m" });

    const error = await extractor.extract({ text: "t", annotations: {} }).then(
      () => {
        throw new Error("expected extract() to reject on a truncated response");
      },
      (caught: unknown) => caught,
    );

    expect((error as Error).message).toContain("maxTokens");
    expect(isTransientFailure(error)).toBe(false);
  });
});

/**
 * A mixed schema end to end: `splitExtractionSchema`'s mixed branch emits one
 * entry per group plus the loose leaves as the unwrapped portion (`""`), and
 * the widened `GroupMap` accepts that map. These are the pins for
 * mixed-schema-split design §6: the loose piece's request is the flat
 * fallback's request — the target's own instructions, its full unprojected
 * example, no group-key infix in the name — and `groupInstructions` is never
 * invoked with `""`.
 */
describe("perGroupExtractor — a mixed schema: groups beside loose leaves", () => {
  const mixedPatch = z
    .object({
      hvac: z
        .object({
          equipmentType: z.string().nullable().optional(),
          fuel: z.string().nullable().optional(),
        })
        .strict()
        .optional(),
      note: z.string().nullable().optional(),
      yearBuilt: z.number().nullable().optional(),
    })
    .strict();
  const mixedExtraction = enveloped(mixedPatch);
  type MixedValues = z.infer<typeof mixedPatch>;
  type MixedFields = Enveloped<MixedValues>;

  const mixedExample: ToolAdapterExample<MixedFields> = {
    transcript: "A boiler, natural gas, built in 1978, with a note.",
    fields: {
      hvac: {
        equipmentType: { value: "Boiler", confidence: 0.9, sourceSpan: "a boiler" },
        fuel: { value: "Natural Gas", confidence: 0.8, sourceSpan: "natural gas" },
      },
      note: { value: "a note", confidence: 0.9, sourceSpan: "with a note" },
      yearBuilt: { value: 1978, confidence: 0.8, sourceSpan: "1978" },
    },
  };

  const mixedTarget: ExtractionTarget<MixedValues> = {
    name: "demo-mixed",
    extractionSchema: mixedExtraction,
    instructions: "Extract the hvac group and the loose leaves.",
    examples: [mixedExample],
  };

  const mixedHvacResponse = {
    hvac: {
      equipmentType: { value: "Boiler", confidence: 0.9, sourceSpan: "it's a boiler" },
      fuel: { value: "Natural Gas", confidence: 0.8, sourceSpan: "natural gas" },
    },
  };
  const mixedLooseResponse = {
    note: { value: "a note", confidence: 0.9, sourceSpan: "the note" },
    yearBuilt: { value: 1978, confidence: 0.8, sourceSpan: "built in 1978" },
  };

  test("one request per group plus the loose piece; the loose request is the flat fallback's request", async () => {
    const { chat, requests } = fakeGroupChat({
      "demo-mixed-hvac": JSON.stringify(mixedHvacResponse),
      "demo-mixed": JSON.stringify(mixedLooseResponse),
    });
    const events: GroupUnit[] = [];
    const extractor = perGroupExtractor({
      target: mixedTarget,
      chat,
      model: "m",
      onUnit: (e) => events.push(e),
    });

    const result = await extractor.extract({ text: "the transcript", annotations: {} });

    // One call per piece: the group with its infix, the loose piece without.
    expect(requests.map((r) => r.response_format.json_schema.name).sort()).toEqual([
      "demo-mixed",
      "demo-mixed-hvac",
    ]);

    // The loose piece's request is byte-identical to what the flat fallback
    // sends for this target: the target's own instructions, and the FULL
    // unprojected example — no projection exists for leaves that belong to no
    // group, and none is invented (design §6).
    const looseReq = requests.find((r) => r.response_format.json_schema.name === "demo-mixed")!;
    const looseSchema = looseReq.response_format.json_schema.schema as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(looseSchema.properties)).toEqual(["note", "yearBuilt"]);
    expect(looseReq.messages[0]).toEqual({ role: "system", content: mixedTarget.instructions });
    const looseAssistant = looseReq.messages[2]!;
    expect(looseAssistant.role).toBe("assistant");
    expect(JSON.parse(looseAssistant.content)).toEqual(mixedExample.fields);

    // The merged result carries the group under its key and the loose leaves
    // flat — the sweep workaround's result minus the invented group.
    expect(result.fields).toEqual({ ...mixedHvacResponse, ...mixedLooseResponse });
    expect(result.usage.calls).toBe(2);

    // The GroupUnit stream carries "" beside the named key, which
    // observability consumers already tolerate from the flat fallback.
    const starts = events.filter((e) => e.phase === "start");
    expect(starts.map((e) => [e.key, e.part, e.parts])).toEqual([
      ["hvac", 1, 1],
      ["", 1, 1],
    ]);
  });

  test('with groupInstructions, the named group gets its own and the loose piece keeps the target\'s — groupInstructions is never called with ""', async () => {
    const seen: string[] = [];
    const groupInstructions = (key: string): string => {
      seen.push(key);
      return `Rules for ${key}.`;
    };
    const { chat, requests } = fakeGroupChat({
      "demo-mixed-hvac": JSON.stringify(mixedHvacResponse),
      "demo-mixed": JSON.stringify(mixedLooseResponse),
    });
    const extractor = perGroupExtractor({
      target: mixedTarget,
      chat,
      model: "m",
      groupInstructions,
    });

    await extractor.extract({ text: "the transcript", annotations: {} });

    // The group gets its own instructions and a projected example; the loose
    // piece keeps the target's instructions and full example (design §6).
    expect(seen).toEqual(["hvac"]);
    const hvacReq = requests.find((r) => r.response_format.json_schema.name === "demo-mixed-hvac")!;
    expect(hvacReq.messages[0]).toEqual({ role: "system", content: "Rules for hvac." });
    const hvacFields = JSON.parse(hvacReq.messages[2]!.content) as Record<string, unknown>;
    expect(Object.keys(hvacFields)).toEqual(["hvac"]);
    const looseReq = requests.find((r) => r.response_format.json_schema.name === "demo-mixed")!;
    expect(looseReq.messages[0]).toEqual({ role: "system", content: mixedTarget.instructions });
    expect(JSON.parse(looseReq.messages[2]!.content)).toEqual(mixedExample.fields);
  });

  test("a partitioned loose piece narrows its example to the piece's own leaves", async () => {
    // The byte-cap-half of the prompt contract (design §6): an UNPARTITIONED
    // loose piece keeps the full example (above); a partitioned one narrows
    // through the same `partitionedLeafKeys` → `narrowToLeaves` path the flat
    // fallback's pieces use.
    const enumLeaf = (seed: string) =>
      z.enum([
        `option-alpha-${seed}-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
        `option-bravo-${seed}-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`,
        `option-charlie-${seed}-cccccccccccccccccccccccccccccc`,
      ]);
    const cappedPatch = z
      .object({
        hvac: z.object({ fuel: z.string().nullable().optional() }).strict().optional(),
        looseA: enumLeaf("a"),
        looseB: enumLeaf("b"),
        looseC: enumLeaf("c"),
        looseD: enumLeaf("d"),
      })
      .strict();
    type CappedValues = z.infer<typeof cappedPatch>;
    type CappedFields = Enveloped<CappedValues>;
    const env = <const V>(v: V) => ({ value: v, confidence: 0.9, sourceSpan: String(v) });
    const cappedTarget: ExtractionTarget<CappedValues> = {
      name: "demo-mixed-cap",
      extractionSchema: enveloped(cappedPatch),
      instructions: "Extract.",
      examples: [
        {
          transcript: "t",
          fields: {
            hvac: { fuel: env("gas") },
            looseA: env("option-alpha-a-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
            looseB: env("option-alpha-b-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
            looseC: env("option-alpha-c-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
            looseD: env("option-alpha-d-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
          },
        },
      ],
    };

    const plan = perGroupPlan({
      target: cappedTarget,
      chat: fakeGroupChat({}).chat,
      model: "m",
      maxSerializedCharsPerGroup: 900,
    });
    const targets = plan.targets as Readonly<Record<string, unknown>>;
    const hvacTargets = targets.hvac as ExtractionTarget<Pick<CappedValues, "hvac">>;
    // The group fits the cap — one piece, its example carries the group.
    expect(hvacTargets.name).toBe("demo-mixed-cap-hvac");

    const looseTargets = targets[""] as readonly ExtractionTarget<CappedFields>[];
    // Precondition: the cap really did partition the loose portion.
    expect(looseTargets.length).toBeGreaterThan(1);
    expect(looseTargets.map((t) => t.name)).toEqual(
      looseTargets.map((_, i) => `demo-mixed-cap-${i}`),
    );
    for (const piece of looseTargets) {
      const assistantFields = piece.examples?.[0]?.fields as Record<string, unknown> | undefined;
      // Each piece's example carries exactly its own leaf subset — never the
      // full example, which the response_format's strict mode would reject.
      const expected = Object.keys((piece.extractionSchema as unknown as z.ZodObject).shape).sort();
      expect(Object.keys(assistantFields ?? {}).sort()).toEqual(expected);
    }
  });

  test("a loose response carrying a NAMED key is rejected at the piece's own parse — the preset never reaches the merge with it", async () => {
    // The preset half of the overwrite-hazard pin (ADR 0023; the hand-composed
    // half is in ribo-core's grouped-extractor suite): the split builds the
    // loose piece from exactly the keys no group claimed, so the piece's
    // z.strictObject refuses a named key at the ENTRY's first parse — before
    // groupedExtractor's merge (and its "" guard) ever sees the value.
    // maxRetries: 0 because a SchemaParseError stays transient to the
    // combinator and would otherwise be retried pointlessly here.
    const { chat, requests } = fakeGroupChat({
      "demo-mixed-hvac": JSON.stringify(mixedHvacResponse),
      // The loose piece's answer carrying the whole-schema shape — the
      // hazardous construction's signature.
      "demo-mixed": JSON.stringify({ ...mixedLooseResponse, hvac: mixedHvacResponse.hvac }),
    });
    const extractor = perGroupExtractor({ target: mixedTarget, chat, model: "m", maxRetries: 0 });

    const rejection = await extractor
      .extract({ text: "the transcript", annotations: {} })
      .catch((cause: unknown) => cause);

    expect(rejection).toBeInstanceOf(SchemaParseError);
    // The ENTRY's own parse, not the combinator's closing parse: the context
    // names the loose piece's own request ("demo-mixed", no group infix), and
    // nothing about the merge.
    expect((rejection as Error).message).toContain(
      'singleShotExtractor: model response for "demo-mixed"',
    );
    expect((rejection as Error).message).not.toContain("merged response");
    expect(requests.map((r) => r.response_format.json_schema.name)).toContain("demo-mixed");
  });
});

/**
 * @file The flat schema's byte-cap path goes end-to-end through
 * `perGroupExtractor` and `groupedExtractor` — pieces share `key === ""`,
 * their chat names carry the part suffix and no group-key infix, the merge
 * recombines them by per-leaf assignment, and the GroupUnit events
 * observability already pins reports `key: ""`, `part: i+1/N`.
 *
 * The merge's correctness rests on each piece's parsed response being a
 * disjoint subset of the schema's leaves (which `partitionFlatTwoCaps`
 * preserves by closing a piece the moment the next leaf would push it over
 * the cap). When that property holds, `Object.assign` in piece order is the
 * merge — later pieces never overwrite earlier ones because their leaves
 * differ.
 */
describe("perGroupExtractor — flat partitioning under the byte cap", () => {
  // A flat patch big enough that a tight byte cap partitions it. The enum
  // values are long strings so each leaf's serialized form inflates the
  // schema — the same structural pattern `split-schema-bytes.test.ts` uses
  // for the grouped-byte-cap suite.
  const bigFlatPatch = z
    .object({
      a: z.enum(["option-alpha-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]),
      b: z.enum(["option-bravo-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"]),
      c: z.enum(["option-charlie-cccccccccccccccccccccccccccccc"]),
      d: z.enum(["option-delta-dddddddddddddddddddddddddddddddddd"]),
      e: z.enum(["option-echo-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"]),
      f: z.enum(["option-foxtrot-ffffffffffffffffffffffffffffffffff"]),
      g: z.enum(["option-golf-gggggggggggggggggggggggggggggggggggg"]),
      h: z.enum(["option-hotel-hhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh"]),
    })
    .strict();
  const bigFlatExtraction = enveloped(bigFlatPatch);
  type BigFlatValues = z.infer<typeof bigFlatPatch>;
  const bigFlatTarget: ExtractionTarget<BigFlatValues> = {
    name: "demo-flat-cap",
    extractionSchema: bigFlatExtraction,
    instructions: "Extract the leaves.",
    examples: [],
  };
  const byteCap = 1_500;

  test("the per-group plan keys a partitioned flat schema's pieces on \"\" and stores them as an array; each piece's wire name carries the part suffix and no group-key infix", () => {
    const plan = perGroupPlan({
      target: bigFlatTarget,
      chat: fakeGroupChat({}).chat,
      model: "m",
      maxSerializedCharsPerGroup: byteCap,
    });
    const recordKeys = Object.keys(plan.groups);
    expect(recordKeys).toEqual([""]);

    const flatEntriesRecord = plan.groups as Readonly<
      Record<string, readonly { extract: unknown }[]>
    >;
    const flatEntries = flatEntriesRecord[""]!;
    expect(Array.isArray(flatEntries)).toBe(true);
    expect(flatEntries.length).toBeGreaterThan(1);
    const pieces = flatEntries;

    // The union's "" arm widens to ExtractionTarget<V, P> | readonly ExtractionTarget<V, P>[] —
    // runtime keying needs a single cast that names the recorded shape. The
    // previous readback cast through Record<string, unknown> lied about both keys
    // and values; this one names the field type each entry actually carries.
    const flatTargetsRecord = plan.targets as Readonly<
      Record<string, readonly ExtractionTarget<BigFlatValues>[]>
    >;
    const flatTargets = flatTargetsRecord[""]!;
    expect(flatTargets.length).toBe(pieces.length);
    // Wire names: `${target.name}-<part>`, with NO `-${key}` infix because flat
    // pieces have no group key. Each name is distinct so the request side can
    // tell pieces apart.
    expect(flatTargets.map((t) => t.name)).toEqual(
      flatTargets.map((_, i) => `${bigFlatTarget.name}-${i}`),
    );
    // Each piece's instructions are the target's — flat pieces keep the
    // whole-schema prompt, not a per-group projection. `groupInstructions`
    // does not apply to a flat piece (no group key to query for).
    expect(new Set(flatTargets.map((t) => t.instructions))).toEqual(
      new Set([bigFlatTarget.instructions]),
    );
    // Pieces' schemas carry disjoint leaf subsets; their union covers the
    // whole schema.
    const collected: string[] = [];
    for (const t of flatTargets) {
      const shape = (t.extractionSchema as unknown as z.ZodObject).shape as Record<string, unknown>;
      collected.push(...Object.keys(shape));
    }
    expect([...collected].sort()).toEqual([...Object.keys(bigFlatPatch.shape)].sort());
  });

  test("the partitioned flat pieces schedule N parallel calls and the merge assembles every leaf", async () => {
    // Dispatch a per-piece canned response: each fake's name corresponds to one
    // piece of the partitioned flat schema, and the response contains exactly
    // the leaves the piece's schema accepts. (A shared-name dispatch would
    // have every piece parse the same response — and any subset-wider response
    // would fail the strict-mode schema parse.)
    const piecesMeta = splitExtractionSchema(bigFlatExtraction, {
      maxSerializedCharsPerGroup: byteCap,
    });
    expect(piecesMeta.length).toBeGreaterThan(1);

    const responses: Record<string, string> = {};
    const expectedNames: string[] = [];
    // The fabric responds with the enum literal the schema was defined to
    // accept — schema parse fails otherwise (a strict-mode `anyOf` mismatch).
    const enumByKey: Record<string, string> = {
      a: "option-alpha-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      b: "option-bravo-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      c: "option-charlie-cccccccccccccccccccccccccccccc",
      d: "option-delta-dddddddddddddddddddddddddddddddddd",
      e: "option-echo-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      f: "option-foxtrot-ffffffffffffffffffffffffffffffffff",
      g: "option-golf-gggggggggggggggggggggggggggggggggggg",
      h: "option-hotel-hhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh",
    };
    for (let i = 0; i < piecesMeta.length; i++) {
      const piece = piecesMeta[i]!;
      const name = `${bigFlatTarget.name}-${i}`;
      expectedNames.push(name);
      const shape = (piece.schema as z.ZodObject).shape;
      const fields: Record<string, unknown> = {};
      for (const leafKey of Object.keys(shape)) {
        fields[leafKey] = {
          value: enumByKey[leafKey]!,
          confidence: 0.9,
          sourceSpan: leafKey,
        };
      }
      responses[name] = JSON.stringify(fields);
    }

    const { chat, requests } = fakeGroupChat(responses);
    const events: GroupUnit[] = [];
    const extractor = perGroupExtractor({
      target: bigFlatTarget,
      chat,
      model: "m",
      maxSerializedCharsPerGroup: byteCap,
      onUnit: (e) => events.push(e),
    });

    const result = await extractor.extract({ text: "the wall is R-13", annotations: {} });

    // N requests, one per piece (the per-name dispatch is what proves the
    // pieces' schemas parse their per-piece responses).
    const requestNames = requests.map((r) => r.response_format.json_schema.name).sort();
    expect(requestNames).toEqual([...expectedNames].sort());

    // Every GroupUnit event is keyed `""`, with `part: i+1` and the same
    // `parts: N` vocabulary the grouped-arm uses for partitioned groups.
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.key === "")).toBe(true);
    const partsSet = new Set(events.map((e) => e.part));
    expect(partsSet.size).toBe(piecesMeta.length);
    expect(events.every((e) => e.parts === piecesMeta.length)).toBe(true);

    // The merge result carries every leaf of the schema — the disjoint
    // subspaces the packer closed, Object.assign reassembled.
    expect(Object.keys(result.fields).sort()).toEqual([...Object.keys(bigFlatPatch.shape)].sort());
    const mergedFields = result.fields as unknown as Record<string, { value: unknown }>;
    for (const key of Object.keys(bigFlatPatch.shape)) {
      expect(mergedFields[key]!.value, `merged leaf ${key}`).toBe(enumByKey[key]);
    }
    expect(result.usage.calls).toBe(piecesMeta.length);
  });

  test("a partitioned flat piece's few-shot example carries only that piece's leaves — the narrowing the response_format strict-mode requires", async () => {
    // The argument transfers verbatim from partitioned grouped pieces: shows the
    // model an assistant turn wider than the piece's response_format accepts and
    // either it stops imitating (the assistant turn's wider shape is off-mode) or
    // it starts inventing absent leaves to fill the example, neither of which
    // anyone wanted. The shipped path runs against `examples: []`; the narrowing
    // matters when a host supplies examples.
    const targetWithExample: ExtractionTarget<BigFlatValues> = {
      ...bigFlatTarget,
      examples: [
        {
          transcript: "All eight fields were present.",
          fields: {
            a: {
              value: "option-alpha-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              confidence: 0.9,
              sourceSpan: "a",
            },
            b: {
              value: "option-bravo-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              confidence: 0.9,
              sourceSpan: "b",
            },
            c: {
              value: "option-charlie-cccccccccccccccccccccccccccccc",
              confidence: 0.9,
              sourceSpan: "c",
            },
            d: {
              value: "option-delta-dddddddddddddddddddddddddddddddddd",
              confidence: 0.9,
              sourceSpan: "d",
            },
            e: {
              value: "option-echo-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
              confidence: 0.9,
              sourceSpan: "e",
            },
            f: {
              value: "option-foxtrot-ffffffffffffffffffffffffffffffffff",
              confidence: 0.9,
              sourceSpan: "f",
            },
            g: {
              value: "option-golf-gggggggggggggggggggggggggggggggggggg",
              confidence: 0.9,
              sourceSpan: "g",
            },
            h: {
              value: "option-hotel-hhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh",
              confidence: 0.9,
              sourceSpan: "h",
            },
          },
        },
      ],
    };
    const plan = perGroupPlan({
      target: targetWithExample,
      chat: fakeGroupChat({}).chat,
      model: "m",
      maxSerializedCharsPerGroup: byteCap,
    });
    const flatTargetsRecord = plan.targets as Readonly<
      Record<string, readonly ExtractionTarget<BigFlatValues>[]>
    >;
    const flatTargets = flatTargetsRecord[""]!;
    expect(flatTargets.length).toBeGreaterThan(1);
    for (const piece of flatTargets) {
      const assistantFields = piece.examples?.[0]?.fields as Record<string, unknown> | undefined;
      // Every piece carries exactly its subset of leaves — never the full
      // eight, which would show the model an assistant turn wider than its
      // response_format accepts.
      const present = Object.keys(assistantFields ?? {}).sort();
      const expected = Object.keys((piece.extractionSchema as unknown as z.ZodObject).shape).sort();
      expect(present, `piece name=${piece.name} expected=${JSON.stringify(expected)}`).toEqual(
        expected,
      );
    }
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

    const result = await extractor.extract({
      text: "Furnace is a Carrier. Attic has R-38.",
      annotations: {},
    });

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

    await expect(extractor.extract({ text: "t", annotations: {} })).rejects.toThrow(
      "persistent blip",
    );

    // hvac exhausted its budget: 3 calls (1 initial + 2 retries).
    expect(callCounts[groupedName("hvac")]).toBe(3);
  });

  test("a terminal failure is not retried — one call, then the throw, and never delays", async () => {
    // hvac returns a truncated response (finishReason: "length"). This is a
    // TerminalError — it must not be retried. One call to hvac, then the
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

    const error = await extractor.extract({ text: "t", annotations: {} }).then(
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

    await expect(extractor.extract({ text: "t", annotations: {} })).rejects.toThrow("blip");

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

    // Also verify for the production Snugg target (8 groups) — the tighter
    // bound that motivated the default.
    const snuggGroups = 8;
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
    await expect(tightExtractor.extract({ text: "t", annotations: {} })).rejects.toThrow("blip");
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

    await expect(extractor.extract({ text: "t", annotations: {} })).rejects.toThrow(
      "fail immediately",
    );

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

    const result = await extractor.extract({
      text: "The wall is R-13, four hundred square feet.",
      annotations: {},
    });

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

test("every per-group schema name is within the structured-output name charset", async () => {
  // Platform routes constrain `response_format.json_schema.name` to
  // [A-Za-z0-9_-]{1,64}. A name outside it is rejected with a generic validation
  // error that reads identically to an over-cap schema — an expensive thing to
  // diagnose, so pin the charset here rather than rediscover it against a route.
  const { chat, requests } = fakeGroupChat({
    [groupedName("hvac")]: JSON.stringify(hvacResponse),
    [groupedName("attic")]: JSON.stringify(atticResponse),
  });

  await perGroupExtractor({ target: groupedTarget, chat, model: "m" }).extract({
    text: "t",
    annotations: {},
  });

  expect(requests.length).toBeGreaterThan(1);
  for (const request of requests) {
    expect(request.response_format.json_schema.name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  }
});

// --- Leaf-count partitioning --------------------------------------------------

/**
 * Two must-fail tests demonstrating and then fixing the Anthropic-family
 * 16-nullable-union cap: `Enveloped<V>` emits two nullable unions per leaf, so a
 * group over 8 leaves overflows a single call on that model family. Real Snugg
 * groups this affects (`hvac` at 12, `health` at 14) live in `ribo-adapter-snuggpro`,
 * which this tool-agnostic package cannot reference — these fixtures are the
 * synthetic stand-ins: a 10-leaf singleton group (mirrors `health`) and a 9-leaf
 * collection group with two instances (mirrors `hvac`, R1.6-style).
 *
 * `perGroupExtractor` defaults the cap to `MAX_NULLABLE_UNIONS_PER_CALL` (16), so a
 * group over it is partitioned into multiple calls with no test setup beyond "make a
 * group with more than 8 enveloped leaves"; a caller-supplied
 * `maxNullableUnionsPerGroup` overrides the default, which the last two tests pin.
 * The cap is counted in unions, not leaves, so the two tests below spend it at two
 * per enveloped leaf — the unit that also holds for a `"row"` group's plain leaves.
 */
describe("perGroupExtractor — leaf-count partitioning (over the 8-enveloped-leaf cap)", () => {
  /** A 10-leaf singleton group — mirrors `health`'s shape, over the 8-leaf cap. */
  const bigPatch = z
    .object({
      big: z
        .object({
          f1: z.string().nullable().optional(),
          f2: z.string().nullable().optional(),
          f3: z.string().nullable().optional(),
          f4: z.string().nullable().optional(),
          f5: z.string().nullable().optional(),
          f6: z.string().nullable().optional(),
          f7: z.string().nullable().optional(),
          f8: z.string().nullable().optional(),
          f9: z.string().nullable().optional(),
          f10: z.string().nullable().optional(),
        })
        .strict()
        .optional(),
    })
    .strict();
  const bigExtraction = enveloped(bigPatch);
  type BigValues = z.infer<typeof bigPatch>;
  type BigExtraction = Enveloped<BigValues>;

  const envelope = (
    value: string,
    span: string,
  ): { value: string; confidence: number; sourceSpan: string } => ({
    value,
    confidence: 0.9,
    sourceSpan: span,
  });

  const bigTarget: ExtractionTarget<BigValues> = {
    name: "demo-big",
    extractionSchema: bigExtraction,
    instructions: "Extract the big group's ten fields.",
    examples: [],
  };

  test("a singleton group over the leaf cap is split into two calls (5+5) and recombined into one 10-field object", async () => {
    // 10 leaves at a cap of 8 -> ceil(10/8) = 2 pieces, evenly sized: 5 + 5.
    const piece0Response = {
      big: {
        f1: envelope("a1", "s1"),
        f2: envelope("a2", "s2"),
        f3: envelope("a3", "s3"),
        f4: envelope("a4", "s4"),
        f5: envelope("a5", "s5"),
      },
    };
    const piece1Response = {
      big: {
        f6: envelope("a6", "s6"),
        f7: envelope("a7", "s7"),
        f8: envelope("a8", "s8"),
        f9: envelope("a9", "s9"),
        f10: envelope("a10", "s10"),
      },
    };
    const { chat, requests } = fakeGroupChat({
      "demo-big-big-0": JSON.stringify(piece0Response),
      "demo-big-big-1": JSON.stringify(piece1Response),
    });

    const result = await perGroupExtractor({ target: bigTarget, chat, model: "m" }).extract({
      text: "t",
      annotations: {},
    });

    // Exactly two calls for the one group — not one (over cap) and not more than
    // the two pieces the split produces.
    expect(requests).toHaveLength(2);
    expect(result.usage.calls).toBe(2);

    // Each call's response_format schema carries only its own 5 leaves, not all 10
    // — the whole point of the partition.
    for (const request of requests) {
      const schema = request.response_format.json_schema.schema as {
        properties: { big: { properties: Record<string, unknown> } };
      };
      expect(Object.keys(schema.properties.big.properties)).toHaveLength(5);
    }

    // Recombined into one coherent 10-field document.
    const fields = result.fields;
    for (let i = 1; i <= 10; i++) {
      const key = `f${i}` as keyof BigExtraction["big"];
      expect(fields.big[key].value, `big.f${i}`).toBe(`a${i}`);
    }
  });

  /**
   * A 9-leaf-per-instance collection group — mirrors `hvac`'s array shape
   * (R1.6 instance modeling). Splitting stays WITHIN one instance's leaf set:
   * every piece still carries the full array, just with a narrower per-instance
   * shape, and the same array index across both calls is the same instance.
   */
  const itemsPatch = z
    .object({
      items: z
        .array(
          z
            .object({
              f1: z.string().nullable().optional(),
              f2: z.string().nullable().optional(),
              f3: z.string().nullable().optional(),
              f4: z.string().nullable().optional(),
              f5: z.string().nullable().optional(),
              f6: z.string().nullable().optional(),
              f7: z.string().nullable().optional(),
              f8: z.string().nullable().optional(),
              f9: z.string().nullable().optional(),
            })
            .strict(),
        )
        .optional(),
    })
    .strict();
  const itemsExtraction = enveloped(itemsPatch);
  type ItemsValues = z.infer<typeof itemsPatch>;
  type ItemsExtraction = Enveloped<ItemsValues>;

  const itemsTarget: ExtractionTarget<ItemsValues> = {
    name: "demo-items",
    extractionSchema: itemsExtraction,
    instructions: "Extract every item's nine fields.",
    examples: [],
  };

  test("a collection group over the per-instance leaf cap is split within each instance (5+4), not across instances, and recombined element-wise", async () => {
    // 9 leaves at a cap of 8 -> ceil(9/8) = 2 pieces, evenly sized: 5 + 4. Two
    // instances (roster order preserved), each piece emitting the FULL array with
    // only its own leaf subset per element.
    const piece0Response = {
      items: [
        {
          f1: envelope("i0-a1", "s"),
          f2: envelope("i0-a2", "s"),
          f3: envelope("i0-a3", "s"),
          f4: envelope("i0-a4", "s"),
          f5: envelope("i0-a5", "s"),
        },
        {
          f1: envelope("i1-a1", "s"),
          f2: envelope("i1-a2", "s"),
          f3: envelope("i1-a3", "s"),
          f4: envelope("i1-a4", "s"),
          f5: envelope("i1-a5", "s"),
        },
      ],
    };
    const piece1Response = {
      items: [
        {
          f6: envelope("i0-a6", "s"),
          f7: envelope("i0-a7", "s"),
          f8: envelope("i0-a8", "s"),
          f9: envelope("i0-a9", "s"),
        },
        {
          f6: envelope("i1-a6", "s"),
          f7: envelope("i1-a7", "s"),
          f8: envelope("i1-a8", "s"),
          f9: envelope("i1-a9", "s"),
        },
      ],
    };
    const { chat, requests } = fakeGroupChat({
      "demo-items-items-0": JSON.stringify(piece0Response),
      "demo-items-items-1": JSON.stringify(piece1Response),
    });

    const result = await perGroupExtractor({ target: itemsTarget, chat, model: "m" }).extract({
      text: "t",
      annotations: {},
    });

    expect(requests).toHaveLength(2);
    expect(result.usage.calls).toBe(2);

    // Each call's schema still carries the array wrapper — the split narrows the
    // per-instance leaf set, never the array itself.
    for (const request of requests) {
      const schema = request.response_format.json_schema.schema as {
        properties: { items: { type: string; items: { properties: Record<string, unknown> } } };
      };
      expect(schema.properties.items.type).toBe("array");
      expect(Object.keys(schema.properties.items.items.properties).length).toBeLessThanOrEqual(5);
    }

    // Recombined element-wise: two full 9-field instances, in roster order, each
    // built from the SAME array index across both calls.
    const fields = result.fields;
    expect(fields.items).toHaveLength(2);
    for (let instance = 0; instance < 2; instance++) {
      for (let leaf = 1; leaf <= 9; leaf++) {
        const key = `f${leaf}` as keyof ItemsExtraction["items"][number];
        expect(fields.items[instance]![key].value, `items[${instance}].f${leaf}`).toBe(
          `i${instance}-a${leaf}`,
        );
      }
    }
  });

  test("with groupInstructions, a partitioned piece's few-shot example is narrowed to only that piece's leaves", async () => {
    const groupInstructions = (): string => "Extract only this piece's leaves.";
    const bigExample: ToolAdapterExample<BigExtraction> = {
      transcript: "All ten fields were mentioned.",
      fields: {
        big: {
          f1: envelope("a1", "s1"),
          f2: envelope("a2", "s2"),
          f3: envelope("a3", "s3"),
          f4: envelope("a4", "s4"),
          f5: envelope("a5", "s5"),
          f6: envelope("a6", "s6"),
          f7: envelope("a7", "s7"),
          f8: envelope("a8", "s8"),
          f9: envelope("a9", "s9"),
          f10: envelope("a10", "s10"),
        },
      },
    };
    const bigTargetWithExample: ExtractionTarget<BigValues> = {
      ...bigTarget,
      examples: [bigExample],
    };
    const piece0Response = {
      big: {
        f1: envelope("a1", "s1"),
        f2: envelope("a2", "s2"),
        f3: envelope("a3", "s3"),
        f4: envelope("a4", "s4"),
        f5: envelope("a5", "s5"),
      },
    };
    const piece1Response = {
      big: {
        f6: envelope("a6", "s6"),
        f7: envelope("a7", "s7"),
        f8: envelope("a8", "s8"),
        f9: envelope("a9", "s9"),
        f10: envelope("a10", "s10"),
      },
    };
    const { chat, requests } = fakeGroupChat({
      "demo-big-big-0": JSON.stringify(piece0Response),
      "demo-big-big-1": JSON.stringify(piece1Response),
    });

    await perGroupExtractor({
      target: bigTargetWithExample,
      chat,
      model: "m",
      groupInstructions,
    }).extract({ text: "t", annotations: {} });

    expect(requests).toHaveLength(2);
    for (const request of requests) {
      const assistantTurn = request.messages[2]!;
      expect(assistantTurn.role).toBe("assistant");
      const exampleFields = JSON.parse(assistantTurn.content) as { big: Record<string, unknown> };
      const name = request.response_format.json_schema.name;
      const expectedKeys = name.endsWith("-0")
        ? ["f1", "f2", "f3", "f4", "f5"]
        : ["f6", "f7", "f8", "f9", "f10"];
      // The example carries EXACTLY this piece's leaves — not all ten, which
      // would show the model an assistant turn its own response_format (pinned
      // to 5 leaves) could never actually produce.
      expect(Object.keys(exampleFields.big).sort()).toEqual([...expectedKeys].sort());
    }
  });

  test("a group that partitions at the default cap stays whole at a higher caller-supplied cap", async () => {
    // `big` costs 20 nullable unions (10 enveloped leaves at two each), over the
    // default 16 but under the supplied 32, so the whole group goes out in a
    // single call named without a part suffix.
    const wholeResponse = {
      big: Object.fromEntries(
        Array.from({ length: 10 }, (_, i) => [`f${i + 1}`, envelope(`a${i + 1}`, `s${i + 1}`)]),
      ),
    };
    const { chat, requests } = fakeGroupChat({
      "demo-big-big": JSON.stringify(wholeResponse),
    });

    const result = await perGroupExtractor({
      target: bigTarget,
      chat,
      model: "m",
      maxNullableUnionsPerGroup: 32,
    }).extract({ text: "t", annotations: {} });

    expect(requests).toHaveLength(1);
    expect(result.usage.calls).toBe(1);
    expect(requests[0]!.response_format.json_schema.name).toBe("demo-big-big");
    const schema = requests[0]!.response_format.json_schema.schema as {
      properties: { big: { properties: Record<string, unknown> } };
    };
    expect(Object.keys(schema.properties.big.properties)).toHaveLength(10);

    const fields = result.fields;
    for (let i = 1; i <= 10; i++) {
      const key = `f${i}` as keyof BigExtraction["big"];
      expect(fields.big[key].value, `big.f${i}`).toBe(`a${i}`);
    }
  });

  test("a group whole at the default cap is partitioned by a lower caller-supplied cap", async () => {
    // `hvac` is under the default cap, but one enveloped leaf costs two unions,
    // so a supplied cap of 2 splits it into one call per leaf and recombines;
    // `attic` partitions too.
    const { chat, requests } = fakeGroupChat({
      "demo-grouped-hvac-0": JSON.stringify({
        hvac: { equipmentType: { value: "Boiler", confidence: 0.9, sourceSpan: "boiler" } },
      }),
      "demo-grouped-hvac-1": JSON.stringify({
        hvac: { fuel: { value: "Natural Gas", confidence: 0.8, sourceSpan: "gas" } },
      }),
      "demo-grouped-attic-0": JSON.stringify({
        attic: {
          insulationDepth: { value: "10-12", confidence: 0.9, sourceSpan: "ten inches" },
        },
      }),
      "demo-grouped-attic-1": JSON.stringify({
        attic: { insulationRValue: { value: 30, confidence: 0.7, sourceSpan: "R-30" } },
      }),
    });

    const result = await perGroupExtractor({
      target: groupedTarget,
      chat,
      model: "m",
      maxNullableUnionsPerGroup: 2,
    }).extract({ text: "t", annotations: {} });

    expect(requests).toHaveLength(4);
    for (const request of requests) {
      expect(request.response_format.json_schema.name).toMatch(/-([01])$/);
    }

    // Both groups recombined from their single-leaf pieces.
    expect(result.fields.hvac.equipmentType.value).toBe("Boiler");
    expect(result.fields.hvac.fuel.value).toBe("Natural Gas");
    expect(result.fields.attic.insulationDepth.value).toBe("10-12");
    expect(result.fields.attic.insulationRValue.value).toBe(30);
  });
});

// --- Extraction observability: per-group progress units (Task 3) ---------------------------

/**
 * Nine must-fail tests for Task 3 — `perGroupExtractor` emits `GroupUnit` progress
 * events and surfaces its derived retry budget. The emission sits inside the retry
 * loop, around the chat call: one `id` per prepared entry, `attempt` distinguishing
 * retries, and three previously-invisible failure paths (terminal, abort, exhausted
 * budget) each now emit an `error` event.
 */
describe("perGroupExtractor — progress units (extraction observability)", () => {
  test("a two-group target emits, per group, a start then a done, with part: 1, parts: 1 on both and distinct keys", async () => {
    const events: GroupUnit[] = [];
    const { chat } = fakeGroupChat({
      [groupedName("hvac")]: JSON.stringify(hvacResponse),
      [groupedName("attic")]: JSON.stringify(atticResponse),
    });
    const extractor = perGroupExtractor({
      target: groupedTarget,
      chat,
      model: "m",
      onUnit: (e) => events.push(e),
    });

    await extractor.extract({ text: "t", annotations: {} });

    // Each group: one start, one done.
    const hvacEvents = events.filter((e) => e.key === "hvac");
    const atticEvents = events.filter((e) => e.key === "attic");
    expect(hvacEvents).toHaveLength(2);
    expect(atticEvents).toHaveLength(2);
    expect(hvacEvents[0]!.phase).toBe("start");
    expect(hvacEvents[1]!.phase).toBe("done");
    expect(atticEvents[0]!.phase).toBe("start");
    expect(atticEvents[1]!.phase).toBe("done");

    // Unpartitioned groups report part: 1, parts: 1 — one code path for the consumer.
    for (const e of events) {
      expect(e.part).toBe(1);
      expect(e.parts).toBe(1);
      expect(e.attempt).toBe(1);
    }

    // The two groups' keys are distinct.
    expect(hvacEvents[0]!.key).toBe("hvac");
    expect(atticEvents[0]!.key).toBe("attic");
  });

  test("a group that fails transiently once then succeeds emits start(1), error(1), start(2), done(2) — the same id on all four", async () => {
    const events: GroupUnit[] = [];
    const { chat } = fakeRetryChat({
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
      onUnit: (e) => events.push(e),
    });

    await extractor.extract({ text: "t", annotations: {} });

    const hvacEvents = events.filter((e) => e.key === "hvac");
    expect(hvacEvents).toHaveLength(4);
    expect(hvacEvents[0]!.phase).toBe("start");
    expect(hvacEvents[0]!.attempt).toBe(1);
    expect(hvacEvents[1]!.phase).toBe("error");
    expect(hvacEvents[1]!.attempt).toBe(1);
    expect(hvacEvents[2]!.phase).toBe("start");
    expect(hvacEvents[2]!.attempt).toBe(2);
    expect(hvacEvents[3]!.phase).toBe("done");
    expect(hvacEvents[3]!.attempt).toBe(2);

    // The same id across every attempt of one entry — attempt is the only way a
    // retry is observable at all.
    const id = hvacEvents[0]!.id;
    expect(hvacEvents.every((e) => e.id === id)).toBe(true);
  });

  test("a partitioned group emits units carrying part: 1, parts: 2 and part: 2, parts: 2", async () => {
    const events: GroupUnit[] = [];
    const { chat } = fakeGroupChat({
      "demo-grouped-hvac-0": JSON.stringify({
        hvac: { equipmentType: { value: "Boiler", confidence: 0.9, sourceSpan: "boiler" } },
      }),
      "demo-grouped-hvac-1": JSON.stringify({
        hvac: { fuel: { value: "Natural Gas", confidence: 0.8, sourceSpan: "gas" } },
      }),
      "demo-grouped-attic-0": JSON.stringify({
        attic: {
          insulationDepth: { value: "10-12", confidence: 0.9, sourceSpan: "ten inches" },
        },
      }),
      "demo-grouped-attic-1": JSON.stringify({
        attic: { insulationRValue: { value: 30, confidence: 0.7, sourceSpan: "R-30" } },
      }),
    });
    const extractor = perGroupExtractor({
      target: groupedTarget,
      chat,
      model: "m",
      maxNullableUnionsPerGroup: 2,
      onUnit: (e) => events.push(e),
    });

    await extractor.extract({ text: "t", annotations: {} });

    // Each group is partitioned into 2 pieces, each emitting start + done.
    const hvacEvents = events.filter((e) => e.key === "hvac");
    const atticEvents = events.filter((e) => e.key === "attic");
    expect(hvacEvents).toHaveLength(4);
    expect(atticEvents).toHaveLength(4);

    for (const e of hvacEvents) expect(e.parts).toBe(2);
    for (const e of atticEvents) expect(e.parts).toBe(2);

    const hvacParts = new Set(hvacEvents.map((e) => e.part));
    expect(hvacParts.has(1)).toBe(true);
    expect(hvacParts.has(2)).toBe(true);
    const atticParts = new Set(atticEvents.map((e) => e.part));
    expect(atticParts.has(1)).toBe(true);
    expect(atticParts.has(2)).toBe(true);
  });

  test("a terminal failure emits exactly one error event and no retry start", async () => {
    const events: GroupUnit[] = [];
    const { chat } = fakeRetryChat({
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
      delay: noDelay,
      onUnit: (e) => events.push(e),
    });

    await extractor.extract({ text: "t", annotations: {} }).catch(() => {});

    const hvacEvents = events.filter((e) => e.key === "hvac");
    // Terminal: one start, one error, no retry start.
    expect(hvacEvents).toHaveLength(2);
    expect(hvacEvents[0]!.phase).toBe("start");
    expect(hvacEvents[0]!.attempt).toBe(1);
    expect(hvacEvents[1]!.phase).toBe("error");
    expect(hvacEvents[1]!.attempt).toBe(1);
  });

  test("done carries usage.inputTokens/outputTokens from the completion, and omits usage when the fake reports none", async () => {
    // With usage.
    const eventsWithUsage: GroupUnit[] = [];
    const chatWithUsage: ChatClient = {
      complete: (request) => {
        const name = request.response_format.json_schema.name;
        return Promise.resolve({
          content: name.endsWith("-hvac")
            ? JSON.stringify(hvacResponse)
            : JSON.stringify(atticResponse),
          finishReason: "stop",
          usage: { promptTokens: 100, completionTokens: 20 },
        });
      },
    };
    await perGroupExtractor({
      target: groupedTarget,
      chat: chatWithUsage,
      model: "m",
      onUnit: (e) => eventsWithUsage.push(e),
    }).extract({ text: "t", annotations: {} });

    const doneWith = eventsWithUsage.filter((e) => e.phase === "done");
    expect(doneWith).toHaveLength(2);
    for (const e of doneWith) {
      expect(e.usage).toBeDefined();
      expect(e.usage!.inputTokens).toBe(100);
      expect(e.usage!.outputTokens).toBe(20);
    }

    // Without usage.
    const eventsNoUsage: GroupUnit[] = [];
    const { chat: chatNoUsage } = fakeGroupChat({
      [groupedName("hvac")]: JSON.stringify(hvacResponse),
      [groupedName("attic")]: JSON.stringify(atticResponse),
    });
    await perGroupExtractor({
      target: groupedTarget,
      chat: chatNoUsage,
      model: "m",
      onUnit: (e) => eventsNoUsage.push(e),
    }).extract({ text: "t", annotations: {} });

    const doneWithout = eventsNoUsage.filter((e) => e.phase === "done");
    expect(doneWithout).toHaveLength(2);
    for (const e of doneWithout) {
      // The KEY must be absent, not present-and-undefined. `toBeUndefined()`
      // alone passes for both, and the difference is load-bearing here: this
      // repo already treats absent-vs-zero as meaningful for
      // `ExtractionUsage.cachedPromptTokens` ("we cannot tell" vs "the cache is
      // not working"), and `usage: undefined` answers `"usage" in event` true.
      expect(e).not.toHaveProperty("usage");
    }
  });

  test("every settle event names an attempt that actually started — no phantom retry", async () => {
    // The abort path is the one that can invent an attempt: its check runs at the
    // TOP of the retry loop, before that iteration's `start` fires, so reporting
    // `attempt + 1` there would announce a retry that never happened. `attempt`
    // is the only way a retry is observable at all, so inflating it turns a
    // progress panel into a liar.
    //
    // Asserted as the general invariant rather than by pinning one abort's exact
    // number: every `done`/`error` must correspond to a `start` with the same id
    // AND the same attempt. That holds for every path, and is what actually
    // breaks if the abort branch regresses.
    // The timing is deliberate, not incidental. `fakeRetryChat` settles both
    // groups in adjacent microtasks, which makes the sibling abort BEFORE the
    // retrying group's catch runs — so it throws from the catch and the
    // top-of-loop branch is never reached, and the test passes against a broken
    // implementation. (Confirmed by reverting the fix: it stayed green.) A
    // bespoke chat with real timers is what forces the branch:
    //
    //   t=0   hvac fails transiently -> not yet aborted -> enters its 40ms backoff
    //   t=20  attic returns finishReason "length" -> TerminalError -> abort()
    //   t=40  hvac wakes, reaches the TOP of its next iteration, sees aborted
    //
    // That last step is the branch under test.
    const events: GroupUnit[] = [];
    const chat: ChatClient = {
      complete: async (request) => {
        if (request.response_format.json_schema.name === groupedName("hvac")) {
          throw new Error("transient");
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { content: JSON.stringify(atticResponse), finishReason: "length" };
      },
    };
    const extractor = perGroupExtractor({
      target: groupedTarget,
      chat,
      model: "m",
      maxRetries: 3,
      concurrency: 2,
      delay: () => new Promise((resolve) => setTimeout(resolve, 40)),
      onUnit: (e) => events.push(e),
    });

    await expect(extractor.extract({ text: "t", annotations: {} })).rejects.toThrow();
    const atSettlement = events.length;

    // `Promise.all` rejects the moment the terminal sibling throws (~20ms),
    // while the retrying group is still asleep in its 40ms backoff. So the
    // abort branch runs AFTER extract() has already rejected. Waiting past it
    // is what makes this test see the branch at all — asserting immediately
    // after the rejection passes against a broken implementation, because the
    // event has not been emitted yet.
    await new Promise((resolve) => setTimeout(resolve, 120));

    // Nothing may arrive after the extraction has settled. A progress panel
    // that gets a unit event for a run it already saw fail is being told the
    // work is still going.
    expect(events.length).toBe(atSettlement);

    // Guard the guard: without the abort, a permanently-transient group under
    // `maxRetries: 3` would emit four starts. Exactly one proves the abort
    // branch short-circuited the loop, so the invariants below are not passing
    // vacuously.
    const hvac = events.filter((e) => e.key === "hvac");
    expect(hvac.filter((e) => e.phase === "start")).toHaveLength(1);
    expect(hvac.filter((e) => e.phase === "error")).toHaveLength(1);

    // Invariant 1: every settle names an attempt that actually started.
    const started = events.filter((e) => e.phase === "start").map((e) => `${e.id}#${e.attempt}`);
    const settled = events.filter((e) => e.phase !== "start");
    expect(settled.length).toBeGreaterThan(0);
    for (const e of settled) {
      expect(started).toContain(`${e.id}#${e.attempt}`);
    }

    // Invariant 2: no attempt settles twice — the abort must not re-report an
    // attempt the catch already reported.
    const settledKeys = settled.map((e) => `${e.id}#${e.attempt}`);
    expect(new Set(settledKeys).size).toBe(settledKeys.length);
  });

  test("a target whose schema is not an object of groups emits one unit with key: ''", async () => {
    const events: GroupUnit[] = [];
    const { chat } = fakeGroupChat({
      [flatTarget.name]: JSON.stringify(flatResponse),
    });
    const extractor = perGroupExtractor({
      target: flatTarget,
      chat,
      model: "m",
      onUnit: (e) => events.push(e),
    });

    await extractor.extract({ text: "t", annotations: {} });

    expect(events).toHaveLength(2);
    expect(events.every((e) => e.key === "")).toBe(true);
    expect(events[0]!.phase).toBe("start");
    expect(events[1]!.phase).toBe("done");
    expect(events[0]!.part).toBe(1);
    expect(events[0]!.parts).toBe(1);
  });

  test("with onUnit absent, an identical run produces an identical ExtractionResult and an identical chat-call sequence", async () => {
    const { chat: chat1, requests: requests1 } = fakeGroupChat({
      [groupedName("hvac")]: JSON.stringify(hvacResponse),
      [groupedName("attic")]: JSON.stringify(atticResponse),
    });
    const { chat: chat2, requests: requests2 } = fakeGroupChat({
      [groupedName("hvac")]: JSON.stringify(hvacResponse),
      [groupedName("attic")]: JSON.stringify(atticResponse),
    });

    const result1 = await perGroupExtractor({
      target: groupedTarget,
      chat: chat1,
      model: "m",
    }).extract({ text: "t", annotations: {} });
    const result2 = await perGroupExtractor({
      target: groupedTarget,
      chat: chat2,
      model: "m",
    }).extract({ text: "t", annotations: {} });

    expect(result1).toEqual(result2);
    expect(requests1).toEqual(requests2);
  });
});

describe("perGroupExtractor — retry budget (extraction observability)", () => {
  test("onRetryBudget fires with { requested: 5, derived: 0, ... } for a step timeout that admits no retries, and does not fire when the requested budget survives intact", async () => {
    // Step timeout too tight for even one attempt at the default ceiling:
    // 1 * 120_000 = 120_000 > 100_000, so derived = 0.
    const budgetEvents: RetryBudget[] = [];
    const { chat } = fakeGroupChat({
      [groupedName("hvac")]: JSON.stringify(hvacResponse),
      [groupedName("attic")]: JSON.stringify(atticResponse),
    });
    const extractor = perGroupExtractor({
      target: groupedTarget,
      chat,
      model: "m",
      maxRetries: 5,
      stepTimeoutMs: 100_000,
      onRetryBudget: (e) => budgetEvents.push(e),
    });
    await extractor.extract({ text: "t", annotations: {} });

    expect(budgetEvents).toHaveLength(1);
    expect(budgetEvents[0]!.requested).toBe(5);
    expect(budgetEvents[0]!.derived).toBe(0);

    // When the requested budget survives intact, onRetryBudget does not fire.
    const budgetEventsIntact: RetryBudget[] = [];
    const { chat: chatIntact } = fakeGroupChat({
      [groupedName("hvac")]: JSON.stringify(hvacResponse),
      [groupedName("attic")]: JSON.stringify(atticResponse),
    });
    const extractorIntact = perGroupExtractor({
      target: groupedTarget,
      chat: chatIntact,
      model: "m",
      maxRetries: 2,
      stepTimeoutMs: 900_000,
      onRetryBudget: (e) => budgetEventsIntact.push(e),
    });
    await extractorIntact.extract({ text: "t", annotations: {} });
    expect(budgetEventsIntact).toHaveLength(0);
  });

  test("with requireRetryBudget: true and a step timeout that derives 0, construction throws naming all three knobs; with it absent, construction succeeds", () => {
    const { chat } = fakeGroupChat({
      [groupedName("hvac")]: JSON.stringify(hvacResponse),
      [groupedName("attic")]: JSON.stringify(atticResponse),
    });

    // With requireRetryBudget: true and derived 0, construction throws a plain
    // Error naming stepTimeoutMs, perCallCeilingMs and concurrency.
    expect(() =>
      perGroupExtractor({
        target: groupedTarget,
        chat,
        model: "m",
        maxRetries: 5,
        stepTimeoutMs: 100_000,
        requireRetryBudget: true,
      }),
    ).toThrow(/stepTimeoutMs/);
    expect(() =>
      perGroupExtractor({
        target: groupedTarget,
        chat,
        model: "m",
        maxRetries: 5,
        stepTimeoutMs: 100_000,
        requireRetryBudget: true,
      }),
    ).toThrow(/perCallCeilingMs/);
    expect(() =>
      perGroupExtractor({
        target: groupedTarget,
        chat,
        model: "m",
        maxRetries: 5,
        stepTimeoutMs: 100_000,
        requireRetryBudget: true,
      }),
    ).toThrow(/concurrency/);

    // The default must stay non-throwing: the same config without
    // requireRetryBudget succeeds — the default-unchanged proof for §0.5.
    expect(() =>
      perGroupExtractor({
        target: groupedTarget,
        chat,
        model: "m",
        maxRetries: 5,
        stepTimeoutMs: 100_000,
      }),
    ).not.toThrow();
  });
});

// --- The caller's options reach the entries -----------------------------------

describe("perGroupExtractor — the caller's options reach the entries", () => {
  test("the caller's deadline reaches the group entry's forward", async () => {
    // Regression pin for the forward at per-group.ts: the default entry runs
    // singleShotExtractor on the caller's options bag WHOLE, so the deadline —
    // the signal's sibling member with the same forwarding discipline — rides
    // through to the chat call untouched. The chat records the bag it was
    // handed; ChatCallOptions only declares `signal`, so the assertion reads
    // the recorded object as the ExtractOptions it actually is.
    const recorded: unknown[] = [];
    const chat: ChatClient = {
      complete: async (_request, options) => {
        recorded.push(options);
        return { content: JSON.stringify(flatResponse), finishReason: "stop" };
      },
    };
    const extractor = perGroupExtractor({ target: flatTarget, chat, model: "m" });
    const deadline = 1_234_567_890;

    await extractor.extract({ text: "t", annotations: {} }, { deadline });

    expect((recorded[0] as ExtractOptions | undefined)?.deadline).toBe(deadline);
  });
});
