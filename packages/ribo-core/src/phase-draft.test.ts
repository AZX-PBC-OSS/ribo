import { expect, test } from "vitest";

import type { Enveloped, NoProvenance } from "./enveloped.js";
import { emptyNotes } from "./phase-notes.js";
import { emptyDraft } from "./phase-draft.js";
import type { DeepPartial, PhaseDraft } from "./phase-draft.js";

// A small hand-written patch V mirroring the real shape — one flat group of enveloped
// leaves (`exterior`) and one array-shaped collection group (`hvac`), with an enum leaf in
// each. Core must not depend on the Snugg adapter, so the shape is typed out by hand; a
// `type` alias rather than an `interface` so `V` satisfies the `Record<string, unknown>`
// constraint the extraction target carries (interfaces get no implicit index signature).
type Condition = "good" | "fair" | "poor";

type ExteriorFields = {
  readonly cladding?: string | null | undefined;
  readonly condition?: Condition | null | undefined;
};

type HvacFields = {
  readonly systemType?: "split" | "package" | null | undefined;
  readonly tonnage?: number | null | undefined;
};

type TestValues = {
  readonly exterior?: ExteriorFields;
  readonly hvac?: HvacFields[];
};

type PartialEnv = DeepPartial<Enveloped<TestValues, NoProvenance>>;

// ---------------------------------------------------------------------------
// Type-level
// ---------------------------------------------------------------------------
//
// Enforced by `tsc` (`pnpm --filter @azx/ribo-core typecheck`), not by the Vitest
// run — esbuild strips types without checking them. Each `@ts-expect-error` below is
// itself the assertion: if the error it expects ever stops happening, tsc fails with
// "Unused '@ts-expect-error' directive" (TS2578). See extraction-observer.test.ts for
// the house pattern.

test("a draft can carry one leaf's sourceSpan with no sibling leaves present", () => {
  // The property the deep partial exists for: a top-level `Partial<Enveloped<V>>` would
  // force `value` and `confidence` for this leaf and every sibling leaf of the group.
  const spanOnly: PhaseDraft<TestValues, NoProvenance> = {
    ...emptyDraft<TestValues, NoProvenance>(),
    fields: { exterior: { cladding: { sourceSpan: "the cladding is vinyl" } } },
  };
  expect(spanOnly.fields.exterior?.cladding?.sourceSpan).toBe("the cladding is vinyl");
});

test("a collection group stays an array", () => {
  // Homomorphic mapped types map arrays to arrays. Pinned by construction: if a later
  // "simplification" of DeepPartial loses that, the conditional type below resolves to
  // false and this stops compiling.
  type CollectionGroup = NonNullable<PartialEnv["hvac"]>;
  const staysArray: CollectionGroup extends readonly unknown[] ? true : false = true;
  expect(staysArray).toBe(true);
});

test("a group key and a PhaseDraft member cannot be assigned directly", () => {
  const draft = emptyDraft<TestValues, NoProvenance>();
  // @ts-expect-error — the draft's members are readonly: a run handed the draft cannot
  // write through it, because items run concurrently and `merge` owns every write.
  draft.notes = emptyNotes();
  // @ts-expect-error — the same discipline one level in: the deep partial preserves the
  // enveloped shape's `readonly` on every group key.
  draft.fields = {};
});

test("a fully-populated DeepPartial<Enveloped<V>> is not assignable to Enveloped<V>", () => {
  // Declared, not written: even a caller that filled every optional key of the deep
  // partial cannot hand it where the enveloped shape is required. This is what makes
  // Wave 3b's closing trust-boundary parse structurally required rather than optional —
  // the optionality the deep partial adds is visible to the type system, so the parse
  // cannot be quietly skipped.
  const tryToAssign = (
    partialFields: DeepPartial<Enveloped<TestValues, NoProvenance>>,
  ): Enveloped<TestValues, NoProvenance> => {
    // @ts-expect-error — the deep partial's optionality (and the possibly-undefined array
    // elements) do not satisfy the closed, fully-required enveloped shape.
    return partialFields;
  };
  void tryToAssign;
});

// Type equality, not assignability — assignability alone would not catch a mangled enum
// union that stays write-compatible. This is the one most worth a test: a later
// "simplification" of DeepPartial to a non-homomorphic or conditional form mangles enum
// leaves into something every valid member still assigns to, nothing fails, and leaf
// validation quietly disappears.
type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

test("an enum leaf's value survives the deep partial exactly", () => {
  type PartialCondition = NonNullable<NonNullable<PartialEnv["exterior"]>["condition"]>;
  // Exactly the three-state leaf: the enum members, `null` ("asked, answered null") and
  // `undefined` ("not yet asked"). The distinction is load-bearing — provenance.ts's
  // anti-hallucination rule depends on it, and a merge helper that collapses it with
  // `?? null` destroys it.
  const exact: Eq<PartialCondition["value"], Condition | null | undefined> = true;
  expect(exact).toBe(true);
});

test("an enum leaf inside a collection group's element survives exactly too", () => {
  type PartialSystemType = NonNullable<
    NonNullable<NonNullable<PartialEnv["hvac"]>[number]>["systemType"]
  >;
  const exact: Eq<PartialSystemType["value"], "split" | "package" | null | undefined> = true;
  expect(exact).toBe(true);
});

// ---------------------------------------------------------------------------
// Runtime: emptyDraft
// ---------------------------------------------------------------------------

test("emptyDraft() has empty fields, empty statedEmptyGroups, absent raw, and empty notes", () => {
  const draft = emptyDraft<TestValues, NoProvenance>();
  expect(draft.fields).toEqual({});
  expect(draft.statedEmptyGroups).toEqual({});
  // Absent, not present-but-undefined: `raw` is optional on the draft the same way it is
  // on ExtractionResult, and absence is how "no result carried one" is read.
  expect("raw" in draft).toBe(false);
  expect(draft.notes.keys).toEqual([]);
});

test("a draft carries a populated deep partial end to end", () => {
  // A value-level pass over both group shapes: a partial leaf in the flat group and a
  // one-element array in the collection group — the element itself is partial.
  const populated: PhaseDraft<TestValues, NoProvenance> = {
    ...emptyDraft<TestValues, NoProvenance>(),
    fields: {
      exterior: { condition: { value: "good", confidence: 0.9, sourceSpan: "looks good" } },
      hvac: [{ systemType: { value: "split", confidence: 0.8, sourceSpan: "split system" } }],
    },
  };
  expect(populated.fields.exterior?.condition?.value).toBe("good");
  expect(populated.fields.hvac?.[0]?.systemType?.value).toBe("split");
});
