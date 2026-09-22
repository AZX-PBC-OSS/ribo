import { describe, expect, test } from "vitest";
import { z } from "zod";

import { enveloped, FakeExtractor, TerminalError } from "@azx/ribo-core";
import type {
  AnnotatedTranscript,
  Extractor,
  ExtractionResult,
  ExtractionTarget,
} from "@azx/ribo-core";
import type {
  SystemOneAnswer,
  SystemOneAnswers,
  SystemOneClient,
  SystemOneQuestions,
} from "@azx/ribo-systemone-managed";

import { corroborateExtractor, rejectUncorroboratedCommitments } from "./corroborate-extractor.js";
import { CorroborationRejectedError } from "./corroborate-extractor.js";
import type { CorroborationPolicy } from "./corroborate-extractor.js";

/**
 * Tests for `corroborateExtractor` — the second judging combinator (ADR 0017).
 *
 * The pins that matter most, in the order the file asserts them: identity on a
 * pass (the combinator judges, it does not transform); terminal on a rejection
 * (so the shipped default arbiter falls through — the opposite classification
 * is a full-price retry loop, per `validate-extractor.ts`'s header); ratio, not
 * per-leaf (ADR 0017's measured finding — per-leaf scores land on both sides of
 * any threshold, so a single `contradicts` in a large result must not gate);
 * construction-time granularity refusal (ADR 0003); and the two propagation
 * directions — an inner transient stays transient, a client failure is not a
 * rejection.
 */

const TRANSCRIPT = [
  "The home has a gas furnace with MERV 13 filters, maybe twelve years old.",
  "The envelope is sealed and there is an ecobee thermostat.",
].join(" ");

const transcript: AnnotatedTranscript = { text: TRANSCRIPT, annotations: {} };

const patch = z.strictObject({
  hvac: z.strictObject({
    systemType: z.enum(["furnace", "heat-pump"]).nullable().optional(),
    filterMerv: z.number().nullable().optional(),
    age: z.number().nullable().optional(),
  }),
  envelope: z.enum(["sealed", "not-sealed"]).nullable().optional(),
  thermostat: z.string().nullable().optional(),
});

const target: ExtractionTarget<z.infer<typeof patch>> = {
  name: "test-target",
  extractionSchema: enveloped(patch),
  instructions: "extract the fields",
};

// Built through `enveloped()` so the census's questions run against the REAL
// extraction envelope — the shape `enumMembersAt` reads.
const rowPatch = z.strictObject({
  rooms: z.array(z.strictObject({ name: z.string().nullable().optional() })).optional(),
});

const rowTarget: ExtractionTarget<z.infer<typeof rowPatch>, { rooms: "row" }> = {
  name: "row-target",
  extractionSchema: enveloped(rowPatch, { provenance: { rooms: "row" } }),
  instructions: "extract the rooms",
};

/** A hand-built leaf envelope, the way model output arrives after parsing. */
const leaf = (value: unknown, sourceSpan: string | null) => ({
  value,
  confidence: 1,
  sourceSpan,
});

// Five committed leaves, every quote verbatim — large enough that one bad leaf
// sits inside any sane ratio, which is the point of ADR 0017's aggregate rule.
const supportedFields = {
  hvac: {
    systemType: leaf("furnace", "a gas furnace"),
    filterMerv: leaf(13, "MERV 13"),
    age: leaf(12, "maybe twelve years old"),
  },
  envelope: leaf("sealed", "The envelope is sealed"),
  thermostat: leaf("ecobee", "an ecobee thermostat"),
};

/**
 * A fake SystemOneClient: answers each question, in arrival order across all
 * calls, with the next verdict from `verdicts` (defaulting to `supports`).
 * Verdict order is the census's committed-leaf walk order, which the schema
 * above fixes: systemType, filterMerv, age, envelope, thermostat.
 */
interface FakeCall {
  readonly state: string;
  readonly questions: SystemOneQuestions;
}

