import { enveloped, FakeExtractor, isTransientFailure, SchemaParseError } from "@azx/ribo-core";
import type { Enveloped, ExtractionTarget } from "@azx/ribo-core";
import { z } from "zod";
import { describe, expect, test } from "vitest";

import type { ChatClient, ChatFinishReason, ChatRequest, ChatUsage } from "./chat-client.js";
import {
  findAbstainedLeaves,
  formatLeafPath,
  gapFillExtractor,
  mergeGapFilledLeaves,
} from "./gap-fill.js";

/**
 * Key-free CI tests for the gap-fill combinator, against a small self-contained
 * target derived with `enveloped()` — the same fixture discipline as
 * `single-shot.test.ts`. The base extraction is a `FakeExtractor` returning a
 * fixed enveloped result, so each test controls exactly which leaves abstain
 * with evidence; a fake {@link ChatClient} captures the follow-up request and
 * replays a canned response. Nothing touches the network.
 *
 * The fixture's `hvac` group is an ARRAY of leaf-bearing instance objects, so
 * the walk is proved non-flat from the first test. The remaining runtime shape
 * — an array whose elements are leaves directly — is exercised in the pure-helper
 * block, through a cast, because `Enveloped<V>`'s type cannot express it (see
 * that test's comment).
 */

const gapValuesSchema = z
  .object({
    envelope: z
      .object({
        roof: z.enum(["asphalt_shingle", "metal", "tile"]).nullable().optional(),
        wall: z.string().nullable().optional(),
      })
      .strict()
      .optional(),
    hvac: z
      .array(
        z
          .object({
            systemType: z.enum(["furnace", "boiler", "heat_pump"]).nullable().optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
type GapValues = z.infer<typeof gapValuesSchema>;
type GapExtraction = Enveloped<GapValues>;

const gapTarget: ExtractionTarget<GapValues> = {
  name: "gap-demo",
  extractionSchema: enveloped(gapValuesSchema),
  instructions:
    "Extract the roof covering, the wall material, each HVAC system type, and any notes. Emit null for anything you cannot ground.",
};

/** Every leaf committed or plainly abstained — no candidates for the follow-up. */
const committedFields: GapExtraction = {
  envelope: {
    roof: { value: "asphalt_shingle", confidence: 0.9, sourceSpan: "asphalt shingles" },
    wall: { value: "brick", confidence: 0.9, sourceSpan: "brick walls" },
  },
  hvac: [
    {
      systemType: { value: "furnace", confidence: 0.95, sourceSpan: "gas furnace in the basement" },
    },
    // A plain abstention — null with NO quote — is an honest "not stated" and
    // must not be collected.
    { systemType: { value: null, confidence: 0.2, sourceSpan: null } },
  ],
};

/** The audited bug, in a nested object AND inside an array instance. */
const abstainingFields: GapExtraction = {
  envelope: {
    roof: { value: null, confidence: 0.4, sourceSpan: "asphalt shingles" },
    wall: { value: "brick", confidence: 0.9, sourceSpan: "brick walls" },
  },
  hvac: [
    {
      systemType: { value: "furnace", confidence: 0.95, sourceSpan: "gas furnace in the basement" },
    },
    { systemType: { value: null, confidence: 0.3, sourceSpan: "the second system" } },
  ],
};

/** A follow-up answer: commit the roof, reaffirm the second system. */
const followUpResponse = {
  "envelope.roof": { value: "asphalt_shingle", confidence: 0.93, sourceSpan: "asphalt shingles" },
  "hvac[1].systemType": { value: null, confidence: 0.6, sourceSpan: "the second system" },
};

/** A ChatClient that records every request and replays a fixed completion. */
function fakeChat(
  content: string,
  options: { finishReason?: ChatFinishReason; usage?: ChatUsage } = {},
): { chat: ChatClient; requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  const chat: ChatClient = {
    complete: (request) => {
      requests.push(request);
      return Promise.resolve({
        content,
        finishReason: options.finishReason,
        usage: options.usage,
      });
    },
  };
  return { chat, requests };
}

/** Rejects with the caught error, or throws if `promise` unexpectedly resolved. */
const catchRejection = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => {
      throw new Error("expected extract() to reject");
    },
    (caught: unknown) => caught,
  );

describe("gapFillExtractor — passthrough (no candidates)", () => {
  test("returns the base result untouched and makes no follow-up call", async () => {
    const base = new FakeExtractor<GapExtraction>(committedFields, {
      usage: { calls: 1, promptTokens: 100, completionTokens: 50 },
    });
    const { chat, requests } = fakeChat(JSON.stringify(followUpResponse));
    const extractor = gapFillExtractor({
      base,
      target: gapTarget,
      chat,
      model: "gpt-test",
      // Passed to prove it is NOT run on the passthrough path — the result keeps
      // the base's own field object, not a normalize-rebuilt one.
      normalize: (fields) => ({ ...fields }),
    });

    const transcript = "The roof is asphalt shingles; the walls are brick.";
    const result = await extractor.extract(transcript);

    expect(result.fields).toBe(committedFields);
    expect(result.usage).toEqual({ calls: 1, promptTokens: 100, completionTokens: 50 });
    expect(requests).toHaveLength(0);
    // The base extractor still ran, on the transcript.
    expect(base.calls).toEqual([transcript]);
  });
});

describe("gapFillExtractor — the follow-up call", () => {
  test("makes exactly one call, scoped to exactly the candidate leaves, transcript last", async () => {
    const base = new FakeExtractor<GapExtraction>(abstainingFields, { usage: { calls: 1 } });
    const { chat, requests } = fakeChat(JSON.stringify(followUpResponse));
    const extractor = gapFillExtractor({
      base,
      target: gapTarget,
      chat,
      model: "gpt-test",
      maxTokens: 2048,
    });

    const transcript = "Asphalt shingles. Gas furnace in the basement. The second system hums.";
    await extractor.extract(transcript);

    expect(requests).toHaveLength(1);
    const req = requests[0]!;
    expect(req.model).toBe("gpt-test");
    expect(req.maxTokens).toBe(2048);
    expect(req.response_format.type).toBe("json_schema");
    expect(req.response_format.json_schema.strict).toBe(true);
    expect(req.response_format.json_schema.name).toBe("gap-demo-gap-fill");

    // Scoped: the schema carries exactly the abstained leaves, keyed by path —
    // the committed wall and hvac[0] are not re-asked.
    const schema = req.response_format.json_schema.schema as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(schema.properties)).toEqual(["envelope.roof", "hvac[1].systemType"]);
    // The scope keeps each leaf's own constraints — the roof enum rides along.
    expect(JSON.stringify(schema.properties["envelope.roof"])).toContain("asphalt_shingle");

    // The transcript is the final user message (the injection boundary); the
    // candidates turn hands each leaf's own quote back.
    expect(req.messages.at(-1)).toEqual({ role: "user", content: transcript });
    const candidateMessage = req.messages[1]!;
    expect(candidateMessage.role).toBe("user");
    for (const fragment of [
      '"envelope.roof"',
      '"asphalt shingles"',
      '"hvac[1].systemType"',
      '"the second system"',
    ]) {
      expect(candidateMessage.content).toContain(fragment);
    }
    // A non-candidate's quote is not handed back.
    expect(candidateMessage.content).not.toContain("brick walls");

    // The system prompt keeps the target's own instructions.
    expect(req.messages[0]!.role).toBe("system");
    expect(req.messages[0]!.content).toContain(gapTarget.instructions);
  });
});

describe("gapFillExtractor — the merge", () => {
  test("a committed value lands on exactly that leaf; every other leaf keeps the base's identity", async () => {
    const base = new FakeExtractor<GapExtraction>(abstainingFields, { usage: { calls: 1 } });
    const { chat } = fakeChat(JSON.stringify(followUpResponse));
    const result = await gapFillExtractor({ base, target: gapTarget, chat, model: "m" }).extract(
      "t",
    );

    // Candidates take the follow-up's answer wholesale — value, confidence, span.
    expect(result.fields.envelope.roof).toEqual(followUpResponse["envelope.roof"]);
    expect(result.fields.hvac[1]!.systemType).toEqual(followUpResponse["hvac[1].systemType"]);

    // Nothing else moved — reference-equal to the base result's own objects.
    expect(result.fields.envelope.wall).toBe(abstainingFields.envelope.wall);
    expect(result.fields.hvac[0]).toBe(abstainingFields.hvac[0]);

    // The base result was not mutated.
    expect(abstainingFields.envelope.roof.value).toBeNull();
  });

  test("a follow-up that reaffirms null leaves the leaf null — a valid answer, not a revert", async () => {
    const reaffirmAll = {
      "envelope.roof": { value: null, confidence: 0.5, sourceSpan: "asphalt shingles" },
      "hvac[1].systemType": { value: null, confidence: 0.6, sourceSpan: "the second system" },
    };
    const base = new FakeExtractor<GapExtraction>(abstainingFields, { usage: { calls: 1 } });
    const { chat } = fakeChat(JSON.stringify(reaffirmAll));
    const result = await gapFillExtractor({ base, target: gapTarget, chat, model: "m" }).extract(
      "t",
    );

    // The follow-up's explicit null stands — with ITS confidence, not the base's.
    expect(result.fields.envelope.roof).toEqual(reaffirmAll["envelope.roof"]);
    expect(result.fields.envelope.roof.value).toBeNull();
    expect(result.fields.hvac[1]!.systemType).toEqual(reaffirmAll["hvac[1].systemType"]);
  });

  test("normalize runs once on the merged result — the follow-up's leaves go through the same pass", async () => {
    const clamp = (n: number): number => Math.max(0, Math.min(1, n));
    const normalize = (fields: GapExtraction): GapExtraction => ({
      ...fields,
      envelope: {
        ...fields.envelope,
        roof: { ...fields.envelope.roof, confidence: clamp(fields.envelope.roof.confidence) },
      },
    });
    // An out-of-range confidence the model has no business emitting, clamped by
    // the same deterministic pass a base extractor would apply.
    const wild = {
      ...followUpResponse,
      "envelope.roof": {
        value: "asphalt_shingle",
        confidence: 1.7,
        sourceSpan: "asphalt shingles",
      },
    };
    const base = new FakeExtractor<GapExtraction>(abstainingFields, { usage: { calls: 1 } });
    const { chat } = fakeChat(JSON.stringify(wild));
    const result = await gapFillExtractor({
      base,
      target: gapTarget,
      chat,
      model: "m",
      normalize,
    }).extract("t");

    expect(result.fields.envelope.roof.confidence).toBe(1);
    expect(result.fields.envelope.roof.value).toBe("asphalt_shingle");
  });
});

describe("gapFillExtractor — usage", () => {
  test("sums the base run and the follow-up call, engine included", async () => {
    const base = new FakeExtractor<GapExtraction>(abstainingFields, {
      usage: {
        calls: 1,
        engine: "fake",
        promptTokens: 100,
        completionTokens: 50,
        cachedPromptTokens: 20,
      },
    });
    const { chat } = fakeChat(JSON.stringify(followUpResponse), {
      usage: { promptTokens: 40, completionTokens: 10, cachedPromptTokens: 5 },
    });
    const result = await gapFillExtractor({ base, target: gapTarget, chat, model: "m" }).extract(
      "t",
    );

    expect(result.usage).toEqual({
      calls: 2,
      engine: "fake",
      promptTokens: 140,
      completionTokens: 60,
      cachedPromptTokens: 25,
    });
  });

  test("a follow-up that reports no usage leaves the token totals absent, not zero", async () => {
    // The distinction `addUsage` exists to protect: absent means "not reported".
    const base = new FakeExtractor<GapExtraction>(abstainingFields, { usage: { calls: 1 } });
    const { chat } = fakeChat(JSON.stringify(followUpResponse));
    const result = await gapFillExtractor({ base, target: gapTarget, chat, model: "m" }).extract(
      "t",
    );

    expect(result.usage).toEqual({ calls: 2 });
  });
});

describe("gapFillExtractor — the follow-up crosses the same trust boundary", () => {
  test("a value outside the leaf's own constraints is a recognisable, transient schema failure", async () => {
    // Out-of-enum: the scoped schema carries the roof's enum, so this rejects —
    // the follow-up is not a laxer parse path.
    const invalid = {
      ...followUpResponse,
      "envelope.roof": { value: "cedar_shake", confidence: 0.9, sourceSpan: "asphalt shingles" },
    };
    const base = new FakeExtractor<GapExtraction>(abstainingFields, { usage: { calls: 1 } });
    const { chat } = fakeChat(JSON.stringify(invalid));

    const error = await catchRejection(
      gapFillExtractor({ base, target: gapTarget, chat, model: "m" }).extract("t"),
    );

    expect(error).toBeInstanceOf(SchemaParseError);
    expect((error as Error).message).toContain("did not match the schema");
    expect(isTransientFailure(error)).toBe(true);
  });

  test("a truncated follow-up (finishReason 'length') is terminal, naming maxTokens", async () => {
    const base = new FakeExtractor<GapExtraction>(abstainingFields, { usage: { calls: 1 } });
    const { chat } = fakeChat(JSON.stringify(followUpResponse), { finishReason: "length" });

    const error = await catchRejection(
      gapFillExtractor({ base, target: gapTarget, chat, model: "m" }).extract("t"),
    );

    expect((error as Error).message).toContain("maxTokens");
    expect(isTransientFailure(error)).toBe(false);
  });
});

describe("findAbstainedLeaves / formatLeafPath / mergeGapFilledLeaves — the pure helpers", () => {
  test("findAbstainedLeaves collects exactly the value-null-with-quote leaves, with paths and quotes", () => {
    expect(findAbstainedLeaves(abstainingFields)).toEqual([
      { path: ["envelope", "roof"], sourceSpan: "asphalt shingles" },
      { path: ["hvac", 1, "systemType"], sourceSpan: "the second system" },
    ]);
    // Plain abstentions and committed leaves are not collected.
    expect(findAbstainedLeaves(committedFields)).toEqual([]);
  });

  test("the walker handles an array whose elements are leaves directly", () => {
    // `Enveloped<V>`'s TYPE collapses an array of primitives — a homomorphic
    // mapped type over `string` is `string` — but `enveloped()` the function
    // DOES produce an array of envelopes for a `z.array(z.string())` patch.
    // The runtime shape exists even though the public type cannot name it, so
    // the walker must not assume a leaf only ever sits under an object; the
    // cast is how the test says so.
    const fields = {
      tags: [
        { value: null, confidence: 0.3, sourceSpan: "cathedral ceilings" },
        { value: "r-30", confidence: 0.9, sourceSpan: "r-30" },
      ],
    } as unknown as Enveloped<{ tags?: string[] }>;

    expect(findAbstainedLeaves(fields)).toEqual([
      { path: ["tags", 0], sourceSpan: "cathedral ceilings" },
    ]);

    const merged = mergeGapFilledLeaves(fields, {
      "tags[0]": { value: "cathedral", confidence: 0.8, sourceSpan: "cathedral ceilings" },
    });
    expect(merged).toEqual({
      tags: [
        { value: "cathedral", confidence: 0.8, sourceSpan: "cathedral ceilings" },
        { value: "r-30", confidence: 0.9, sourceSpan: "r-30" },
      ],
    });
    // Rebuilt along the path to the replacement, untouched elsewhere.
    expect(merged.tags).not.toBe(fields.tags);
    expect(merged.tags[1]).toBe(fields.tags[1]);
  });

  test("formatLeafPath joins object keys with dots and wraps array indices in brackets", () => {
    expect(formatLeafPath(["envelope", "roof"])).toBe("envelope.roof");
    expect(formatLeafPath(["hvac", 1, "systemType"])).toBe("hvac[1].systemType");
    expect(formatLeafPath(["notes", 0])).toBe("notes[0]");
  });

  test("mergeGapFilledLeaves replaces exactly the keyed paths and keeps every other reference", () => {
    const merged = mergeGapFilledLeaves(abstainingFields, followUpResponse);

    expect(merged.envelope.roof).toEqual(followUpResponse["envelope.roof"]);
    expect(merged.hvac[1]!.systemType).toEqual(followUpResponse["hvac[1].systemType"]);

    // Identity is preserved where nothing changed; rebuilt only along the way
    // to a replacement.
    expect(merged.envelope.wall).toBe(abstainingFields.envelope.wall);
    expect(merged.hvac[0]).toBe(abstainingFields.hvac[0]);
    expect(merged.envelope).not.toBe(abstainingFields.envelope);
    expect(abstainingFields.envelope.roof.value).toBeNull();
  });

  test("an empty follow-up returns the base structure itself", () => {
    expect(mergeGapFilledLeaves(abstainingFields, {})).toBe(abstainingFields);
  });
});
