import { enveloped } from "../../provenance/enveloped.js";
import { extractorPhase } from "../../phases/extractor-phase.js";
import { FakeExtractor } from "../extractor.js";
import { isTransientFailure } from "../../storage/backoff.js";
import { phasedExtractor } from "../../phases/phased-extractor.js";
import { SchemaParseError } from "../schema-parse-error.js";
import type {
  ChatClient,
  ChatFinishReason,
  ChatRequest,
  ChatUsage,
} from "../../phases/chat-client.js";
import type { Enveloped } from "../../provenance/enveloped.js";
import type { ExtractionTarget, Extractor } from "../extractor.js";
import type { PhaseUnit } from "../extraction-observer.js";
import { z } from "zod";
import { describe, expect, test } from "vitest";
import {
  findAbstainedLeaves,
  findUngroundedLeaves,
  formatLeafPath,
  gapFillExtractor,
  mergeGapFilledLeaves,
} from "./gap-fill.js";
import { gapFillPhase } from "../../phases/gap-fill-phase.js";
import { singleShotExtractor } from "../single-shot.js";

/**
 * Key-free CI tests for the gap-fill combinator, against a small self-contained
 * target derived with `enveloped()` — the same fixture discipline as core's
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
    // Category 3 — reference identity is lost, on both paths: the engine's
    // closing parse rebuilds every object, so the passthrough result is
    // deep-equal to the base's fields, not the same object.
    //
    // The base's roof confidence is out of range on purpose: `confidence` is a
    // bare `z.number()` (clamping is normalization's job, not the schema's), so
    // 1.7 parses. This keeps the test's original guard alive — it used to prove
    // normalize does not run on the passthrough path BY IDENTITY, and amending
    // its `toBe` to `toEqual` would have hollowed that, because the normalize it
    // passed was spread-identity and value-preserving. The normalize is now an
    // observable clamp; asserting below that the clamp did NOT apply is what
    // still guards "never runs on the passthrough path".
    const clamp = (n: number): number => Math.max(0, Math.min(1, n));
    // `committedFields` with one out-of-range confidence — still schema-valid.
    const passthroughBase: GapExtraction = {
      ...committedFields,
      envelope: {
        ...committedFields.envelope,
        roof: { ...committedFields.envelope.roof, confidence: 1.7 },
      },
    };
    const base = new FakeExtractor<GapExtraction>(passthroughBase, {
      usage: { calls: 1, promptTokens: 100, completionTokens: 50 },
    });
    const { chat, requests } = fakeChat(JSON.stringify(followUpResponse));
    const extractor = gapFillExtractor({
      base,
      target: gapTarget,
      chat,
      model: "gpt-test",
      normalize: (fields) => ({
        ...fields,
        envelope: {
          ...fields.envelope,
          roof: { ...fields.envelope.roof, confidence: clamp(fields.envelope.roof.confidence) },
        },
      }),
    });

    const transcript = "The roof is asphalt shingles; the walls are brick.";
    const result = await extractor.extract({ text: transcript, annotations: {} });

    expect(result.fields).toEqual(passthroughBase);
    // The clamp did NOT apply — normalize never runs on the passthrough path.
    expect(result.fields.envelope.roof.confidence).toBe(1.7);
    expect(result.usage).toEqual({ calls: 1, promptTokens: 100, completionTokens: 50 });
    expect(requests).toHaveLength(0);
    // The base extractor still ran, on the transcript.
    expect(base.calls.map((t) => t.text)).toEqual([transcript]);
  });

  test("the caller's deadline reaches the base extractor", async () => {
    // Regression pin for the forward at gap-fill.ts: the base runs on the
    // caller's options bag WHOLE, so the deadline — the signal's sibling
    // member with the same forwarding discipline — reaches it untouched.
    const base = new FakeExtractor<GapExtraction>(committedFields);
    const { chat } = fakeChat(JSON.stringify(followUpResponse));
    const extractor = gapFillExtractor({ base, target: gapTarget, chat, model: "gpt-test" });
    const deadline = 1_234_567_890;

    await extractor.extract({ text: "t", annotations: {} }, { deadline });

    expect(base.callOptions[0]?.deadline).toBe(deadline);
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
    await extractor.extract({ text: transcript, annotations: {} });

    expect(requests).toHaveLength(1);
    const req = requests[0]!;
    expect(req.model).toBe("gpt-test");
    expect(req.maxTokens).toBe(2048);
    expect(req.responseFormat.type).toBe("json_schema");
    expect(req.responseFormat.json_schema.strict).toBe(true);
    expect(req.responseFormat.json_schema.name).toBe("gap-demo-gap-fill");

    // Scoped: the schema carries exactly the abstained leaves, keyed by path —
    // the committed wall and hvac[0] are not re-asked.
    const schema = req.responseFormat.json_schema.schema as {
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
  test("a committed value lands on exactly that leaf; every other leaf keeps the base's values", async () => {
    const base = new FakeExtractor<GapExtraction>(abstainingFields, { usage: { calls: 1 } });
    const { chat } = fakeChat(JSON.stringify(followUpResponse));
    const result = await gapFillExtractor({ base, target: gapTarget, chat, model: "m" }).extract({
      text: "t",
      annotations: {},
    });

    // Candidates take the follow-up's answer wholesale — value, confidence, span.
    expect(result.fields.envelope.roof).toEqual(followUpResponse["envelope.roof"]);
    expect(result.fields.hvac[1]!.systemType).toEqual(followUpResponse["hvac[1].systemType"]);

    // Category 3 — the engine's closing parse rebuilds every object, so untouched
    // leaves are deep-equal to the base's, not reference-equal. The
    // identity-preservation property itself still holds inside
    // `mergeGapFilledLeaves` and is still pinned by the pure-helper tests, which
    // call it directly — that is where the guarantee lives now.
    expect(result.fields.envelope.wall).toEqual(abstainingFields.envelope.wall);
    expect(result.fields.hvac[0]).toEqual(abstainingFields.hvac[0]);

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
    const result = await gapFillExtractor({ base, target: gapTarget, chat, model: "m" }).extract({
      text: "t",
      annotations: {},
    });

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
    }).extract({ text: "t", annotations: {} });

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
    const result = await gapFillExtractor({ base, target: gapTarget, chat, model: "m" }).extract({
      text: "t",
      annotations: {},
    });

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
    const result = await gapFillExtractor({ base, target: gapTarget, chat, model: "m" }).extract({
      text: "t",
      annotations: {},
    });

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
      gapFillExtractor({ base, target: gapTarget, chat, model: "m" }).extract({
        text: "t",
        annotations: {},
      }),
    );

    expect(error).toBeInstanceOf(SchemaParseError);
    expect((error as Error).message).toContain("did not match the schema");
    expect(isTransientFailure(error)).toBe(true);
  });

  test("a truncated follow-up (finishReason 'length') is terminal, naming maxTokens", async () => {
    const base = new FakeExtractor<GapExtraction>(abstainingFields, { usage: { calls: 1 } });
    const { chat } = fakeChat(JSON.stringify(followUpResponse), { finishReason: "length" });

    const error = await catchRejection(
      gapFillExtractor({ base, target: gapTarget, chat, model: "m" }).extract({
        text: "t",
        annotations: {},
      }),
    );

    expect((error as Error).message).toContain("maxTokens");
    expect(isTransientFailure(error)).toBe(false);
  });
});

describe("gapFillExtractor — regression pins from the port", () => {
  test("raw is the merged fields after a follow-up — not the base's raw, and not absent", async () => {
    // Regression pin for the follow-up phase's merge: today's follow-up path sets
    // `raw` to the merged fields — the base's answers with the follow-up's
    // accepted ones spliced in — whether or not the base carried a raw of its
    // own. Under the port the result's `raw` comes from the draft, which only the
    // follow-up phase's merge writes; nothing else in the suite asserted this, so
    // a port that dropped the write would have shipped silently.
    const base = new FakeExtractor<GapExtraction>(abstainingFields, {
      raw: "the base's own raw model output",
      usage: { calls: 1 },
    });
    const { chat } = fakeChat(JSON.stringify(followUpResponse));
    const result = await gapFillExtractor({ base, target: gapTarget, chat, model: "m" }).extract({
      text: "t",
      annotations: {},
    });

    expect(result.raw).toEqual({
      envelope: {
        roof: followUpResponse["envelope.roof"],
        wall: abstainingFields.envelope.wall,
      },
      hvac: [abstainingFields.hvac[0], { systemType: followUpResponse["hvac[1].systemType"] }],
    });
  });

  test("a transiently-failing base extractor is attempted exactly once", async () => {
    // Regression pin for the base phase's `maxRetries: 0`: today's wrapper calls
    // `base.extract` exactly once, and the ported preset pins the base phase at
    // zero retries to keep it that way — the engine's default of 2 would retry a
    // transiently-failing base with real backoff. `FakeExtractor` never fails,
    // so nothing else in the suite would catch the base silently gaining retries.
    let baseCalls = 0;
    const transient = Object.assign(new Error("service unavailable"), { status: 503 });
    const failingBase: Extractor<GapExtraction> = {
      extract: () => {
        baseCalls += 1;
        return Promise.reject(transient);
      },
    };
    const { chat } = fakeChat(JSON.stringify(followUpResponse));

    await expect(
      gapFillExtractor({ base: failingBase, target: gapTarget, chat, model: "m" }).extract({
        text: "t",
        annotations: {},
      }),
    ).rejects.toBe(transient);

    expect(baseCalls).toBe(1);
  });
});

describe("gapFillExtractor — progress units", () => {
  test("the base phase's pair comes first, then the follow-up's — keyed by phaseId and pass", async () => {
    const base = new FakeExtractor<GapExtraction>(abstainingFields, { usage: { calls: 1 } });
    const { chat } = fakeChat(JSON.stringify(followUpResponse), {
      usage: { promptTokens: 30, completionTokens: 12 },
    });
    const events: PhaseUnit[] = [];
    await gapFillExtractor({
      base,
      target: gapTarget,
      chat,
      model: "m",
      onUnit: (event) => events.push(event),
    }).extract({ text: "t", annotations: {} });

    // Category 1 — events changed from `GapFillUnit` to `PhaseUnit`: the wrapper
    // is an engine preset, so the unit is identified by `phaseId` and `pass`, and
    // the candidate count is no longer on the event (restoring it would be a
    // `PhaseUnit` change and is not this port). Category 2 — the base phase
    // always plans one item, so its `start`/`done` pair precedes the follow-up's.
    expect(events.map((e) => [e.phaseId, e.pass, e.phase, e.attempt])).toEqual([
      ["base", 0, "start", 1],
      ["base", 0, "done", 1],
      ["gapfill", 1, "start", 1],
      ["gapfill", 1, "done", 1],
    ]);
    // No retry loop on either phase, so 1 is the honest report on every event.
    // Each phase's pair shares one id; the ids are the engine's own mint.
    expect(events[1]!.id).toBe(events[0]!.id);
    expect(events[3]!.id).toBe(events[2]!.id);
    // The event's usage is the follow-up completion's own, not the combined total.
    expect(events[3]!.usage).toEqual({ inputTokens: 30, outputTokens: 12 });
  });

  test("the passthrough emits only the base phase's pair and makes no chat call", async () => {
    // Category 2 — the passthrough now emits: the base phase always plans one
    // item, so every run — passthrough included — emits a base `start`/`done`
    // pair. The follow-up phase still plans nothing: no second call, and no
    // event announcing work that never happened.
    const base = new FakeExtractor<GapExtraction>(committedFields, { usage: { calls: 1 } });
    const { chat, requests } = fakeChat(JSON.stringify(followUpResponse));
    const events: PhaseUnit[] = [];
    const result = await gapFillExtractor({
      base,
      target: gapTarget,
      chat,
      model: "m",
      onUnit: (event) => events.push(event),
    }).extract({ text: "t", annotations: {} });

    expect(events.map((e) => [e.phaseId, e.pass, e.phase])).toEqual([
      ["base", 0, "start"],
      ["base", 0, "done"],
    ]);
    expect(requests).toHaveLength(0);
    // Category 3 — deep equality: the closing parse rebuilds the result.
    expect(result.fields).toEqual(committedFields);
  });

  test("a base built with its own onUnit delivers its units inside the base phase's pair", async () => {
    // §0.3: the base is handed over ALREADY BUILT, so there is no threading for
    // gap-fill to do — the base's units flow through the observer its own caller
    // gave it. Category 2 — the wrapper's observer now ALSO sees the engine's
    // phase events for the base phase's single item: the engine announces the
    // attempt before `run` makes the call, so the base's own units nest inside
    // the base phase's start/done, and the follow-up phase follows.
    const baseChat = fakeChat(JSON.stringify(abstainingFields));
    const followUpChat = fakeChat(JSON.stringify(followUpResponse));
    const seen: string[] = [];

    const base = singleShotExtractor({
      target: gapTarget,
      chat: baseChat.chat,
      model: "m",
      onUnit: (event) => seen.push(`base:${event.unit}:${event.phase}`),
    });
    await gapFillExtractor({
      base,
      target: gapTarget,
      chat: followUpChat.chat,
      model: "m",
      onUnit: (event) => seen.push(`gapfill:${event.phaseId}:${event.phase}`),
    }).extract({ text: "t", annotations: {} });

    expect(seen).toEqual([
      "gapfill:base:start", // the engine announces the base phase's attempt first
      "base:whole:start", // the base's own units, made inside that attempt
      "base:whole:done",
      "gapfill:base:done",
      "gapfill:gapfill:start", // then the follow-up phase
      "gapfill:gapfill:done",
    ]);
  });

  test("with onUnit absent, an identical run produces an identical result and call sequence", async () => {
    const followUpUsage = { promptTokens: 30, completionTokens: 12 };

    const observed = fakeChat(JSON.stringify(followUpResponse), { usage: followUpUsage });
    const events: PhaseUnit[] = [];
    const withObserver = await gapFillExtractor({
      base: new FakeExtractor<GapExtraction>(abstainingFields, { usage: { calls: 1 } }),
      target: gapTarget,
      chat: observed.chat,
      model: "m",
      onUnit: (event) => events.push(event),
    }).extract({ text: "t", annotations: {} });

    const silent = fakeChat(JSON.stringify(followUpResponse), { usage: followUpUsage });
    const withoutObserver = await gapFillExtractor({
      base: new FakeExtractor<GapExtraction>(abstainingFields, { usage: { calls: 1 } }),
      target: gapTarget,
      chat: silent.chat,
      model: "m",
    }).extract({ text: "t", annotations: {} });

    // The observed run really did observe — otherwise the comparison below proves
    // nothing. Category 2 — both phases' pairs appear now: the base phase's and
    // the follow-up's.
    expect(events.map((event) => [event.phaseId, event.phase])).toEqual([
      ["base", "start"],
      ["base", "done"],
      ["gapfill", "start"],
      ["gapfill", "done"],
    ]);
    // The observation point changed nothing: same result, same bytes on the wire.
    expect(withoutObserver).toEqual(withObserver);
    expect(silent.requests).toEqual(observed.requests);
  });
});

describe("findAbstainedLeaves / formatLeafPath / mergeGapFilledLeaves — the pure helpers", () => {
  test("findAbstainedLeaves collects exactly the value-null-with-quote leaves, with paths and quotes", () => {
    expect(findAbstainedLeaves(abstainingFields)).toEqual([
      { path: ["envelope", "roof"], sourceSpan: "asphalt shingles", kind: "abstained" },
      { path: ["hvac", 1, "systemType"], sourceSpan: "the second system", kind: "abstained" },
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
      { path: ["tags", 0], sourceSpan: "cathedral ceilings", kind: "abstained" },
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

// ---------------------------------------------------------------------------
// targets: ["ungrounded"] — re-ask leaves that cite text absent from the transcript.

/** The transcript every ungrounded-target test scores against. */
const groundedTranscript = "The roof is asphalt shingles; the walls are brick.";