const fakeClient = (
  verdicts: readonly string[],
): { client: SystemOneClient; calls: FakeCall[] } => {
  const calls: FakeCall[] = [];
  let next = 0;
  const client: SystemOneClient = {
    ask: async <Q extends SystemOneQuestions>(
      state: string,
      questions: Q,
    ): Promise<SystemOneAnswers<Q>> => {
      calls.push({ state, questions });
      const answers: Record<string, SystemOneAnswer> = {};
      for (const id of Object.keys(questions)) {
        const verdict = verdicts[next] ?? "supports";
        next += 1;
        answers[id] = {
          type: "choice",
          choice: verdict,
          confidence: 0.9,
          probabilities: {
            supports: verdict === "supports" ? 0.8 : 0.1,
            contradicts: verdict === "contradicts" ? 0.8 : 0.1,
            says_nothing: verdict === "says_nothing" ? 0.8 : 0.1,
          },
        };
      }
      return answers as unknown as SystemOneAnswers<Q>;
    },
  };
  return { client, calls };
};

/** A client whose transport is down — every `ask` throws. */
const failingClient = (error: Error): SystemOneClient => ({
  ask: async () => {
    throw error;
  },
});

/** An inner extractor returning one fixed result object — so identity is assertable. */
const extractorReturning = <F>(result: ExtractionResult<F>): Extractor<F> => ({
  extract: async () => result,
});

/** An inner extractor that throws one fixed error on every call. */
const throwsExtractor = (error: Error): Extractor<never> => ({
  extract: async () => {
    throw error;
  },
});

/** Catch the extraction's failure, or fail the test if it did not throw. */
const failureOf = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (caught) {
    return caught;
  }
  throw new Error("expected the extraction to fail");
};

describe("corroborateExtractor — acceptance", () => {
  test("a passing result is returned untouched, BY IDENTITY", async () => {
    // `toBe`, not `toEqual` — the combinator judges; it does not transform. An
    // implementation that rebuilt the result object would pass a deep-equality
    // assertion and quietly break envelope identity for everything downstream.
    const innerResult: ExtractionResult<typeof supportedFields> = {
      fields: supportedFields,
      usage: { calls: 1 },
    };
    const { client } = fakeClient([]);
    const extractor = corroborateExtractor(extractorReturning(innerResult), {
      target,
      client,
      policy: rejectUncorroboratedCommitments(0.25),
    });

    const result = await extractor.extract(transcript);

    expect(result).toBe(innerResult);
  });

  test("a single contradicts leaf in a large result does NOT reject while the ratio is not exceeded", async () => {
    // THE measured finding of ADR 0017, made executable: per-leaf scores are
    // too inconsistent to gate on — identical mappings landed on both sides of
    // any threshold — so the policy thresholds a RATIO of committed leaves. An
    // implementation that rejected on any single bad leaf fails here.
    const { client } = fakeClient(["contradicts"]);
    const extractor = corroborateExtractor(new FakeExtractor(supportedFields), {
      target,
      client,
      policy: rejectUncorroboratedCommitments(0.25),
    });

    // 1 of 5 committed = 0.2, below 0.25 — accepted, fields untouched.
    await expect(extractor.extract(transcript)).resolves.toHaveProperty("fields", supportedFields);
  });
});

