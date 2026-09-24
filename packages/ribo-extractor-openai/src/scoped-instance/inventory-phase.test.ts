import { emptyDraft, enveloped, phasedExtractor } from "@azx/ribo-core";
import type { ExtractionTarget, PhaseContext, PhaseDraft, Roster } from "@azx/ribo-core";
import { z } from "zod";
import { describe, expect, test } from "vitest";

import { inventoryPhase, rosterNoteKey } from "./inventory-phase.js";
import { prepareGroups } from "./instance-fill.js";
import type { PreparedGroup } from "./instance-fill.js";
import { MAX_NULLABLE_UNIONS_PER_CALL, splitExtractionSchema } from "../schema/split-schema.js";

/**
 * Phase-level tests for the inventory phase, against hand-built drafts — the
 * engine is not involved here, so `plan`/`run`/`merge` are driven directly
 * through the phase's `with` (the same fold `gap-fill-phase.test.ts` uses).
 * The caller-supplied `inventory` is a fake returning a fixed {@link Roster}.
 *
 * The `PreparedGroup`s come from `prepareGroups` over a real split — the same
 * construction site the preset uses — not from hand-rolled literals. The
 * inventory merge reads only `key` and `isCollection` off them.
 */

const widgetValues = z
  .object({
    color: z.string().nullable().optional(),
  })
  .strict();

const demoValuesSchema = z
  .object({
    widgets: z.array(widgetValues).optional(),
    house: z.object({ name: z.string().nullable().optional() }).strict().optional(),
  })
  .strict();

type DemoValues = z.infer<typeof demoValuesSchema>;

const target: ExtractionTarget<DemoValues> = {
  name: "demo",
  extractionSchema: enveloped(demoValuesSchema),
  instructions: "Demo extraction instructions.",
};

const prepared: readonly PreparedGroup[] = prepareGroups(
  target,
  splitExtractionSchema(target.extractionSchema, MAX_NULLABLE_UNIONS_PER_CALL),
);

const ctx: PhaseContext<DemoValues> = {
  transcript: { text: "the full transcript", annotations: {} },
  target,
};

const currentCandidate = (name: string) => ({
  mentionSpan: name,
  discriminator: name,
  distinguishedBy: null,
  eligibility: "current",
  eligibilitySpan: null,
});

const draftWith = (overrides: Partial<PhaseDraft<DemoValues>> = {}): PhaseDraft<DemoValues> => ({
  ...emptyDraft<DemoValues>(),
  ...overrides,
});

describe("inventoryPhase — plan", () => {
  test("returns exactly one item whatever the draft holds", () => {
    const phase = inventoryPhase<DemoValues>({
      inventory: async () => ({}),
      prepared,
      instanceCap: 10,
    });
    phase.with((def) => {
      expect(def.plan(draftWith(), ctx)).toHaveLength(1);
      expect(def.plan(draftWith({ statedEmptyGroups: { widgets: "none" } }), ctx)).toHaveLength(1);
    });
  });

  test("describeItem reports the whole-document key", () => {
    const phase = inventoryPhase<DemoValues>({
      inventory: async () => ({}),
      prepared,
      instanceCap: 10,
    });
    phase.with((def) => {
      expect(def.describeItem?.(def.plan(draftWith(), ctx)[0]!)).toEqual({ key: "" });
    });
  });
});

describe("inventoryPhase — run", () => {
  test("calls the inventory with the transcript text and reports one call", async () => {
    const seen: string[] = [];
    const roster: Roster = { widgets: [currentCandidate("the red widget")] };
    const phase = inventoryPhase<DemoValues>({
      inventory: async (transcript) => {
        seen.push(transcript);
        return roster;
      },
      prepared,
      instanceCap: 10,
    });
    await phase.with(async (def) => {
      const [item] = def.plan(draftWith(), ctx);
      const output = await def.run(item!, draftWith(), ctx);
      expect(seen).toEqual(["the full transcript"]);
      expect(output.value).toBe(roster);
      expect(output.usage).toEqual({ calls: 1 });
    });
  });
});

