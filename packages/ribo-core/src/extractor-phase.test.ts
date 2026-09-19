import { expect, test } from "vitest";
import { z } from "zod";

import { enveloped } from "./enveloped.js";
import type { Enveloped, NoProvenance } from "./enveloped.js";
import type { Extractor } from "./extractor.js";
import { FakeExtractor } from "./extractor.js";
import { emptyDraft } from "./phase-draft.js";
import type { PhaseDraft } from "./phase-draft.js";
import type { PhaseItemOutcome } from "./phase-outcome.js";
import { extractorPhase } from "./extractor-phase.js";
import { validatePhases } from "./validate-phases.js";
import type { PhaseContext, PhaseDef } from "./phase.js";

// A small hand-written patch schema mirroring the real shape — one flat leaf group and
// one array-shaped collection group. Hand-written because core must not import the Snugg
// adapter.
const testValuesSchema = z.object({
  note: z.string().nullable().optional(),
  rooms: z.array(z.object({ name: z.string().nullable().optional() })).optional(),
});
type TestValues = z.infer<typeof testValuesSchema>;
type Env = Enveloped<TestValues, NoProvenance>;

const fieldsFixture: Env = {
  note: { value: "drafty", confidence: 0.9, sourceSpan: "it is drafty" },
  rooms: [{ name: { value: "kitchen", confidence: 0.8, sourceSpan: "the kitchen" } }],
};

const ctx: PhaseContext<TestValues> = {
  transcript: { text: "the attic is drafty", annotations: {} },
  target: {
    name: "test-target",
    extractionSchema: enveloped(testValuesSchema),
    instructions: "extract the note",
  },
};

// The generic fold a consumer writes (named I and C, since inside `with` they are bound
// but anonymous) — plan, run every item, fold the outcomes through merge.
const foldPhase = async <I, C>(
  def: PhaseDef<TestValues, NoProvenance, I, C>,
  draft0: PhaseDraft<TestValues, NoProvenance>,
): Promise<PhaseDraft<TestValues, NoProvenance>> => {
  const outcomes: PhaseItemOutcome<I, C>[] = [];
  for (const item of def.plan(draft0, ctx)) {
    const output = await def.run(item, draft0, ctx);
    outcomes.push({ outcome: "result", item, output });
  }
  return def.merge(draft0, outcomes);
};

test("plan returns exactly one item whatever the draft holds", () => {
  const extractor = new FakeExtractor<Env>(fieldsFixture);
  const phase = extractorPhase<TestValues>("lift", extractor);
  const empty = emptyDraft<TestValues>();
  const populated: PhaseDraft<TestValues> = {
    ...empty,
    fields: { note: { confidence: 0.5 } },
  };
  phase.with((def) => {
    expect(def.plan(empty, ctx)).toHaveLength(1);
    expect(def.plan(populated, ctx)).toHaveLength(1);
  });
});

test("run forwards both the context's signal and its deadline", async () => {
  const extractor = new FakeExtractor<Env>(fieldsFixture);
  const phase = extractorPhase<TestValues>("lift", extractor);
  const controller = new AbortController();
  const deadline = Date.now() + 60_000;
  const draft0 = emptyDraft<TestValues>();
  await phase.with(async (def) => {
    for (const item of def.plan(draft0, ctx)) {
      await def.run(item, draft0, { ...ctx, signal: controller.signal, deadline });
    }
  });
  // callOptions exists so a dropped forward is visible — assert both members arrived.
  expect(extractor.callOptions).toHaveLength(1);
  expect(extractor.callOptions[0]?.signal).toBe(controller.signal);
  expect(extractor.callOptions[0]?.deadline).toBe(deadline);
});

test("the result's usage arrives on the PhaseOutput", async () => {
  const extractor = new FakeExtractor<Env>(fieldsFixture, { usage: { calls: 2 } });
  const phase = extractorPhase<TestValues>("lift", extractor);
  const draft0 = emptyDraft<TestValues>();
  await phase.with(async (def) => {
    for (const item of def.plan(draft0, ctx)) {
      const output = await def.run(item, draft0, ctx);
      expect(output.usage).toEqual({ calls: 2 });
    }
  });
});