/** `envelope.wall` commits to a value while citing text that is not in the transcript. */
const fabricatedFields: GapExtraction = {
  envelope: {
    roof: { value: "asphalt_shingle", confidence: 0.9, sourceSpan: "asphalt shingles" },
    wall: { value: "brick", confidence: 0.9, sourceSpan: "Wall material: brick" },
  },
  hvac: [],
};

describe("gapFillExtractor — the ungrounded target", () => {
  test("is off by default, so an ungrounded span alone makes no follow-up call", async () => {
    const { chat, requests } = fakeChat("{}");
    const extractor = gapFillExtractor({
      base: new FakeExtractor<GapExtraction>(fabricatedFields),
      target: gapTarget,
      chat,
      model: "gpt-test",
    });

    const result = await extractor.extract({ text: groundedTranscript, annotations: {} });

    expect(requests).toHaveLength(0);
    // Category 3 — the closing parse rebuilds the result, so the passthrough is
    // deep-equal to the base's fields, not the same object.
    expect(result.fields).toEqual(fabricatedFields);
  });

  test("re-asks the ungrounded leaf and accepts a citation that grounds", async () => {
    const { chat, requests } = fakeChat(
      JSON.stringify({
        "envelope.wall": { value: "brick", confidence: 0.9, sourceSpan: "the walls are brick" },
      }),
    );
    const extractor = gapFillExtractor({
      base: new FakeExtractor<GapExtraction>(fabricatedFields),
      target: gapTarget,
      chat,
      model: "gpt-test",
      targets: ["ungrounded"],
    });

    const result = await extractor.extract({ text: groundedTranscript, annotations: {} });

    expect(requests).toHaveLength(1);
    expect(result.fields.envelope?.wall.sourceSpan).toBe("the walls are brick");
    // The grounded roof was left alone — only the fabricated leaf was re-asked.
    expect(result.fields.envelope?.roof.sourceSpan).toBe("asphalt shingles");
  });

  test("refuses a replacement whose citation is ALSO absent, keeping the base leaf", async () => {
    // The measured failure mode: asked to fix a citation, the model produces a second
    // unverifiable one rather than conceding. Swapping one fabrication for another is not
    // progress, so the pass must be non-regressive.
    const { chat } = fakeChat(
      JSON.stringify({
        "envelope.wall": {
          value: "brick",
          confidence: 0.99,
          sourceSpan: "Walls: brick (exterior)",
        },
      }),
    );
    const extractor = gapFillExtractor({
      base: new FakeExtractor<GapExtraction>(fabricatedFields),
      target: gapTarget,
      chat,
      model: "gpt-test",
      targets: ["ungrounded"],
    });

    const result = await extractor.extract({ text: groundedTranscript, annotations: {} });

    expect(result.fields.envelope?.wall.sourceSpan).toBe("Wall material: brick");
    expect(result.fields.envelope?.wall.value).toBe("brick");
  });

  test("accepts a conceded null even though it carries no citation", async () => {
    const { chat } = fakeChat(
      JSON.stringify({ "envelope.wall": { value: null, confidence: 0.1, sourceSpan: null } }),
    );
    const extractor = gapFillExtractor({
      base: new FakeExtractor<GapExtraction>(fabricatedFields),
      target: gapTarget,
      chat,
      model: "gpt-test",
      targets: ["ungrounded"],
    });

    const result = await extractor.extract({ text: groundedTranscript, annotations: {} });

    expect(result.fields.envelope?.wall.value).toBeNull();
    expect(result.fields.envelope?.wall.sourceSpan).toBeNull();
  });

  test("a near-miss span is not a candidate", async () => {
    // The middle tier exists to say "this quote is fine, just re-spaced". Re-asking it would
    // spend a paid call on a non-problem.
    const nearMiss: GapExtraction = {
      envelope: {
        roof: { value: "asphalt_shingle", confidence: 0.9, sourceSpan: "ASPHALT   SHINGLES" },
        wall: { value: "brick", confidence: 0.9, sourceSpan: "the walls are brick" },
      },
      hvac: [],
    };
    const { chat, requests } = fakeChat("{}");
    const extractor = gapFillExtractor({
      base: new FakeExtractor<GapExtraction>(nearMiss),
      target: gapTarget,
      chat,
      model: "gpt-test",
      targets: ["ungrounded"],
    });

    await extractor.extract({ text: groundedTranscript, annotations: {} });

    expect(requests).toHaveLength(0);
  });

  test("both targets travel in one call", async () => {
    const mixed: GapExtraction = {
      envelope: {
        roof: { value: null, confidence: 0.4, sourceSpan: "asphalt shingles" },
        wall: { value: "brick", confidence: 0.9, sourceSpan: "Wall material: brick" },
      },
      hvac: [],
    };
    const { chat, requests } = fakeChat(
      JSON.stringify({
        "envelope.roof": {
          value: "asphalt_shingle",
          confidence: 0.9,
          sourceSpan: "asphalt shingles",
        },
        "envelope.wall": { value: "brick", confidence: 0.9, sourceSpan: "the walls are brick" },
      }),
    );
    const extractor = gapFillExtractor({
      base: new FakeExtractor<GapExtraction>(mixed),
      target: gapTarget,
      chat,
      model: "gpt-test",
      targets: ["abstained", "ungrounded"],
    });

    const result = await extractor.extract({ text: groundedTranscript, annotations: {} });

    expect(requests).toHaveLength(1);
    expect(result.fields.envelope?.roof.value).toBe("asphalt_shingle");
    expect(result.fields.envelope?.wall.sourceSpan).toBe("the walls are brick");
  });
});