describe("inventoryPhase — merge", () => {
  /** Plan, run the pass against the fixed roster, and fold through merge. */
  async function mergedWith(
    roster: Roster,
    overrides: {
      readonly prepared?: readonly PreparedGroup[];
      readonly instanceCap?: number;
      readonly draft?: PhaseDraft<DemoValues>;
    } = {},
  ): Promise<PhaseDraft<DemoValues>> {
    const phase = inventoryPhase<DemoValues>({
      inventory: async () => roster,
      prepared: overrides.prepared ?? prepared,
      instanceCap: overrides.instanceCap ?? 10,
    });
    const draft = overrides.draft ?? draftWith();
    return phase.with(async (def) => {
      const outcomes = [];
      for (const item of def.plan(draft, ctx)) {
        outcomes.push({
          outcome: "result" as const,
          item,
          output: await def.run(item, draft, ctx),
        });
      }
      return def.merge(draft, outcomes);
    });
  }

  test("stores the roster in notes under the exported key", async () => {
    const roster: Roster = { widgets: [currentCandidate("the red widget")] };
    const merged = await mergedWith(roster);
    expect(merged.notes.keys).toContain(rosterNoteKey);
    expect(merged.notes.get(rosterNoteKey)).toBe(roster);
  });

  test("a stated-none collection group records its span and is seeded []", async () => {
    const roster: Roster = { widgets: { stated: "none", span: "there are no widgets" } };
    const merged = await mergedWith(roster);
    expect(merged.statedEmptyGroups).toEqual({ widgets: "there are no widgets" });
    expect(merged.fields.widgets).toEqual([]);
  });

  test("a stated-none shape under a singleton key is ignored — statedEmptyGroups stays empty", async () => {
    // THE singleton guard: a merge that iterates roster keys without checking
    // isCollection leaks the singleton's stated-none into statedEmptyGroups —
    // and passes every test that only looks at collection groups.
    const roster = {
      widgets: [currentCandidate("the red widget")],
      house: { stated: "none", span: "there is no house" },
    } as unknown as Roster;
    const merged = await mergedWith(roster);
    expect(merged.statedEmptyGroups).toEqual({});
    expect(merged.fields.house).toBeUndefined();
  });

  test("a collection group absent from the roster entirely is seeded []", async () => {
    // Today's `roster[group.key] ?? []` — a literal reading of "an array with no
    // current candidates" would leave the group undefined instead of [].
    const roster: Roster = { house: [] };
    const merged = await mergedWith(roster);
    expect(merged.fields.widgets).toEqual([]);
    expect(merged.statedEmptyGroups).toEqual({});
  });

  test("a collection group whose candidates are all non-current is seeded []", async () => {
    const roster: Roster = {
      widgets: [
        {
          mentionSpan: "the broken widget",
          discriminator: "the broken widget",
          distinguishedBy: null,
          eligibility: "decommissioned",
          eligibilitySpan: "decommissioned",
        },
      ],
    };
    const merged = await mergedWith(roster);
    expect(merged.fields.widgets).toEqual([]);
  });

  test("a collection group with current candidates is NOT seeded — the fill phase fills it", async () => {
    const roster: Roster = { widgets: [currentCandidate("the red widget")] };
    const merged = await mergedWith(roster);
    expect(merged.fields.widgets).toBeUndefined();
    expect(merged.statedEmptyGroups).toEqual({});
  });

  test("exceeding the cap throws, naming group, count and cap", async () => {
    const roster: Roster = {
      widgets: [currentCandidate("a"), currentCandidate("b")],
    };
    await expect(mergedWith(roster, { instanceCap: 1 })).rejects.toThrowError(
      'scopedInstanceExtractor: group "widgets" has 2 current instances, exceeding the cap of 1',
    );
  });

  test('a loose "" piece of a mixed split is not roster-interpreted — no statedEmptyGroups[""] ever', async () => {
    // Verify-only (mixed-schema-split design §3 row 16, §8 step 4): the roster
    // pass is house-wide and stays so; loose pieces are not collections,
    // cannot be stated empty, and skip roster interpretation — even a roster
    // carrying a "" or loose-leaf key leaks nothing into statedEmptyGroups.
    const mixedPatch = z
      .object({
        widgets: z.array(widgetValues).optional(),
        note: z.string().nullable().optional(),
      })
      .strict();
    const mixedExtraction = enveloped(mixedPatch);
    const mixedTarget: ExtractionTarget<z.infer<typeof mixedPatch>> = {
      name: "demo",
      extractionSchema: mixedExtraction,
      instructions: "Demo extraction instructions.",
    };
    const mixedPrepared: readonly PreparedGroup[] = prepareGroups(
      mixedTarget,
      splitExtractionSchema(mixedExtraction, MAX_NULLABLE_UNIONS_PER_CALL),
    );
    expect(mixedPrepared.map((p) => p.key)).toEqual(["widgets", ""]);

    const roster = {
      widgets: { stated: "none", span: "there are no widgets" },
      // Loose-shaped roster entries the interpretation must not touch.
      "": { stated: "none", span: "nothing loose" },
      note: { stated: "none", span: "no note" },
    } as unknown as Roster;
    const merged = await mergedWith(roster, { prepared: mixedPrepared });

    // The collection interprets exactly as today; the loose piece contributed
    // nothing — no "" or note key in statedEmptyGroups or in the seeded fields.
    // (Object.keys, not toHaveProperty: the matcher cannot take a "" key path.)
    expect(merged.statedEmptyGroups).toEqual({ widgets: "there are no widgets" });
    expect(merged.fields.widgets).toEqual([]);
    expect(Object.keys(merged.fields)).not.toContain("");
    expect(Object.keys(merged.fields)).not.toContain("note");
  });
});