test("merge installs the fields into an empty draft and leaves notes untouched", async () => {
  const extractor = new FakeExtractor<Env>(fieldsFixture);
  const phase = extractorPhase<TestValues>("lift", extractor);
  const draft0 = emptyDraft<TestValues>();
  const draft1 = await phase.with((def) => foldPhase(def, draft0));
  expect(draft1.fields).toEqual(fieldsFixture);
  expect(draft1.notes).toBe(draft0.notes);
});

test("merge carries raw and statedEmptyGroups through when present, absent/empty when not", async () => {
  const draft0 = emptyDraft<TestValues>();

  // A result with a raw payload but no stated-empty record.
  const rawExtractor = new FakeExtractor<Env>(fieldsFixture, { raw: "raw output" });
  const rawPhase = extractorPhase<TestValues>("raw-lift", rawExtractor);
  const rawDraft = await rawPhase.with((def) => foldPhase(def, draft0));
  expect(rawDraft.raw).toBe("raw output");
  expect(rawDraft.statedEmptyGroups).toEqual({});

  // A result with a stated-empty record and no raw payload — hand-written, because
  // FakeExtractor has no statedEmptyGroups option.
  const emptyExtractor: Extractor<Env> = {
    extract: async () => ({
      fields: fieldsFixture,
      usage: { calls: 1 },
      statedEmptyGroups: { rooms: "no rooms mentioned" },
    }),
  };
  const emptyPhase = extractorPhase<TestValues>("empty-lift", emptyExtractor);
  const emptyDraft_ = await emptyPhase.with((def) => foldPhase(def, draft0));
  expect(emptyDraft_.statedEmptyGroups).toEqual({ rooms: "no rooms mentioned" });
  // No raw on that result → absent from the draft, not present-but-undefined.
  expect("raw" in emptyDraft_).toBe(false);
});

test("merge overwrites the keys the extractor returned, leaving the draft's other top-level keys", async () => {
  const rooms = [{ name: { value: "attic", confidence: 0.7, sourceSpan: "attic" } }];
  const draft0: PhaseDraft<TestValues> = {
    ...emptyDraft<TestValues>(),
    fields: {
      note: { value: "old", confidence: 0.1, sourceSpan: null },
      rooms,
    },
    raw: "old raw",
  };
  // The enveloped schema is closed, so the extractor's result covers every top-level
  // group key: `note` is overwritten, and so is `rooms` — wholesale, by the shallow
  // top-level assign (a deep merge would have kept the draft's array elements; it does
  // not get to). The draft's top-level members the result did NOT return — the
  // pre-existing `raw` and the `notes` bag — are left as they were.
  const noteAndEmptyRooms: Env = {
    note: { value: "new", confidence: 0.9, sourceSpan: "the note span" },
    rooms: [],
  };
  const extractor = new FakeExtractor<Env>(noteAndEmptyRooms);
  const phase = extractorPhase<TestValues>("lift", extractor);
  const draft1 = await phase.with((def) => foldPhase(def, draft0));
  expect(draft1.fields.note).toEqual({
    value: "new",
    confidence: 0.9,
    sourceSpan: "the note span",
  });
  expect(draft1.fields.rooms).toEqual([]);
  expect(draft1.raw).toBe("old raw");
  expect(draft1.notes).toBe(draft0.notes);
});

test("a phase built this way passes validatePhases as a single-element list", () => {
  const extractor = new FakeExtractor<Env>(fieldsFixture);
  const phase = extractorPhase<TestValues>("lift", extractor);
  expect(() => validatePhases<TestValues>([phase])).not.toThrow();
});

test("a lifted extractor declares seedsDraft — its merge shallow-assigns a complete result into the draft", () => {
  const extractor = new FakeExtractor<Env>(fieldsFixture);
  const phase = extractorPhase<TestValues>("lift", extractor);
  expect(phase.seedsDraft).toBe(true);
  expect(phase.requiresDraft).toBeUndefined();
});
