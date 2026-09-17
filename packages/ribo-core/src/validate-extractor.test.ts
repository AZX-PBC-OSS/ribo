import { z } from "zod";
import { describe, expect, test } from "vitest";

import { enveloped } from "./enveloped.js";
import { FakeExtractor } from "./extractor.js";
import type { Extractor, ExtractionResult, ExtractionTarget } from "./extractor.js";
import { fallbackExtractor } from "./fallback-extractor.js";
import { terminalFallsThrough } from "./arbitration.js";
import { TerminalError } from "./storage/backoff.js";
import type { AnnotatedTranscript } from "./annotated-transcript.js";
import type { GroundingCensus } from "./grounding-census.js";
import { ValidationRejectedError, validateExtractor } from "./validate-extractor.js";

/**
 * Tests for `validateExtractor` — the first judging combinator
 * (`sp2-judging-combinators-design.md` §4.2, wave-2 plan Task 2).
 *
 * The test that matters most is not the unit assertions on the error class but
 * the end-to-end one: a real `fallbackExtractor` with `terminalFallsThrough`, a
 * rejecting validated first rung and a succeeding second rung must reach the
 * second rung. That is the behaviour the design's original (backwards)
 * classification got wrong, and it is why the error extends `TerminalError` —
 * an implementation that forgets that classifies as transient by the
 * default-true rule, the ladder gives up, and this test fails.
 *
 * Identity is asserted ONLY on the direct `validateExtractor` call. The
 * arbitration engine returns a stamped shallow copy of the accepted result (it
 * rewrites `usage` to record the winning strategy), so the ladder test asserts
 * on `.fields` — chasing `toBe` there would "fix" a correct engine.
 */

const TRANSCRIPT = [
  "The heating system is a gas furnace.",
  "The attic insulation is R-38.",
  "No solar panels were found.",
].join(" ");

const transcript: AnnotatedTranscript = { text: TRANSCRIPT, annotations: {} };

const testValuesSchema = z
  .object({
    heating: z
      .object({
        systemType: z.enum(["gas", "oil", "propane"]).nullable().optional(),
        efficiency: z.number().nullable().optional(),
      })
      .strict(),
  })
  .strict();

const target: ExtractionTarget<z.infer<typeof testValuesSchema>> = {
  name: "test-target",
  extractionSchema: enveloped(testValuesSchema),
  instructions: "extract the heating fields",
};

/** A hand-built leaf envelope, the way model output arrives after parsing. */
const leaf = (value: unknown, sourceSpan: string | null) => ({
  value,
  confidence: 1,
  sourceSpan,
});

/** Every leaf committed and cited, every quote verbatim. */
const groundedFields = {
  heating: {
    systemType: leaf("gas", "gas furnace"),
    efficiency: leaf(0.8, "The attic insulation is R-38."),
  },
};

/** One leaf (efficiency) committed, cited, and quoting text absent from the transcript. */
const rejectingFields = {
  heating: {
    systemType: leaf("gas", "gas furnace"),
    efficiency: leaf(0.8, "80% AFUE"),
  },
};

/** The same shape as `groundedFields`, for the ladder's second rung. */
const secondFields = {
  heating: {
    systemType: leaf("oil", "oil furnace"),
    efficiency: leaf(0.6, "The heating system is a gas furnace."),
  },
};

/** An inner extractor returning one fixed result object — so identity is assertable. */
const extractorReturning = <F>(result: ExtractionResult<F>): Extractor<F> => ({
  extract: async () => result,
});

/** Catch the extraction's rejection, or fail the test if it did not throw. */
const rejectionOf = async (promise: Promise<unknown>): Promise<ValidationRejectedError> => {
  try {
    await promise;
  } catch (caught) {
    return caught as ValidationRejectedError;
  }
  throw new Error("expected the extraction to be rejected");
};

