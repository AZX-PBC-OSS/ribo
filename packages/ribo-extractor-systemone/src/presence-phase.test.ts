import { describe, expect, test } from "vitest";
import { z } from "zod";

import { demandNote, emptyDraft, enveloped, nullEnvelope, presenceNoteKey } from "@azx/ribo-core";
import type { ExtractionTarget, PhaseContext, PhaseDraft, PresenceMaps } from "@azx/ribo-core";
import type {
  SystemOneAnswer,
  SystemOneAnswers,
  SystemOneClient,
  SystemOneQuestions,
} from "@azx/ribo-systemone-managed";

import { systemOnePresencePhase } from "./presence-phase.js";

/**
 * Phase-level tests for the System One presence phase, against hand-built
 * drafts — the engine is not involved, so `plan`/`run`/`merge` are driven
 * directly through the phase's `with` (the same fold core's
 * `presence-phase.test.ts` uses).
 */

/** A fake SystemOneClient: answers every noul question with `probabilityOf(id)`, recording every call. */
interface FakeCall {
  readonly state: string;
  readonly questions: SystemOneQuestions;
}

const fakeClient = (
  probabilityOf: (id: string) => number,
): { client: SystemOneClient; calls: FakeCall[] } => {
  const calls: FakeCall[] = [];
  const client: SystemOneClient = {
    ask: async <Q extends SystemOneQuestions>(
      state: string,
      questions: Q,
    ): Promise<SystemOneAnswers<Q>> => {
      calls.push({ state, questions });
      const answers: Record<string, SystemOneAnswer> = {};
      for (const id of Object.keys(questions)) {
        answers[id] = { type: "noul", noul: probabilityOf(id) };
      }
      return answers as unknown as SystemOneAnswers<Q>;
    },
  };
  return { client, calls };
};

/** A two-group flat extraction target, the same shape core's presence suite uses. */
const patch = z.strictObject({
  hvac: z
    .strictObject({
      fuel: z.enum(["Oil", "Gas"]).nullable().optional(),
      efficiency: z.number().nullable().optional(),
      notes: z.string().nullable().optional(),
    })
    .optional(),
  site: z.strictObject({ yearBuilt: z.number().nullable().optional() }).optional(),
});

const schema = enveloped(patch);
type Values = z.infer<typeof patch>;

const target: ExtractionTarget<Values> = {
  name: "systemone-presence-test",
  extractionSchema: schema,
  instructions: "Extract the fields from the transcript.",
  examples: [],
};

const ctx: PhaseContext<Values> = {
  transcript: { text: "the system is gas", annotations: {} },
  target,
};

/** Plan, run every item, fold through merge — with the questions each leaf scored. */
async function fold(
  probabilityOf: (id: string) => number,
  options: { threshold?: number; batchSize?: number } = {},
): Promise<{ merged: PhaseDraft<Values>; calls: FakeCall[] }> {
  const { client, calls } = fakeClient(probabilityOf);
  const phase = systemOnePresencePhase<Values>({ client, schema, ...options });
  const draft = emptyDraft<Values>();
  return phase.with(async (def) => {
    const outcomes = [];
    for (const item of def.plan(draft, ctx)) {
      outcomes.push({
        outcome: "result" as const,
        item,
        output: await def.run(item, draft, ctx),
      });
    }
    return { merged: def.merge(draft, outcomes), calls };
  });
}

const leafPaths = (calls: readonly FakeCall[]): string[] =>
  calls.flatMap((call) => Object.keys(call.questions));

describe("systemOnePresencePhase — thresholding", () => {
  test("a leaf above the threshold is true in the map; one below is false", async () => {
    const { merged, calls } = await fold((id) => (id === "hvac.fuel" ? 0.9 : 0.1), {
      threshold: 0.5,
    });
    expect(merged.notes.get(presenceNoteKey)).toEqual({
      hvac: { fuel: true, efficiency: false, notes: false },
      site: { yearBuilt: false },
    });
    // The state is the transcript text, and every question is a noul — the
    // answer's `noul` member is the probability of yes the threshold reads.
    expect(calls[0]?.state).toBe("the system is gas");
    expect(calls[0]?.questions["hvac.fuel"]?.type).toBe("noul");
  });
});

