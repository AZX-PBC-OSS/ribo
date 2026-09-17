import { z } from "zod";
import { describe, expect, test } from "vitest";

import { enveloped } from "./enveloped.js";
import type { Enveloped } from "./enveloped.js";
import { FakeExtractor } from "./extractor.js";
import type {
  Extractor,
  ExtractionResult,
  ExtractionTarget,
  ExtractionUsage,
} from "./extractor.js";
import type { AnnotatedTranscript } from "./annotated-transcript.js";
import type { Extracted } from "./provenance.js";
import type { LeafPath } from "./extracted-leaves.js";
import { majorityValues } from "./consensus-arbiter.js";
import { ConsensusFailedError, consensusExtractor } from "./consensus-extractor.js";
import { fallbackExtractor } from "./fallback-extractor.js";
import { terminalFallsThrough } from "./arbitration.js";
import { isCancellation } from "./cancellation.js";
import { TerminalError } from "./storage/backoff.js";

/**
 * Tests for `consensusExtractor` — the substantial judging combinator
 * (`sp2-judging-combinators-design.md` §4.1, wave-4 plan Task 2).
 *
 * The pins that matter most:
 *
 * - **A rejecting candidate does not abort its siblings.** `mapWithPool` — the
 *   repo's other multi-call scheduler — rejects on the first failure and calls
 *   `abort.abort()`, cancelling every survivor. Consensus needs the opposite:
 *   a failed candidate is a missing sample, not a failed run. The deferred
 *   candidates below never settle if a sibling's rejection cancelled them.
 * - **A cancellation stays a cancellation.** `allSettled` catches for this
 *   combinator — the only one in the repo that must — so the way it fails is
 *   silent: an implementation that checks the survivor count before the
 *   rejections reports "0 of 2 survived" and loses the abort. The cancellation
 *   pin fails that implementation by name.
 * - **Both collection orderings.** A sample producing a fourth `hvac` instance
 *   is dropped when it is the SECOND candidate (the first survivor is
 *   structurally authoritative, the shared prefix still agrees) and contested
 *   wholesale when it is FIRST (the others are now short — index-wise
 *   comparison would pair across a shift). A single-ordering test passes a
 *   dropping implementation either way and proves nothing.
 */

const TRANSCRIPT = ["The heating system is a gas furnace.", "The attic insulation is R-38."].join(
  " ",
);

const transcript: AnnotatedTranscript = { text: TRANSCRIPT, annotations: {} };

const testValuesSchema = z
  .object({
    heating: z
      .object({
        systemType: z.enum(["gas", "oil", "propane"]).nullable().optional(),
        efficiency: z.number().nullable().optional(),
      })
      .strict(),
    hvac: z
      .array(z.object({ fuel: z.enum(["gas", "electric", "oil"]).nullable().optional() }).strict())
      .optional(),
  })
  .strict();

type Fields = Enveloped<z.infer<typeof testValuesSchema>>;

const target: ExtractionTarget<z.infer<typeof testValuesSchema>> = {
  name: "test-target",
  extractionSchema: enveloped(testValuesSchema),
  instructions: "extract the heating and hvac fields",
};

/** A hand-built leaf envelope, the way model output arrives after parsing. */
const leaf = <const V>(value: V | null, sourceSpan: string | null): Extracted<V> => ({
  value,
  confidence: 1,
  sourceSpan,
});

/** One heating group, with an optionally distinct span for `systemType`. */
const heating = (
  systemType: "gas" | "oil" | "propane" | null,
  efficiency: number | null,
  systemTypeSpan: string | null = "gas furnace",
) => ({
  systemType: leaf(systemType, systemTypeSpan),
  efficiency: leaf(efficiency, "R-38"),
});

/** One hvac instance — a collection leaf under `hvac`. */
const unit = <const F extends "gas" | "electric" | "oil">(fuel: F, span: string) => ({
  fuel: leaf(fuel, span),
});

const agreedFields: Fields = {
  heating: heating("gas", 0.8),
  hvac: [unit("gas", "gas furnace"), unit("electric", "electric baseboard")],
};