describe("validateExtractor — the default policy's acceptances", () => {
  test("a fully grounded result is returned untouched, by identity", async () => {
    const innerResult: ExtractionResult<typeof groundedFields> = {
      fields: groundedFields,
      usage: { calls: 1 },
    };
    const extractor = validateExtractor(extractorReturning(innerResult), { target });

    const result = await extractor.extract(transcript);

    // `toBe`, not `toEqual` — the combinator judges; it does not transform. This
    // holds on the DIRECT call only; an arbitration ladder returns a stamped
    // shallow copy, which is the engine's business and pinned nowhere here.
    expect(result).toBe(innerResult);
  });

  test("a near-miss citation is not a fabrication — no rejection", async () => {
    const fields = {
      heating: { systemType: leaf("gas", "GAS FURNACE") },
    };
    const extractor = validateExtractor(new FakeExtractor(fields), { target });
    await expect(extractor.extract(transcript)).resolves.toHaveProperty("fields", fields);
  });

  test("an honest abstention is not a rejection", async () => {
    const fields = {
      heating: { systemType: leaf(null, null), efficiency: leaf(null, null) },
    };
    const extractor = validateExtractor(new FakeExtractor(fields), { target });
    await expect(extractor.extract(transcript)).resolves.toHaveProperty("fields", fields);
  });

  test("a committed leaf with no citation at all does not throw under the default", async () => {
    // A different failure, and arguably a worse one — but the default rejects
    // exactly one thing, the thing it is named for. The census surfaces this
    // leaf; a host that wants it rejected writes four lines.
    const fields = {
      heating: { systemType: leaf("gas", null), efficiency: leaf(0.8, "gas furnace") },
    };
    const extractor = validateExtractor(new FakeExtractor(fields), { target });
    await expect(extractor.extract(transcript)).resolves.toHaveProperty("fields", fields);
  });

  test("a committed leaf with a BLANK span does not throw either — the pin on cited meaning non-blank", async () => {
    // The envelope schema legalises "" and `spanGroundedness("")` is
    // "ungrounded" — the same answer it gives for null. If `cited` meant merely
    // non-null, this leaf would be judged a fabricated citation and REJECTED,
    // while the identical null-span leaf above was tolerated. Both mean "no
    // checkable quote"; the default does not split them.
    const fields = {
      heating: { systemType: leaf("gas", ""), efficiency: leaf(0.8, "gas furnace") },
    };
    const extractor = validateExtractor(new FakeExtractor(fields), { target });
    await expect(extractor.extract(transcript)).resolves.toHaveProperty("fields", fields);
  });

  test("a grounded stated-empty group span does not throw", async () => {
    const result: ExtractionResult<typeof groundedFields> = {
      fields: groundedFields,
      usage: { calls: 1 },
      statedEmptyGroups: { solar: "No solar panels were found." },
    };
    const extractor = validateExtractor(extractorReturning(result), { target });
    await expect(extractor.extract(transcript)).resolves.toBe(result);
  });
});

describe("validateExtractor — the default policy's rejections", () => {
  test("a committed, cited, ungrounded leaf throws ValidationRejectedError", async () => {
    const extractor = validateExtractor(new FakeExtractor(rejectingFields), { target });
    const error = await rejectionOf(extractor.extract(transcript));
    expect(error).toBeInstanceOf(ValidationRejectedError);
    // The cheap declaration pin; the behaviour pin is the ladder test below.
    expect(error).toBeInstanceOf(TerminalError);
  });

  test("an ungrounded stated-empty group span throws — the same claim at group scale", async () => {
    // "There are none of these, and here is the sentence saying so" is a
    // commitment with a citation; a quote absent from the transcript makes it a
    // fabrication whether it decorates a leaf or a group.
    const result: ExtractionResult<typeof groundedFields> = {
      fields: groundedFields,
      usage: { calls: 1 },
      statedEmptyGroups: { solar: "No solar equipment of any kind was present on site." },
    };
    const extractor = validateExtractor(extractorReturning(result), { target });
    const error = await rejectionOf(extractor.extract(transcript));
    expect(error).toBeInstanceOf(ValidationRejectedError);
    expect(error.reason).toContain("solar");
  });

  test("the error carries the census and a reason naming the count and the first path", async () => {
    const fields = {
      heating: {
        systemType: leaf("gas", "gas furnace"),
        efficiency: leaf(0.8, "80% AFUE"),
        age: leaf(12, "a fabricated age"),
      },
    };
    const extractor = validateExtractor(new FakeExtractor(fields), { target });
    const error = await rejectionOf(extractor.extract(transcript));

    expect(error.census.leaves).toHaveLength(3);
    expect(error.census.counts.ungrounded).toBe(2);
    // The reason names how many leaves failed and the path of the FIRST — walk
    // order — so a log line identifies the result without the reader re-deriving
    // it. It does not enumerate the rest.
    expect(error.reason).toContain("2");
    expect(error.reason).toContain("heating.efficiency");
    expect(error.reason).not.toContain("heating.age");
  });

  test("a custom policy is consulted with the census and its rejection is honoured", async () => {
    const seen: GroundingCensus[] = [];
    const extractor = validateExtractor(new FakeExtractor(groundedFields), {
      target,
      policy: (census) => {
        seen.push(census);
        return { reject: "custom: too few citations" };
      },
    });

    const error = await rejectionOf(extractor.extract(transcript));

    expect(seen).toHaveLength(1);
    expect(seen[0]?.counts.leaves).toBe(2);
    expect(seen[0]?.counts.grounded).toBe(2);
    expect(error).toBeInstanceOf(ValidationRejectedError);
    expect(error.reason).toBe("custom: too few citations");
  });

  test("a custom policy's acceptance is honoured even over an ungrounded leaf", async () => {
    const extractor = validateExtractor(new FakeExtractor(rejectingFields), {
      target,
      policy: () => ({ ok: true }),
    });
    await expect(extractor.extract(transcript)).resolves.toHaveProperty("fields", rejectingFields);
  });
});