describe("findUngroundedLeaves", () => {
  test("collects only committed leaves whose span is absent from the transcript", () => {
    const found = findUngroundedLeaves(fabricatedFields, groundedTranscript);
    expect(found.map((leaf) => formatLeafPath(leaf.path))).toEqual(["envelope.wall"]);
    expect(found[0]?.kind).toBe("ungrounded");
  });

  test("ignores a null value however bad its span — that is the abstained finder's leaf", () => {
    const abstainedWithBadSpan: GapExtraction = {
      envelope: {
        roof: { value: null, confidence: 0.4, sourceSpan: "Roof: not stated anywhere" },
        wall: { value: "brick", confidence: 0.9, sourceSpan: "the walls are brick" },
      },
      hvac: [],
    };
    expect(findUngroundedLeaves(abstainedWithBadSpan, groundedTranscript)).toEqual([]);
    expect(findAbstainedLeaves(abstainedWithBadSpan).map((l) => l.kind)).toEqual(["abstained"]);
  });
});

describe("gapFillOptions provenance parameter", () => {
  test("accepts a target whose provenance declares a row group", () => {
    const rowSchema = z
      .object({
        rooms: z
          .array(
            z
              .object({
                name: z.string().nullable().optional(),
              })
              .strict(),
          )
          .optional(),
      })
      .strict();
    type RowValues = z.infer<typeof rowSchema>;
    const rowTarget: ExtractionTarget<RowValues, { rooms: "row" }> = {
      name: "row-demo",
      extractionSchema: enveloped(rowSchema, { provenance: { rooms: "row" } }),
      instructions: "Extract rooms as a row group.",
    };
    const base: Extractor<Enveloped<RowValues, { rooms: "row" }>> = new FakeExtractor({
      rooms: [],
    });
    gapFillExtractor({ base, target: rowTarget, chat: {} as ChatClient, model: "test" });
  });

  test("rejects a base extractor whose enveloped type does not match the target", () => {
    type OtherValues = { other: string };
    const target: ExtractionTarget<{ rooms: string }, { rooms: "row" }> = {} as ExtractionTarget<
      { rooms: string },
      { rooms: "row" }
    >;
    const base: Extractor<Enveloped<OtherValues>> = new FakeExtractor({
      other: "x",
    } as unknown as Enveloped<OtherValues>);
    // @ts-expect-error base extractor's Enveloped<OtherValues> is not assignable to the target's Enveloped<{rooms:string},{rooms:"row"}>
    gapFillExtractor({ base, target, chat: {} as ChatClient, model: "test" });
  });
});

