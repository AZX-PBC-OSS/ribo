import { draftSeededNoteKey, emptyDraft, enveloped } from "@azx/ribo-core";
import type { ExtractionTarget, PhaseContext, PhaseDraft, Roster } from "@azx/ribo-core";
import { z } from "zod";
import { describe, expect, test } from "vitest";

import { inventoryPhase, rosterNoteKey } from "./inventory-phase.js";
import type { PreparedGroup } from "./instance-fill.js";

/**
 * Phase-level tests for the inventory phase, against hand-built drafts — the
 * engine is not involved here, so `plan`/`run`/`merge` are driven directly
 * through the phase's `with` (the same fold `gap-fill-phase.test.ts` uses).
 * The caller-supplied `inventory` is a fake returning a fixed {@link Roster}.
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

/** A minimal but valid PreparedGroup — the inventory merge reads key and isCollection. */
function preparedGroup(key: string, isCollection: boolean): PreparedGroup {
  const schema = isCollection
    ? z.strictObject({ [key]: z.array(widgetValues) })
    : z.strictObject({ [key]: widgetValues });
  return {
    key,
    isCollection,
    schema,
    jsonSchema: z.toJSONSchema(schema, { target: "draft-2020-12" }),
    name: `demo-${key}-fill`,
    context: `inventory demo "${key}"`,
  };
}

const prepared: readonly PreparedGroup[] = [
  preparedGroup("widgets", true),
  preparedGroup("house", false),
];

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
  test("declares none of its own, and the option absent leaves today's undefined", () => {
    const phase = inventoryPhase<DemoValues>({
      inventory: async () => ({}),
      prepared,
      instanceCap: 10,
    });
    expect(phase.requires).toBeUndefined();
  });

  test("a caller's requires is taken as the requires — the phase has none of its own to union", () => {
    const phase = inventoryPhase<DemoValues>({
      inventory: async () => ({}),
      prepared,
      instanceCap: 10,
      requires: ["mine"],
    });
    expect(phase.requires).toEqual(["mine"]);
  });
});

test("inventory does NOT produce the draft-seeded marker, and that is deliberate", () => {
  // The omission is load-bearing, and this file's subject warns that the obvious
  // "fix" is the bug: inventory's merge writes `fields[key] = []` for stated-none
  // and zero-current collection groups, which is scaffolding rather than
  // extracted data. Marking it would make `[inventory, gapfill]` validate — the
  // exact mis-wiring the marker exists to reject.
  //
  // Pinned directly rather than only through that list's rejection: that test
  // fails for a reason about `gapfill`'s unmet requirement, so it would keep
  // passing if inventory started producing the marker.
  const phase = inventoryPhase({
    inventory: async (): Promise<Roster> => ({ house: [] }),
    prepared: [],
    instanceCap: 4,
  });

  expect(phase.produces ?? []).not.toContain(draftSeededNoteKey);
});