describe("corroborateExtractor — rejection", () => {
  test("a rejected result throws an error that IS an instance of core's TerminalError", async () => {
    // The cheap declaration pin; the behaviour pin is the shipped default
    // arbiter's `terminalFallsThrough`, which falls through on exactly this
    // class. A transient classification would make the ladder give up and the
    // relay re-run the hallucinating rung on backoff until `dead`.
    const { client } = fakeClient(["contradicts"]);
    const extractor = corroborateExtractor(new FakeExtractor(supportedFields), {
      target,
      client,
      policy: rejectUncorroboratedCommitments(0.1),
    });

    const caught = await failureOf(extractor.extract(transcript));

    expect(caught).toBeInstanceOf(CorroborationRejectedError);
    expect(caught).toBeInstanceOf(TerminalError);
  });

  test("the rejection reason names the uncorroborated count and the ratio", async () => {
    // A log line must identify the result without the reader re-deriving it —
    // the same register as `rejectUngroundedCommitments`' reason.
    const { client } = fakeClient(["contradicts", "says_nothing"]);
    const extractor = corroborateExtractor(new FakeExtractor(supportedFields), {
      target,
      client,
      policy: rejectUncorroboratedCommitments(0.1),
    });

    const caught = await failureOf(extractor.extract(transcript));

    expect(caught).toBeInstanceOf(CorroborationRejectedError);
    const error = caught as CorroborationRejectedError;
    expect(error.census.counts.uncorroborated).toBe(2);
    expect(error.census.counts.committed).toBe(5);
    expect(error.reason).toContain("2");
    expect(error.reason).toContain("0.1");
  });
});

describe("corroborateExtractor — construction", () => {
  test("a row-provenance target throws at CONSTRUCTION, before any extract call is made", () => {
    // The combinator walks per-leaf envelopes; a "row" group has none, so it
    // would count nothing while returning a result that looks judged (ADR
    // 0003). The refusal is `assertLeafGranularity`'s — this pins that
    // construction runs it, and that nothing is asked of the client or the
    // inner extractor first.
    const inner = new FakeExtractor(supportedFields);
    const { client, calls } = fakeClient([]);

    expect(() =>
      corroborateExtractor(inner, {
        target: rowTarget,
        client,
        policy: rejectUncorroboratedCommitments(0.1),
      }),
    ).toThrow(/rooms/);
    expect(inner.calls).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});

describe("corroborateExtractor — propagation discipline", () => {
  test("an inner transient failure propagates unchanged — NOT converted, NOT terminal", async () => {
    // A transient inner failure must stay transient so an arbiter gives up
    // rather than trying the next rung on the same downed transport, and a
    // cancellation must stay a cancellation. No try/catch surrounds the inner
    // call — this pins that.
    const sentinel = new Error("transport down");
    const { client } = fakeClient([]);
    const extractor = corroborateExtractor(throwsExtractor(sentinel), {
      target,
      client,
      policy: rejectUncorroboratedCommitments(0.1),
    });

    const caught = await failureOf(extractor.extract(transcript));

    expect(caught).toBe(sentinel);
    expect(caught).not.toBeInstanceOf(CorroborationRejectedError);
    expect(caught).not.toBeInstanceOf(TerminalError);
  });

  test("a client transport failure propagates and does NOT become a rejection", async () => {
    // The census's verification call is I/O of the combinator's own, and it
    // fails like any transport: the failure is the transport's, not a verdict
    // about the result, so it propagates as-is for the arbiter to classify.
    const boom = new Error("proxy 503");
    const extractor = corroborateExtractor(new FakeExtractor(supportedFields), {
      target,
      client: failingClient(boom),
      policy: rejectUncorroboratedCommitments(0.1),
    });

    const caught = await failureOf(extractor.extract(transcript));

    expect(caught).toBe(boom);
    expect(caught).not.toBeInstanceOf(CorroborationRejectedError);
  });
});

describe("rejectUncorroboratedCommitments — the ratio", () => {
  test("a ratio is REQUIRED — there is no default to inherit", () => {
    // ADR 0017: nothing measured justifies a number, and a wrong default fails
    // silently in both directions. The directive is the pin: deleting the
    // requirement turns the call valid, the directive goes unmet, and the
    // BUILD fails rather than a default arriving silently.
    // @ts-expect-error — the ratio is REQUIRED; there is no default to inherit.
    const policy: CorroborationPolicy = rejectUncorroboratedCommitments();
    expect(typeof policy).toBe("function");
  });
});
