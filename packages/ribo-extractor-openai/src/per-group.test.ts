import { enveloped, isTransientFailure } from "@azx/ribo-core";
import type { Enveloped, ExtractionTarget, ToolAdapterExample } from "@azx/ribo-core";
import { z } from "zod";
import { describe, expect, test } from "vitest";

import type { ChatClient, ChatFinishReason, ChatRequest } from "./chat-client.js";
import { perGroupExtractor } from "./per-group.js";
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
 * `${target.name}:${group.key}` for grouped schemas, or just `target.name` for
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

/** Schema name for a grouped call — `${target.name}:${group.key}`. */
const groupedName = (key: string): string => `${groupedTarget.name}:${key}`;

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
    const extractor = perGroupExtractor({ target: groupedTarget, chat, model: "m" });

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
    const extractor = perGroupExtractor({ target: groupedTarget, chat, model: "m" });

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
    const extractor = perGroupExtractor({ target: flatTarget, chat, model: "m" });

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