describe("systemOnePresencePhase — the question", () => {
  // A bare wire path like "dhw.dhwType2" names nothing a model can match against speech: spike
  // 0012 measured the shipped question dropping 21 of 21 such leaves below the threshold, and
  // every one cleared it once the leaf's members were stated.
  test("an enum leaf's question names its members; a non-enum leaf's does not", async () => {
    const { calls } = await fold(() => 0.9);
    const fuel = calls[0]?.questions["hvac.fuel"]?.instructions;
    expect(fuel).toContain('"Oil"');
    expect(fuel).toContain('"Gas"');
    expect(calls[0]?.questions["hvac.efficiency"]?.instructions).not.toContain("one of");
  });

  // "No safety tests" asserts every test was not done without naming one. A question that only
  // counts an explicit discussion of the field scored those leaves absent, so the fill was never
  // asked and the stated "not done" came back null (spike 0012, transcripts 11 and 14).
  test("the question counts a stated decline, including one covering a set of fields", async () => {
    const { calls } = await fold(() => 0.9);
    const question = calls[0]?.questions["hvac.fuel"]?.instructions;
    expect(question).toMatch(/not done/);
    expect(question).toMatch(/as part of a set/);
  });

  test("a collection group's enum leaf names its members too", async () => {
    // A collection's leaves sit under the array's element schema, so the member lookup has to
    // step through the element; an object-only walk finds nothing here and asks the bare path.
    const collection = enveloped(
      z.strictObject({
        heaters: z
          .array(z.strictObject({ kind: z.enum(["Tank", "Tankless"]).nullable().optional() }))
          .optional(),
      }),
    );
    const { client, calls } = fakeClient(() => 0.9);
    const phase = systemOnePresencePhase({ client, schema: collection });
    await phase.with(async (def) => {
      const draft = emptyDraft();
      for (const item of def.plan(draft, ctx)) await def.run(item, draft, ctx);
    });
    const kind = calls[0]?.questions["heaters.kind"]?.instructions;
    expect(kind).toContain('"Tank"');
    expect(kind).toContain('"Tankless"');
  });
});

describe("systemOnePresencePhase — the seed", () => {
  // Written FIRST of the suite: the regression the seed exists to prevent is
  // silent — a missing group key surfaces only as the closing trust-boundary
  // parse rejecting the whole result, after every call has been paid for.
  test("a group whose every leaf scores below the threshold STILL appears in the fields, nulled per leaf", async () => {
    const { merged } = await fold(() => 0);
    expect(merged.fields.site?.yearBuilt).toEqual(nullEnvelope());
    expect(merged.fields.hvac?.fuel).toEqual(nullEnvelope());
    expect(merged.fields.hvac?.efficiency).toEqual(nullEnvelope());
    expect(merged.fields.hvac?.notes).toEqual(nullEnvelope());
    // The all-false map is still written — a later phase's plan demands it.
    expect(merged.notes.get(presenceNoteKey)).toEqual({
      hvac: { fuel: false, efficiency: false, notes: false },
      site: { yearBuilt: false },
    });
  });

  test("a FAILED batch seeds its groups too — failed items contribute no map, never a missing group", async () => {
    // batchSize 3 puts all three hvac leaves in the first batch and site's one
    // leaf in the second; the first ask throws, so the engine's skip policy
    // hands merge an error outcome for that batch — the fold below reproduces
    // exactly that shape. The seed must still cover hvac: three null
    // envelopes, and site's successful map beside them.
    let firstCall = true;
    const { client } = fakeClient(() => 0.9);
    const throwing: SystemOneClient = {
      ask: async (...args) => {
        if (firstCall) {
          firstCall = false;
          throw new Error("the transport is down");
        }
        return client.ask(...args);
      },
    };
    const phase = systemOnePresencePhase<Values>({ client: throwing, schema, batchSize: 3 });
    const draft = emptyDraft<Values>();
    const merged = await phase.with(async (def) => {
      const outcomes = [];
      for (const item of def.plan(draft, ctx)) {
        try {
          outcomes.push({
            outcome: "result" as const,
            item,
            output: await def.run(item, draft, ctx),
          });
        } catch (error) {
          outcomes.push({ outcome: "error" as const, item, error });
        }
      }
      return def.merge(draft, outcomes);
    });
    expect(merged.fields.hvac?.fuel).toEqual(nullEnvelope());
    expect(merged.fields.hvac?.efficiency).toEqual(nullEnvelope());
    expect(merged.fields.hvac?.notes).toEqual(nullEnvelope());
    expect(merged.fields.site?.yearBuilt).toEqual(nullEnvelope());
    // The failed batch's leaves are absent from the map; the successful one is there.
    expect(merged.notes.get(presenceNoteKey)).toEqual({ site: { yearBuilt: true } });
  });
});

describe("systemOnePresencePhase — the note key", () => {
  test("the map reads back through core's demandNote under core's presenceNoteKey", async () => {
    const { merged } = await fold((id) => (id === "site.yearBuilt" ? 0.9 : 0));
    const maps: PresenceMaps = demandNote(
      merged.notes,
      presenceNoteKey,
      "systemone-presence-test",
      "presence",
    );
    expect(maps).toEqual({
      hvac: { fuel: false, efficiency: false, notes: false },
      site: { yearBuilt: true },
    });
  });
});

