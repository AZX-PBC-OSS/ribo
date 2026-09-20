import { expect, test } from "vitest";
import { z } from "zod";

import { enveloped } from "./enveloped.js";
import type { NoProvenance } from "./enveloped.js";
import type { ExtractionTarget } from "./extractor.js";
import { noteKey } from "./phase-notes.js";
import { emptyDraft } from "./phase-draft.js";
import type { PhaseDraft } from "./phase-draft.js";
import type { PhaseItemOutcome } from "./phase-outcome.js";
import { phaseBuilder } from "./phase.js";
import type { PhaseContext, PhaseDef, PhaseMeta } from "./phase.js";

// A tiny hand-written patch V and its enveloped extraction shape — the phase context's
// target needs a real one. No adapter types: core must not depend on any adapter.
const testValuesSchema = z.object({ note: z.string().nullable().optional() });
type TestValues = z.infer<typeof testValuesSchema>;

const target: ExtractionTarget<TestValues> = {
  name: "test-target",
  extractionSchema: enveloped(testValuesSchema),
  instructions: "extract the note",
};

const ctx: PhaseContext<TestValues> = {
  transcript: { text: "the attic is drafty", annotations: {} },
  target,
};

const truthsKey = noteKey<unknown>("truths");
const sumKey = noteKey<unknown>("sum");

// Two hand-written phases over the same V: one whose items are `string` and contribution
// `boolean`, one whose items are `number` and contribution `number`. Built with no type
// arguments at the inner call — `phaseBuilder<V, P>()` fixed V and P, and `I`/`C` are
// inferred from each definition. Each `merge` interprets its own outcomes (where `I` and
// `C` are named), which is what the fold below asserts on.
const build = phaseBuilder<TestValues, NoProvenance>();

const stringPhase = build({
  id: "strings",
  plan: () => ["alpha", "ab"],
  run: async (item) => ({ value: item.length > 3 }),
  merge: (draft, results) => {
    const truths = results.filter((r) => r.outcome === "result" && r.output.value).length;
    return { ...draft, notes: draft.notes.set(truthsKey, truths) };
  },
});

const numberPhase = build({
  id: "numbers",
  plan: () => [1, 2, 3],
  run: async (item) => ({ value: item * 2 }),
  merge: (draft, results) => {
    let sum = 0;
    for (const r of results) {
      if (r.outcome === "result") sum += r.output.value;
    }
    return { ...draft, notes: draft.notes.set(sumKey, sum) };
  },
});

// How a consumer folds one phase: a GENERIC callback (Rank-2), because inside `with` the
// item and contribution types are bound but anonymous — a consumer that needs to name
// them (to build a `PhaseItemOutcome<I, C>[]`) declares them. This is the shape the Wave
// 3b engine's scheduling loop will use.
const runAll = async <I, C>(
  def: PhaseDef<TestValues, NoProvenance, I, C>,
): Promise<PhaseDraft<TestValues, NoProvenance>> => {
  const draft0 = emptyDraft<TestValues, NoProvenance>();
  const outcomes: PhaseItemOutcome<I, C>[] = [];
  for (const item of def.plan(draft0, ctx)) {
    const output = await def.run(item, draft0, ctx);
    outcomes.push({ outcome: "result", item, output });
  }
  return def.merge(draft0, outcomes);
};

// ---------------------------------------------------------------------------
// Value-level: a phase's own functions come back through `with` and behave
// ---------------------------------------------------------------------------

test("plan on an empty draft, each item through run, the outcomes folded through merge", async () => {
  // The string phase: "alpha" (5 chars → true) and "ab" (2 chars → false). The merge saw
  // both outcomes, read each contribution, and recorded one truth.
  const draft1 = await stringPhase.with(runAll);
  expect(draft1.notes.get(truthsKey)).toBe(1);
  // And the callback's R escaped `with` as the draft it is.
  expect(draft1.fields).toEqual({});
  expect(draft1.statedEmptyGroups).toEqual({});
});

test("the number phase's plan, run and merge behave through the same generic fold", async () => {
  const draft1 = await numberPhase.with(runAll);
  // (1 + 2 + 3) * 2 — run's contributions, summed by the phase's own merge.
  expect(draft1.notes.get(sumKey)).toBe(12);
});

