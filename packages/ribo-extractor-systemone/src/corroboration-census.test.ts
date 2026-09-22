import { describe, expect, test } from "vitest";
import { z } from "zod";

import { enveloped, groundingCensus } from "@azx/ribo-core";
import type {
  SystemOneAnswer,
  SystemOneAnswers,
  SystemOneClient,
  SystemOneQuestion,
  SystemOneQuestions,
} from "@azx/ribo-systemone-managed";

import { corroborationCensus } from "./corroboration-census.js";

/**
 * A fake SystemOneClient: answers each question, in arrival order across all
 * calls, with the next verdict from `verdicts`, a distinct confidence, and
 * per-verdict probabilities — recording every call so tests can assert on the
 * questions asked and on batching. Answer order is the census's committed-leaf
 * order, which the census walk fixes.
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
          confidence: 0.5 + next / 100,
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

// Built through `enveloped()` so the questions run against the REAL extraction
// envelope — the shape `enumMembersAt` reads — not a hand-rolled imitation.
const patch = z.strictObject({
  hvac: z.strictObject({
    systemType: z.enum(["furnace", "heat-pump"]).nullable().optional(),
    filterSize: z.string().nullable().optional(),
    filterMerv: z.number().nullable().optional(),
  }),
  windows: z.array(
    z.strictObject({
      glazing: z.enum(["single", "double", "triple"]).nullable().optional(),
    }),
  ),
});
const schema = enveloped(patch);

// Three committed leaves (an enum, a number, an enum inside a collection
// group) and one honest abstention, in walk order: systemType, filterSize,
// filterMerv, glazing.
const fields = {
  hvac: {
    systemType: { value: "furnace", confidence: 0.9, sourceSpan: "a gas furnace" },
    filterSize: { value: null, confidence: 1, sourceSpan: null },
    filterMerv: { value: 13, confidence: 0.7, sourceSpan: "MERV 13" },
  },
  windows: [{ glazing: { value: "triple", confidence: 0.8, sourceSpan: "triple pane" } }],
};

const transcript = "The home has a gas furnace, MERV 13 filters, and triple pane windows.";

// Lands on the committed leaves in census order: systemType → supports,
// filterMerv → contradicts, glazing → says_nothing — one leaf of each verdict.
const VERDICTS = ["supports", "contradicts", "says_nothing"] as const;

const asked = (calls: readonly FakeCall[]): SystemOneQuestion[] =>
  calls.flatMap((call) => Object.values(call.questions));

const text = (question: SystemOneQuestion): string => {
  if (question.type !== "choice")
    throw new Error(`expected a choice question, got ${question.type}`);
  return typeof question.instructions === "string" ? question.instructions : "";
};

const leafAt = <T extends { readonly path: readonly (string | number)[] }>(
  census: { readonly leaves: readonly T[] },
  path: readonly (string | number)[],
): T => {
  const leaf = census.leaves.find((entry) => JSON.stringify(entry.path) === JSON.stringify(path));
  if (leaf === undefined) throw new Error(`no leaf at ${JSON.stringify(path)}`);
  return leaf;
};

describe("corroborationCensus", () => {
  test("asks one question per committed leaf, none for a null-valued leaf, with the transcript as state", async () => {
    const { client, calls } = fakeClient(VERDICTS);
    const census = groundingCensus(fields, undefined, transcript);
    await corroborationCensus(census, fields, transcript, { client, schema });

    expect(census.counts.committed).toBe(3);
    const questions = asked(calls);
    expect(questions).toHaveLength(3);
    // The abstention is never asked about — a null value has nothing to corroborate.
    expect(questions.some((question) => text(question).includes('"filterSize"'))).toBe(false);
    // The state is the transcript text.
    expect(calls.every((call) => call.state === transcript)).toBe(true);
  });

  test("asks a choice over exactly supports, contradicts and says_nothing", async () => {
    const { client, calls } = fakeClient(VERDICTS);
    const census = groundingCensus(fields, undefined, transcript);
    await corroborationCensus(census, fields, transcript, { client, schema });

    const [question] = asked(calls);
    expect(question?.type).toBe("choice");
    if (question?.type === "choice") {
      expect(question.criteria).toEqual({
        supports: "the dictation states this value, or plainly means it",
        contradicts: "the dictation discusses this field but states a different value",
        says_nothing: "the dictation never discusses this field at all",
      });
    }
  });

  test("an enum leaf's question states its members and the encoding clause; a non-enum's has neither", async () => {
    const { client, calls } = fakeClient(VERDICTS);
    const census = groundingCensus(fields, undefined, transcript);
    await corroborationCensus(census, fields, transcript, { client, schema });

    const questions = asked(calls);
    const questionFor = (marker: string): string => {
      const question = questions.find((entry) => text(entry).includes(marker));
      if (question === undefined) throw new Error(`no question mentioning ${marker}`);
      return text(question);
    };

    const enumText = questionFor('"systemType"');
    expect(enumText).toContain(
      'The field "systemType" records exactly one of: furnace, heat-pump.',
    );
    expect(enumText).toContain(
      "The value is a code from that list, not a quote — a faithful encoding of what the " +
        "auditor said counts as supporting it.",
    );
    expect(enumText).toContain('Recorded: "systemType" = "furnace"');

    // An enum inside a collection group: the field's own name is the LAST path
    // segment, and the members come from the element schema.
    const collectionEnumText = questionFor('"glazing"');
    expect(collectionEnumText).toContain(
      'The field "glazing" records exactly one of: single, double, triple.',
    );
    expect(collectionEnumText).toContain('Recorded: "glazing" = "triple"');

    const plainText = questionFor('"filterMerv"');
    expect(plainText).not.toContain("records exactly one of");
    expect(plainText).not.toContain("heat-pump");
    expect(plainText).not.toContain("not a quote");
    expect(plainText).toContain('Recorded: "filterMerv" = 13');
  });

  test("carries the client's verdict, confidence and probabilities onto the leaf", async () => {
    const { client } = fakeClient(VERDICTS);
    const census = groundingCensus(fields, undefined, transcript);
    const result = await corroborationCensus(census, fields, transcript, { client, schema });

    const supported = leafAt(result, ["hvac", "systemType"]);
    expect(supported.verdict).toBe("supports");
    expect(supported.confidence).toBe(0.51);
    expect(supported.probabilities).toEqual({
      supports: 0.8,
      contradicts: 0.1,
      says_nothing: 0.1,
    });

    const contradicted = leafAt(result, ["hvac", "filterMerv"]);
    expect(contradicted.verdict).toBe("contradicts");
    expect(contradicted.confidence).toBe(0.52);
    expect(contradicted.probabilities).toEqual({
      supports: 0.1,
      contradicts: 0.8,
      says_nothing: 0.1,
    });
  });

  test("a leaf that was not asked about is PRESENT in the output census, carrying nulls", async () => {
    const { client } = fakeClient(VERDICTS);
    const census = groundingCensus(fields, undefined, transcript);
    const result = await corroborationCensus(census, fields, transcript, { client, schema });

    expect(result.leaves).toHaveLength(census.leaves.length);
    const abstention = leafAt(result, ["hvac", "filterSize"]);
    expect(abstention.committed).toBe(false);
    expect(abstention.verdict).toBeNull();
    expect(abstention.confidence).toBeNull();
    expect(abstention.probabilities).toBeNull();
  });

  test("counts.uncorroborated counts contradicts AND says_nothing, never supports", async () => {
    const { client } = fakeClient(VERDICTS);
    const census = groundingCensus(fields, undefined, transcript);
    const result = await corroborationCensus(census, fields, transcript, { client, schema });

    // One committed leaf of each verdict is in play: 1 would mean one failing
    // verdict was dropped, 3 that supports was counted too.
    expect(result.counts.uncorroborated).toBe(2);
    expect(result.counts.committed).toBe(3);
  });

  test("contradicts and says_nothing stay distinguishable on the returned census", async () => {
    const { client } = fakeClient(VERDICTS);
    const census = groundingCensus(fields, undefined, transcript);
    const result = await corroborationCensus(census, fields, transcript, { client, schema });

    const contradicted = leafAt(result, ["hvac", "filterMerv"]);
    const unmentioned = leafAt(result, ["windows", 0, "glazing"]);
    expect(contradicted.verdict).toBe("contradicts");
    expect(unmentioned.verdict).toBe("says_nothing");
    expect(contradicted.verdict).not.toBe(unmentioned.verdict);
  });

  test("more leaves than batchSize split across requests; every leaf asked exactly once", async () => {
    const { client, calls } = fakeClient(VERDICTS);
    const census = groundingCensus(fields, undefined, transcript);
    const result = await corroborationCensus(census, fields, transcript, {
      client,
      schema,
      batchSize: 2,
    });

    expect(calls).toHaveLength(2);
    expect(Object.keys(calls[0]?.questions ?? {})).toHaveLength(2);
    expect(Object.keys(calls[1]?.questions ?? {})).toHaveLength(1);
    // Exactly once across requests: no id repeats, no leaf left unanswered.
    const ids = calls.flatMap((call) => Object.keys(call.questions));
    expect(new Set(ids).size).toBe(3);
    expect(result.leaves.filter((leaf) => leaf.verdict !== null)).toHaveLength(3);
    expect(result.counts.uncorroborated).toBe(2);
  });
});