describe("gapFillExtractor — the composition claim", () => {
  test("a hand-assembled phase list — extractorPhase base, then gapFillPhase — matches the preset", async () => {
    // The design's argument for `extractorPhase` is that any `Extractor` becomes
    // a phase, so a host can put an existing combinator and a custom phase in one
    // list. This port is the first evidence, and this test pins the claim: the
    // preset's exact body, assembled by hand, producing the same fields. The base
    // phase is pinned to `maxRetries: 0` at the run level, as the preset does —
    // `extractorPhase` declares no retries of its own.
    const transcript = { text: "t", annotations: {} };
    const base = () => new FakeExtractor<GapExtraction>(abstainingFields, { usage: { calls: 1 } });
    const followUp = () => fakeChat(JSON.stringify(followUpResponse)).chat;

    const handAssembled = await phasedExtractor<GapValues>({
      target: gapTarget,
      maxRetries: 0,
      phases: [
        extractorPhase("base", base()),
        gapFillPhase({ target: gapTarget, chat: followUp(), model: "m" }),
      ],
    }).extract(transcript);

    const preset = await gapFillExtractor({
      base: base(),
      target: gapTarget,
      chat: followUp(),
      model: "m",
    }).extract(transcript);

    expect(handAssembled.fields).toEqual(preset.fields);
    expect(handAssembled.usage).toEqual(preset.usage);
  });
});