describe("inventoryPhase — id", () => {
  test('defaults to "inventory" and honours an explicit id', () => {
    const defaults = inventoryPhase<DemoValues>({
      inventory: async () => ({}),
      prepared,
      instanceCap: 10,
    });
    expect(defaults.id).toBe("inventory");
    const renamed = inventoryPhase<DemoValues>({
      inventory: async () => ({}),
      prepared,
      instanceCap: 10,
      id: "inventory-cheap",
    });
    expect(renamed.id).toBe("inventory-cheap");
  });
});

describe("inventoryPhase — requires", () => {
  test("declares none of its own, and the option absent leaves it undefined", () => {
    const phase = inventoryPhase<DemoValues>({
      inventory: async () => ({}),
      prepared,
      instanceCap: 10,
    });
    expect(phase.requires).toBeUndefined();
  });

  test("a caller's requires is taken as the requires — the phase has no default to replace", () => {
    const phase = inventoryPhase<DemoValues>({
      inventory: async () => ({}),
      prepared,
      instanceCap: 10,
      requires: ["mine"],
    });
    expect(phase.requires).toEqual(["mine"]);
  });
});

/**
 * `[inventory]` alone is a valid list that runs green when the roster leaves
 * every group parseable — ADR 0008 protects this case explicitly. All groups
 * here are collection groups, because only those does the inventory merge seed:
 * an all-stated-empty roster legitimately yields `{ widgets: [], gadgets: [] }`
 * with zero fill calls.
 */
const onlyCollectionsSchema = z
  .object({
    widgets: z.array(z.object({ color: z.string().nullable().optional() })).optional(),
    gadgets: z.array(z.object({ color: z.string().nullable().optional() })).optional(),
  })
  .strict();
type OnlyCollectionsValues = z.infer<typeof onlyCollectionsSchema>;

const onlyCollectionsTarget: ExtractionTarget<OnlyCollectionsValues> = {
  name: "only-collections",
  extractionSchema: enveloped(onlyCollectionsSchema),
  instructions: "Demo extraction instructions.",
};

const onlyCollectionsPrepared: readonly PreparedGroup[] = prepareGroups(
  onlyCollectionsTarget,
  splitExtractionSchema(onlyCollectionsTarget.extractionSchema, MAX_NULLABLE_UNIONS_PER_CALL),
);

test("[inventory] alone runs green over an all-stated-empty roster", async () => {
  const extractor = phasedExtractor<OnlyCollectionsValues>({
    target: onlyCollectionsTarget,
    phases: [
      inventoryPhase<OnlyCollectionsValues>({
        inventory: async () => ({
          widgets: { stated: "none", span: "no widgets" },
          gadgets: { stated: "none", span: "no gadgets" },
        }),
        prepared: onlyCollectionsPrepared,
        instanceCap: 4,
      }),
    ],
  });

  const result = await extractor.extract({ text: "no widgets or gadgets here", annotations: {} });

  expect(result.fields.widgets).toEqual([]);
  expect(result.fields.gadgets).toEqual([]);
  expect(result.statedEmptyGroups).toEqual({
    widgets: "no widgets",
    gadgets: "no gadgets",
  });
  expect(result.usage.calls).toBe(1); // the inventory pass itself
});

test("the inventory phase refuses onItemFailure at the type level — the deliberate refusal", () => {
  // `fillPhase` and `gapFillPhase` take `onItemFailure`; the inventory phase
  // deliberately does not. On an error its merge returns the draft unchanged —
  // there is no roster to interpret — so a skip here would not absorb the
  // failure but defer it one phase, surfacing as fill's `demandNote` throw
  // about the missing roster note. Refusing the option keeps the consequence
  // at the wiring, where it names the mis-wiring instead of the failure.
  //
  // The @ts-expect-error IS the pin: it is satisfied while the option does not
  // exist (the literal's excess property errors), and if someone ever adds the
  // option the directive turns unused and tsc fails this gate — either state
  // of the world makes the refusal loud.
  const phase = inventoryPhase<DemoValues>({
    inventory: async () => ({}),
    prepared,
    instanceCap: 10,
    // @ts-expect-error — the option is refused; see the options interface.
    onItemFailure: "skip",
  });
  // The literal still builds at runtime — the refusal is type-level only.
  expect(phase.id).toBe("inventory");
});