describe("validateExtractor — delegating discipline", () => {
  test("the inner extractor receives the caller's signal AND deadline", async () => {
    // A delegating combinator forwards the options bag whole. This repo already
    // shipped a combinator that dropped it — `fallback-extractor.test.ts`
    // carries the same pin. Without this assertion the omission typechecks and
    // every other test passes.
    const inner = new FakeExtractor(groundedFields);
    const controller = new AbortController();
    const extractor = validateExtractor(inner, { target });

    await extractor.extract(transcript, {
      signal: controller.signal,
      deadline: 1_234_567_890,
    });

    expect(inner.callOptions).toHaveLength(1);
    expect(inner.callOptions[0]?.signal).toBe(controller.signal);
    expect(inner.callOptions[0]?.deadline).toBe(1_234_567_890);
  });

  test("an inner error propagates unchanged — not converted, not swallowed", async () => {
    const sentinel = new Error("transport down");
    const extractor = validateExtractor(throwsExtractor(sentinel), { target });
    await expect(extractor.extract(transcript)).rejects.toBe(sentinel);
  });

  test("the observer sees the validated run start and settle", async () => {
    const phases: string[] = [];
    const extractor = validateExtractor(new FakeExtractor(groundedFields), {
      target,
      onUnit: (event) => {
        phases.push(event.phase);
      },
    });
    await extractor.extract(transcript);
    expect(phases).toEqual(["start", "done"]);
  });
});

describe("validateExtractor — the behaviour the error class exists for", () => {
  test("a rejecting validated rung falls through a terminalFallsThrough ladder to the second rung", async () => {
    // THE test. Asserting `instanceof TerminalError` would pin the declaration
    // and prove nothing about behaviour; this runs the rejection end to end
    // through a real fallbackExtractor. A transient classification would give
    // up here instead — the opposite of the intended behaviour.
    const ladder = fallbackExtractor<typeof secondFields>(
      [
        {
          strategy: "validated",
          extractor: validateExtractor(new FakeExtractor(rejectingFields), { target }),
        },
        { strategy: "fallback", extractor: new FakeExtractor(secondFields) },
      ],
      terminalFallsThrough,
    );

    const result = await ladder.extract(transcript);

    // Assert on `.fields`, NOT identity: the engine returns a stamped shallow
    // copy of the accepted result (usage.strategy records the winner), so `toBe`
    // against the second rung's own object fails by construction.
    expect(result.fields).toEqual(secondFields);
    expect(result.usage.strategy).toBe("fallback");
  });

  test("a TRANSIENT failure through a wrapped rung is propagated by identity — and the ladder gives up", async () => {
    // The converse, wrapped: a bare throwing fake would only re-pin the arbiter,
    // which `fallback-extractor.test.ts` already covers. Wrapping it pins the
    // additional thing — the wrapper propagates an inner error UNCHANGED — and
    // shows the transient direction does the opposite of the terminal one: no
    // fall-through, the second rung is never reached.
    const sentinel = new Error("transport down");
    const second = new FakeExtractor(secondFields);
    const ladder = fallbackExtractor<typeof secondFields>(
      [
        {
          strategy: "validated-transient",
          extractor: validateExtractor(throwsExtractor(sentinel), { target }),
        },
        { strategy: "fallback", extractor: second },
      ],
      terminalFallsThrough,
    );

    await expect(ladder.extract(transcript)).rejects.toBe(sentinel);
    expect(second.calls).toEqual([]);
  });
});

describe("validateExtractor — construction", () => {
  test("a target with a row group throws, naming the group, before any call", () => {
    // The combinator walks per-leaf envelopes; a "row" group has none, so it
    // would count nothing while returning a result that looks judged. The
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

    expect(() =>
      validateExtractor(new FakeExtractor(groundedFields), { target: rowTarget }),
    ).toThrow(/rooms/);
  });
});

// --- helpers kept below the tests they serve --------------------------------

/** An inner extractor that throws one fixed error on every call. */
function throwsExtractor(error: Error): Extractor<never> {
  return {
    extract: async () => {
      throw error;
    },
  };
}