test("describeItem, when supplied, returns its key and leaf for a planned item", () => {
  const draft0 = emptyDraft<TestValues, NoProvenance>();
  const described = build({
    id: "described",
    plan: () => ["item-a"],
    run: async () => ({ value: true }),
    merge: (draft) => draft,
    describeItem: (item) => ({ key: item, leaf: "note" }),
  });
  described.with((def) => {
    for (const item of def.plan(draft0, ctx)) {
      expect(def.describeItem?.(item)).toEqual({ key: "item-a", leaf: "note" });
    }
  });
});

test("a phase that omits describeItem is still a valid Phase", () => {
  // Optionality is the pin: if `describeItem` were required, this construction would not
  // compile. The combinator's `""` default for a missing one is Wave 3b's concern.
  const bare = build({
    id: "bare",
    plan: () => [],
    run: async () => ({ value: 1 }),
    merge: (draft) => draft,
  });
  expect(bare.id).toBe("bare");
});

// The note-channel declarations are asserted through `phaseBuilder`, never an object
// literal: the builder copies the metadata member-by-member, so a member missing from
// that copy list reads `undefined` off every real phase (which is every real
// construction) while a literal-based test would still see it. The validator and the
// planner read the metadata off the constructed `Phase` — that is why this is the
// construction that matters.
test("a builder-constructed phase exposes requires and produces as declared", () => {
  const requirer = build({
    id: "requirer",
    requires: ["roster"],
    produces: ["spans"],
    plan: () => [],
    run: async () => ({ value: 1 }),
    merge: (draft) => draft,
  });
  expect(requirer.requires).toEqual(["roster"]);
  expect(requirer.produces).toEqual(["spans"]);
});

test("a phase declaring neither note-channel member reads undefined for both", () => {
  // `undefined` reads as "declares nothing" downstream — every fixture that declares
  // neither must keep validating unchanged.
  expect(stringPhase.requires).toBeUndefined();
  expect(stringPhase.produces).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Type-level
// ---------------------------------------------------------------------------
//
// Enforced by `tsc` (`pnpm --filter @azx/ribo-core typecheck`), not by the Vitest run —
// esbuild strips types without checking them. Each `@ts-expect-error` below is itself the
// assertion: if the error it expects ever stops happening, tsc fails with "Unused
// '@ts-expect-error' directive" (TS2578). See extraction-observer.test.ts for the house
// pattern.

test("one phase's items cannot feed another phase's run", () => {
  const draft0 = emptyDraft<TestValues, NoProvenance>();
  numberPhase.with((numDef) => {
    for (const item of numDef.plan(draft0, ctx)) {
      stringPhase.with((strDef) => {
        // Inside `with` the item type is bound but opaque: the only items that can
        // reach this phase's `run` are the ones this phase's own `plan` produced.
        // That is the whole point of the encoding — if it ever compiles (an erasing
        // cast, a loosened `I`), tsc fails with TS2578.
        // @ts-expect-error — the number phase's items are not the string phase's.
        void strDef.run(item, draft0, ctx);
      });
    }
  });
});

test("no literal can be passed to run either — only this phase's planned items", () => {
  const draft0 = emptyDraft<TestValues, NoProvenance>();
  stringPhase.with((def) => {
    for (const item of def.plan(draft0, ctx)) {
      // The positive control: plan's own output feeds run without a cast.
      void def.run(item, draft0, ctx);
    }
    // @ts-expect-error — a literal is not provably this phase's item type: the bound
    // `I` is opaque, so even a plausible item value does not assign.
    void def.run("alpha", draft0, ctx);
  });
});

test("PhaseMeta is readable off a Phase without calling with", () => {
  // The construction-time validator (Task 5) and a later planner read a phase list's
  // metadata without entering `with` — this assignment is what makes that possible.
  const meta: PhaseMeta = stringPhase;
  expect(meta.id).toBe("strings");
  expect(meta.requires).toBeUndefined();
  expect(meta.produces).toBeUndefined();
});