describe("systemOnePresencePhase — plan", () => {
  test("is never empty, and ignores the draft — even when the fake scores everything zero", () => {
    const { client } = fakeClient(() => 0);
    const phase = systemOnePresencePhase<Values>({ client, schema });
    phase.with((def) => {
      // A draft that already holds fields — plan has nothing to narrow against.
      const filled = {
        ...emptyDraft<Values>(),
        fields: { site: { yearBuilt: { value: 1950, confidence: 1, sourceSpan: "1950" } } },
      } as PhaseDraft<Values>;
      for (const draft of [emptyDraft<Values>(), filled]) {
        const items = def.plan(draft, ctx);
        expect(items.length).toBeGreaterThan(0);
      }
    });
  });

  test("batches every leaf into one request by default, and by batchSize when set", () => {
    const { client } = fakeClient(() => 0);
    const unbatched = systemOnePresencePhase<Values>({ client, schema });
    const batched = systemOnePresencePhase<Values>({ client, schema, batchSize: 2 });
    const draft = emptyDraft<Values>();
    unbatched.with((def) => {
      // Four leaves, no batchSize — every leaf of every group in one request.
      expect(def.plan(draft, ctx)).toHaveLength(1);
    });
    batched.with((def) => {
      // …and two batches of two when the size says so.
      expect(def.plan(draft, ctx)).toHaveLength(2);
    });
  });
});

describe("systemOnePresencePhase — batching", () => {
  test("leaves beyond batchSize are split across requests, and every leaf appears in the map exactly once", async () => {
    const { merged, calls } = await fold(
      (id) => (id === "hvac.fuel" || id === "site.yearBuilt" ? 0.9 : 0),
      { batchSize: 2 },
    );
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(Object.keys(call.questions)).toHaveLength(2);
    // No leaf asked twice across the split.
    expect(leafPaths(calls).sort()).toEqual([
      "hvac.efficiency",
      "hvac.fuel",
      "hvac.notes",
      "site.yearBuilt",
    ]);
    // …and the merged map carries each leaf exactly once, thresholded per answer.
    expect(merged.notes.get(presenceNoteKey)).toEqual({
      hvac: { fuel: true, efficiency: false, notes: false },
      site: { yearBuilt: true },
    });
  });
});

describe("systemOnePresencePhase — the array wrap", () => {
  test("a collection group's entry is a one-element array; an object group's is the bare map", async () => {
    const arrayPatch = z.strictObject({
      hvac: z.array(z.strictObject({ fuel: z.enum(["Oil", "Gas"]).nullable().optional() })),
      site: z.strictObject({ yearBuilt: z.number().nullable().optional() }).optional(),
    });
    const arraySchema = enveloped(arrayPatch);
    type ArrayValues = z.infer<typeof arrayPatch>;
    const arrayTarget: ExtractionTarget<ArrayValues> = {
      name: "systemone-presence-array-test",
      extractionSchema: arraySchema,
      instructions: "Extract the fields from the transcript.",
      examples: [],
    };
    const arrayCtx: PhaseContext<ArrayValues> = {
      transcript: { text: "the system is gas", annotations: {} },
      target: arrayTarget,
    };
    const { client } = fakeClient(() => 0);
    const phase = systemOnePresencePhase<ArrayValues>({ client, schema: arraySchema });
    const merged = await phase.with(async (def) => {
      const draft = emptyDraft<ArrayValues>();
      const outcomes = [];
      for (const item of def.plan(draft, arrayCtx)) {
        outcomes.push({
          outcome: "result" as const,
          item,
          output: await def.run(item, draft, arrayCtx),
        });
      }
      return def.merge(draft, outcomes);
    });
    expect(merged.fields.hvac).toEqual([{ fuel: nullEnvelope() }]);
    expect(merged.fields.site).toEqual({ yearBuilt: nullEnvelope() });
  });
});

describe("systemOnePresencePhase — the default threshold", () => {
  test("is below 0.3 — a leaf scored 0.25 counts as present under the default", async () => {
    // The pin: the measured boundary for the LOWEST correctly-present leaf sat
    // at 0.3 with no margin, so the default must stay below it. Raising the
    // default to 0.3 or 0.5 turns this false — a loud failure, not silent loss.
    const { merged } = await fold((id) => (id === "site.yearBuilt" ? 0.25 : 0));
    const maps = merged.notes.get(presenceNoteKey);
    expect(maps?.site?.yearBuilt).toBe(true);
  });

  test("an explicit threshold the measurement rejected does drop the leaf — the pin can tell the difference", async () => {
    const { merged } = await fold((id) => (id === "site.yearBuilt" ? 0.25 : 0), {
      threshold: 0.5,
    });
    const maps = merged.notes.get(presenceNoteKey);
    expect(maps?.site?.yearBuilt).toBe(false);
  });
});

describe("systemOnePresencePhase — metadata", () => {
  test("defaults the id to presence and honours an explicit one", () => {
    const { client } = fakeClient(() => 0);
    expect(systemOnePresencePhase<Values>({ client, schema }).id).toBe("presence");
    expect(systemOnePresencePhase<Values>({ client, schema, id: "presence-2" }).id).toBe(
      "presence-2",
    );
  });

  test("a caller's requires is taken as the requires — the phase has no default to replace", () => {
    const { client } = fakeClient(() => 0);
    const phase = systemOnePresencePhase<Values>({ client, schema, requires: ["mine"] });
    expect(phase.requires).toEqual(["mine"]);
  });
});