/** Three rooftop units, A B C — and a fourth, D, for the instance-count pins. */
const threeUnits: Fields = {
  heating: heating("gas", 0.8),
  hvac: [unit("gas", "unit a"), unit("oil", "unit b"), unit("electric", "unit c")],
};
const fourUnits: Fields = {
  heating: heating("gas", 0.8),
  hvac: [
    unit("gas", "unit a"),
    unit("oil", "unit b"),
    unit("electric", "unit c"),
    unit("gas", "unit d"),
  ],
};

/** A candidate extractor returning one fixed enveloped result. */
const candidate = (fields: Fields, usage: ExtractionUsage = { calls: 1 }) =>
  new FakeExtractor<Fields>(fields, { usage });

/** A candidate extractor that always rejects with one fixed error. */
const rejectingCandidate = (error: Error): Extractor<Fields> => ({
  extract: async () => {
    throw error;
  },
});

/** A candidate whose result carries every optional member a consensus drops. */
const extractorReturning = (result: ExtractionResult<Fields>): Extractor<Fields> => ({
  extract: async () => result,
});

/** A candidate that does not settle until `settle` is called — for the sibling pin. */
const deferredCandidate = () => {
  let settle!: (result: ExtractionResult<Fields>) => void;
  const promise = new Promise<ExtractionResult<Fields>>((resolve) => {
    settle = resolve;
  });
  const extractor: Extractor<Fields> = { extract: () => promise };
  return { extractor, settle };
};

/** Catch the extraction's rejection, or fail the test if it did not throw. */
const rejectionOf = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (caught) {
    return caught;
  }
  throw new Error("expected the extraction to be rejected");
};

describe("consensusExtractor — agreement, disagreement, citation", () => {
  test("three agreeing candidates produce their agreed values and a citation", async () => {
    const consensus = consensusExtractor(
      [candidate(agreedFields), candidate(agreedFields), candidate(agreedFields)],
      { target },
    );

    const result = await consensus.extract(transcript);

    expect(result.fields).toEqual(agreedFields);
    expect(result.fields.heating.systemType.sourceSpan).toBe("gas furnace");
  });

  test("a disagreeing leaf comes back null with confidence 0 and the policy-named sample's span", async () => {
    // `unanimousValues` contests index 0, so the citation is the FIRST
    // survivor's — the sample the policy named.
    const dissenting: Fields = {
      heating: heating("oil", 0.8, "oil furnace"),
      hvac: agreedFields.hvac,
    };
    const consensus = consensusExtractor(
      [candidate(agreedFields), candidate(dissenting), candidate(agreedFields)],
      { target },
    );

    const result = await consensus.extract(transcript);

    expect(result.fields.heating.systemType).toEqual({
      value: null,
      confidence: 0,
      sourceSpan: "gas furnace",
    });
    // The agreed leaf beside it is untouched.
    expect(result.fields.heating.efficiency).toEqual(agreedFields.heating.efficiency);
  });

  test("the arbiter's named sample supplies the accepted envelope — span included", async () => {
    // Design §9's pin, in index form: a policy naming a DIFFERENT sample gets
    // that sample's envelope, its citation with it.
    const other: Fields = {
      heating: heating("oil", 0.6, "oil furnace"),
      hvac: [],
    };
    const consensus = consensusExtractor([candidate(agreedFields), candidate(other)], {
      target,
      arbiter: () => ({ accept: 1 }),
    });

    const result = await consensus.extract(transcript);

    expect(result.fields.heating.systemType).toEqual({
      value: "oil",
      confidence: 1,
      sourceSpan: "oil furnace",
    });
  });
});

describe("consensusExtractor — survivors", () => {
  test("a candidate that rejects contributes nothing, and the run still succeeds while two survive", async () => {
    const consensus = consensusExtractor(
      [
        candidate(agreedFields),
        candidate(agreedFields),
        rejectingCandidate(new Error("transport down")),
      ],
      { target },
    );

    const result = await consensus.extract(transcript);

    expect(result.fields).toEqual(agreedFields);
    // The rejected candidate's calls are not in the sum — it produced no
    // result to read usage from.
    expect(result.usage.calls).toBe(2);
  });

  test("a rejecting candidate does not prevent the others from settling — this is not mapWithPool", async () => {
    // `mapWithPool` rejects on the first failure and aborts every sibling.
    // The deferred candidates here never resolve if that happened, and the
    // run below would reject instead of resolving with both contributions.
    const second = deferredCandidate();
    const third = deferredCandidate();
    const consensus = consensusExtractor(
      [rejectingCandidate(new Error("transport down")), second.extractor, third.extractor],
      { target },
    );

    const pending = consensus.extract(transcript);
    second.settle({ fields: agreedFields, usage: { calls: 1 } });
    third.settle({ fields: agreedFields, usage: { calls: 1 } });

    const result = await pending;
    expect(result.fields).toEqual(agreedFields);
    expect(result.usage.calls).toBe(2);
  });

  test("the caller's signal and deadline reach every candidate", async () => {
    // Forwarding discipline: the caller's whole options bag goes to each
    // candidate. `FakeExtractor.callOptions` records what actually arrived.
    const candidates = [candidate(agreedFields), candidate(agreedFields), candidate(agreedFields)];
    const consensus = consensusExtractor(candidates, { target });
    const controller = new AbortController();

    await consensus.extract(transcript, {
      signal: controller.signal,
      deadline: 1_234_567_890,
    });

    for (const inner of candidates) {
      expect(inner.callOptions).toHaveLength(1);
      expect(inner.callOptions[0]?.signal).toBe(controller.signal);
      expect(inner.callOptions[0]?.deadline).toBe(1_234_567_890);
    }
  });

  test("a caller cancellation is rethrown unchanged — not a ConsensusFailedError", async () => {
    // THE cancellation pin. With the caller's signal aborted every candidate
    // rejects, so the survivor count is zero — an implementation that counts
    // survivors before consulting the rejections reports "0 of 2 required"
    // and invents a disagreement that never happened.
    const controller = new AbortController();
    const abortError = new DOMException("The operation was aborted.", "AbortError");
    const abortable = (): Extractor<Fields> => ({
      extract: async (_transcript, options) => {
        if (options?.signal?.aborted) throw abortError;
        return { fields: agreedFields, usage: { calls: 1 } };
      },
    });
    const consensus = consensusExtractor([abortable(), abortable(), abortable()], { target });

    controller.abort();

    const caught = await rejectionOf(consensus.extract(transcript, { signal: controller.signal }));
    expect(caught).toBe(abortError);
    expect(isCancellation(caught, controller.signal)).toBe(true);
    expect(caught).not.toBeInstanceOf(ConsensusFailedError);
  });
});

describe("consensusExtractor — collections", () => {
  test("a fourth instance produced by the SECOND candidate is dropped, and the shared three are accepted", async () => {
    // The first survivor is structurally authoritative: its walk never visits
    // the extra instance, and the shared prefix goes to the arbiter with every
    // survivor present — so it is accepted, not contested.
    const contested: LeafPath[] = [];
    const consensus = consensusExtractor(
      [candidate(threeUnits), candidate(fourUnits), candidate(threeUnits)],
      { target, onContested: (path) => contested.push(path) },
    );

    const result = await consensus.extract(transcript);

    expect(result.fields.hvac).toHaveLength(3);
    expect(result.fields.hvac.map((instance) => instance.fuel.value)).toEqual([
      "gas",
      "oil",
      "electric",
    ]);
    expect(result.fields.hvac[0]?.fuel.confidence).toBe(1);
    expect(contested).toEqual([]);
  });

  test("a fourth instance produced by the FIRST candidate contests every leaf under hvac", async () => {
    // The mirror ordering, and rule 1's whole point: the other survivors are
    // now SHORT, so index-wise comparison would pair unit 4 against nothing
    // and shift every pairing after a dropped instance. The whole collection
    // is contested without consulting the arbiter; the agreed singleton group
    // beside it is untouched.
    const contested: LeafPath[] = [];
    const consensus = consensusExtractor(
      [candidate(fourUnits), candidate(threeUnits), candidate(threeUnits)],
      { target, onContested: (path) => contested.push(path) },
    );

    const result = await consensus.extract(transcript);

    expect(result.fields.hvac).toHaveLength(4);
    // Each contested leaf keeps the first survivor's own span at that path —
    // the structurally authoritative sample.
    expect(result.fields.hvac.map((instance) => instance.fuel)).toEqual([
      { value: null, confidence: 0, sourceSpan: "unit a" },
      { value: null, confidence: 0, sourceSpan: "unit b" },
      { value: null, confidence: 0, sourceSpan: "unit c" },
      { value: null, confidence: 0, sourceSpan: "unit d" },
    ]);
    expect(result.fields.heating.systemType.value).toBe("gas");
    expect(contested).toHaveLength(4);
  });

  test("a shorter survivor contests the whole collection under majorityValues — the misalignment pin", async () => {
    // Samples [A,B,C], [A,C], [A,B,C]: index 1 holds oil, electric, oil. The
    // path exists in all three, so without rule 1 the majority accepts OIL —
    // a value for an entity the second sample does not have, citing a sample
    // that was quoting a different unit. Rule 1 contests the collection first.
    const acOnly: Fields = {
      heating: heating("gas", 0.8),
      hvac: [unit("gas", "unit a"), unit("electric", "unit c")],
    };
    const contested: LeafPath[] = [];
    const consensus = consensusExtractor(
      [candidate(threeUnits), candidate(acOnly), candidate(threeUnits)],
      { target, arbiter: majorityValues, onContested: (path) => contested.push(path) },
    );

    const result = await consensus.extract(transcript);

    expect(result.fields.hvac).toHaveLength(3);
    for (const instance of result.fields.hvac) {
      expect(instance.fuel.value).toBe(null);
      expect(instance.fuel.confidence).toBe(0);
    }
    expect(contested).toHaveLength(3);
  });
});

describe("consensusExtractor — usage", () => {
  test("calls sum across every survivor, and a token member every survivor reports is summed", async () => {
    const consensus = consensusExtractor(
      [
        candidate(agreedFields, { calls: 1, promptTokens: 100 }),
        candidate(agreedFields, { calls: 2, promptTokens: 50 }),
        candidate(agreedFields, { calls: 3, promptTokens: 6 }),
      ],
      { target },
    );

    const result = await consensus.extract(transcript);

    expect(result.usage.calls).toBe(6);
    expect(result.usage.promptTokens).toBe(156);
  });

  test("a token member any survivor omits is absent — not zero", async () => {
    // Absent means "not reported" and 0 means "reported and none hit"; the
    // distinction is never collapsed (`ExtractionUsage`). One on-device
    // survivor beside two managed ones reporting 0 must not produce 0 —
    // that would assert the managed calls all missed cache while describing
    // two runs out of three. `"x" in usage`, not `toBeUndefined`: the latter
    // passes when the member vanishes from both sides.
    const consensus = consensusExtractor(
      [
        candidate(agreedFields, { calls: 1, cachedPromptTokens: 0 }),
        candidate(agreedFields, { calls: 1, cachedPromptTokens: 0 }),
        candidate(agreedFields, { calls: 1 }),
      ],
      { target },
    );

    const result = await consensus.extract(transcript);

    expect("cachedPromptTokens" in result.usage).toBe(false);
  });

  test("engine and strategy are omitted even when every survivor reported them", async () => {
    // They identify ONE producer and a consensus has several.
    const consensus = consensusExtractor(
      [
        candidate(agreedFields, { calls: 1, engine: "managed", strategy: "single-shot" }),
        candidate(agreedFields, { calls: 1, engine: "managed", strategy: "single-shot" }),
      ],
      { target },
    );

    const result = await consensus.extract(transcript);

    expect("engine" in result.usage).toBe(false);
    expect("strategy" in result.usage).toBe(false);
  });
});

describe("consensusExtractor — failure and notification", () => {
  test("below quorum throws ConsensusFailedError naming the counts, and it is not a TerminalError", async () => {
    const consensus = consensusExtractor(
      [
        candidate(agreedFields),
        rejectingCandidate(new Error("transport down")),
        rejectingCandidate(new Error("transport down")),
      ],
      { target },
    );

    const caught = await rejectionOf(consensus.extract(transcript));

    expect(caught).toBeInstanceOf(ConsensusFailedError);
    // TRANSIENT, deliberately — the opposite of `ValidationRejectedError`.
    // See the class's doc comment for both halves of the contrast.
    expect(caught).not.toBeInstanceOf(TerminalError);
    const error = caught as ConsensusFailedError;
    expect(error.survived).toBe(1);
    expect(error.required).toBe(2);
    expect(error.message).toContain("1");
    expect(error.message).toContain("2");
  });

  test("a below-quorum consensus makes a terminalFallsThrough ladder GIVE UP rather than continue", async () => {
    // The counterpart of the ladder pin `validateExtractor` already has.
    // Consensus fails because candidates failed — usually the transport —
    // and the next rung shares it, so continuing would burn it for nothing.
    const secondRung = new FakeExtractor<Fields>(agreedFields);
    const consensus = consensusExtractor(
      [candidate(agreedFields), rejectingCandidate(new Error("transport down"))],
      { target },
    );
    const ladder = fallbackExtractor<Fields>(
      [
        { strategy: "consensus", extractor: consensus },
        { strategy: "fallback", extractor: secondRung },
      ],
      terminalFallsThrough,
    );

    await expect(ladder.extract(transcript)).rejects.toBeInstanceOf(ConsensusFailedError);
    expect(secondRung.calls).toEqual([]);
  });

  test("onContested fires once per contested leaf, with the path and the samples", async () => {
    const seen: { path: LeafPath; samples: readonly Extracted<unknown>[] }[] = [];
    const dissenting: Fields = {
      heating: heating("oil", 0.8, "oil furnace"),
      hvac: agreedFields.hvac,
    };
    const consensus = consensusExtractor([candidate(agreedFields), candidate(dissenting)], {
      target,
      onContested: (path, samples) => seen.push({ path, samples }),
    });

    await consensus.extract(transcript);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.path).toEqual(["heating", "systemType"]);
    // The samples are the survivors' envelopes at that path, in survivor
    // order — the evidence the arbiter would have been handed.
    expect(seen[0]?.samples).toHaveLength(2);
    expect(seen[0]?.samples[0]?.sourceSpan).toBe("gas furnace");
    expect(seen[0]?.samples[1]?.sourceSpan).toBe("oil furnace");
  });

  test("a throwing onContested handler does not fail the run", async () => {
    // A notification must not change behaviour — including by throwing.
    const consensus = consensusExtractor([candidate(agreedFields), candidate(fourUnits)], {
      target,
      onContested: () => {
        throw new Error("handler bug");
      },
    });

    const result = await consensus.extract(transcript);

    expect(result.fields.heating.systemType.value).toBe("gas");
  });

  test("raw and statedEmptyGroups are absent even when every survivor carried them", async () => {
    // Both describe one producer's run. Keeping the first survivor's
    // `statedEmptyGroups` would hand the census a roster of "there are none
    // of these" spans no other candidate agreed to.
    const full: ExtractionResult<Fields> = {
      fields: agreedFields,
      usage: { calls: 1 },
      raw: "model output",
      statedEmptyGroups: { solar: "No solar panels were found." },
    };
    const consensus = consensusExtractor([extractorReturning(full), extractorReturning(full)], {
      target,
    });

    const result = await consensus.extract(transcript);

    expect("raw" in result).toBe(false);
    expect("statedEmptyGroups" in result).toBe(false);
  });
});

describe("consensusExtractor — construction", () => {
  test("a target with a row group throws, naming the group, before any call", async () => {
    // The walk compares per-leaf envelopes; a "row" group has none, so it
    // would compare nothing while returning a result that looks judged. The
    // refusal is `assertLeafGranularity`'s — this pins that construction runs it.
    const roomsPatch = z
      .object({
        rooms: z.array(z.object({ name: z.string().nullable().optional() }).strict()).optional(),
      })
      .strict();
    const rowTarget: ExtractionTarget<z.infer<typeof roomsPatch>, { rooms: "row" }> = {
      name: "row-target",
      extractionSchema: enveloped(roomsPatch, { provenance: { rooms: "row" } }),
      instructions: "extract the rooms",
    };
    const rowCandidate = new FakeExtractor<Enveloped<z.infer<typeof roomsPatch>, { rooms: "row" }>>(
      { rooms: [{ name: null, sourceSpan: null }] },
    );

    expect(() => consensusExtractor([rowCandidate], { target: rowTarget })).toThrow(/rooms/);
  });

  test("minSamples above the candidate count throws at construction", async () => {
    // Every run would fall below quorum — the failure is free to catch here
    // and expensive to diagnose at run time.
    expect(() =>
      consensusExtractor([candidate(agreedFields), candidate(agreedFields)], {
        target,
        minSamples: 3,
      }),
    ).toThrow(/minSamples/);
  });
});
