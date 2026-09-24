import {
  emptyDraft,
  emptyNotes,
  enveloped,
  nullEnvelope,
  phaseBuilder,
  phasedExtractor,
  SchemaParseError,
  validatePhases,
} from "@azx/ribo-core";
import type {
  ChatClient,
  ChatRequest,
  DeepPartial,
  Enveloped,
  ExtractionTarget,
  NoProvenance,
  Phase,
  PhaseContext,
  PhaseDraft,
  Roster,
} from "@azx/ribo-core";
import { z } from "zod";
import { describe, expect, test } from "vitest";

import { inventoryPhase, rosterNoteKey } from "./inventory-phase.js";
import { fillPhase } from "./fill-phase.js";
import type { FillPhaseOptions } from "./fill-phase.js";
import { prepareGroups } from "./instance-fill.js";
import type { PreparedGroup } from "./instance-fill.js";
import { MAX_NULLABLE_UNIONS_PER_CALL, splitExtractionSchema } from "../schema/split-schema.js";

/**
 * Phase-level tests for the scoped-instance fill phase, against hand-built
 * drafts — the engine is not involved here, so `plan`/`run`/`merge` are driven
 * directly through the phase's `with` (the same fold
 * `gap-fill-phase.test.ts` uses). The ordering test drives `merge` DIRECTLY:
 * `mapWithPool` returns an index-ordered array, so outcomes always reach
 * `merge` in plan order and an extract-level "reversed outcomes" test would
 * pass against any implementation, including one that pushes in arrival order.
 *
 * The `PreparedGroup`s come from `prepareGroups` over real splits — the same
 * construction site the preset uses — not from hand-rolled literals, so a
 * change to how fill schemas are derived fails here instead of drifting.
 */

const widgetValues = z
  .object({
    color: z.string().nullable().optional(),
    // A string, not a number: the fill-response fixtures answer with string
    // values ("1", "0-size"), and the prepared fill schemas parse against the
    // real leaves now that the PreparedGroups are derived, not hand-rolled.
    size: z.string().nullable().optional(),
  })
  .strict();

const demoValuesSchema = z
  .object({
    widgets: z.array(widgetValues).optional(),
    gadgets: z.array(widgetValues).optional(),
    // color/size rather than a lone `name`, so the shared `leafEnvelope`
    // response fixture parses against this group's prepared fill schema too.
    // Both leaves are strings, for the same reason `widgetValues.size` is.
    house: z
      .object({
        color: z.string().nullable().optional(),
        size: z.string().nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

type DemoValues = z.infer<typeof demoValuesSchema>;

const target: ExtractionTarget<DemoValues> = {
  name: "demo",
  extractionSchema: enveloped(demoValuesSchema),
  instructions: "Demo extraction instructions.",
  examples: [],
};

const prepared: readonly PreparedGroup[] = prepareGroups(
  target,
  splitExtractionSchema(target.extractionSchema, MAX_NULLABLE_UNIONS_PER_CALL),
);

/**
 * A partitioned group's pieces, derived the way the preset derives them: two
 * string leaves = four unions, and a cap of 3 splits the group into two
 * 1-leaf pieces sharing the key. String `size` because the recombine fixtures
 * answer with string values.
 */
const stringLeafValues = z
  .object({
    color: z.string().nullable().optional(),
    size: z.string().nullable().optional(),
  })
  .strict();
const systemsPatch = z.object({ systems: z.array(stringLeafValues).optional() }).strict();
type SystemsValues = z.infer<typeof systemsPatch>;
const systemsTarget: ExtractionTarget<SystemsValues> = {
  name: "demo",
  extractionSchema: enveloped(systemsPatch),
  instructions: "Demo extraction instructions.",
  examples: [],
};
const partitionedSystems = prepareGroups(
  systemsTarget,
  splitExtractionSchema(systemsTarget.extractionSchema, { maxNullableUnionsPerGroup: 3 }),
);

/** The non-grouped fallback's single entry, derived from a flat schema. */
const flatPatch = z
  .object({
    color: z.string().nullable().optional(),
    size: z.number().nullable().optional(),
  })
  .strict();
type FlatValues = z.infer<typeof flatPatch>;
const flatTarget: ExtractionTarget<FlatValues> = {
  name: "demo",
  extractionSchema: enveloped(flatPatch),
  instructions: "Demo extraction instructions.",
  examples: [],
};
const fallbackPrepared = prepareGroups(
  flatTarget,
  splitExtractionSchema(flatTarget.extractionSchema, MAX_NULLABLE_UNIONS_PER_CALL),
);

const ctx: PhaseContext<DemoValues> = {
  transcript: { text: "the full transcript", annotations: {} },
  target,
};

const flatCtx: PhaseContext<FlatValues> = {
  transcript: { text: "the full transcript", annotations: {} },
  target: flatTarget,
};

const currentCandidate = (name: string) => ({
  mentionSpan: name,
  discriminator: name,
  distinguishedBy: null,
  eligibility: "current",
  eligibilitySpan: null,
});

/** The draft the inventory phase's merge would have left: roster in notes, empties seeded. */
function draftWith(
  roster: Roster,
  fields: DeepPartial<Enveloped<DemoValues>> = {},
): PhaseDraft<DemoValues> {
  return {
    ...emptyDraft<DemoValues>(),
    fields,
    notes: emptyNotes().set(rosterNoteKey, roster),
  };
}

/** One piece's worth of enveloped leaves for a fill response. */
const leafEnvelope = (prefix: string): Record<string, unknown> => ({
  color: { value: prefix, sourceSpan: "span", confidence: 1 },
  size: { value: null, sourceSpan: null, confidence: 1 },
});

const widgetResponse = (color: string): Record<string, unknown> => ({
  widgets: leafEnvelope(color),
});

const houseResponse = (): Record<string, unknown> => ({
  house: leafEnvelope("main"),
});

/** A ChatClient dispatching on the request name, recording every request. */
function fakeChat(respond: (requestName: string) => unknown): {
  chat: ChatClient;
  requests: ChatRequest[];
} {
  const requests: ChatRequest[] = [];
  return {
    chat: {
      complete: async (request) => {
        requests.push(request);
        return {
          content: JSON.stringify(respond(request.response_format.json_schema.name)),
          finishReason: "stop",
        };
      },
    },
    requests,
  };
}

const buildFillInstructions = (groupKey: string, scope: unknown): string =>
  `Fill instructions for ${groupKey}.\n\nScope:\n${JSON.stringify(scope)}`;

/** The item type is existentially hidden; recover what the encoding hides for assertions. */
const jobOf = (item: unknown) => item as { requestName: string; instanceIndex: number };

describe("fillPhase — plan", () => {
  const phase = fillPhase<DemoValues>({
    target,
    chat: {} as ChatClient,
    model: "m",
    prepared,
    buildFillInstructions,
  });

  test("yields one job per current candidate and skips a group the inventory seeded empty", () => {
    const draft = draftWith(twoWidgets());
    phase.with((def) => {
      const jobs = def.plan(draft, ctx).map(jobOf);
      // Two widget fills; the empty gadgets group is skipped; the singleton house fills.
      expect(jobs.map((j) => j.requestName)).toEqual([
        "demo-widgets-fill-0",
        "demo-widgets-fill-1",
        "demo-house-fill",
      ]);

      // A stated-none roster entry leaves no jobs either — the group the
      // inventory merge seeded [] plans nothing.
      const statedDraft = draftWith({
        widgets: { stated: "none", span: "none" },
        gadgets: [],
        house: [],
      });
      const statedJobs = def.plan(statedDraft, ctx).map(jobOf);
      expect(statedJobs.every((j) => !j.requestName.startsWith("demo-widgets-fill"))).toBe(true);
    });
  });

  test("yields one job per piece for a partitioned group, sharing group and instance, distinct request names", () => {
    const roster: Roster = { systems: [currentCandidate("a"), currentCandidate("b")] };
    const partitionedPhase = fillPhase<DemoValues>({
      target,
      chat: {} as ChatClient,
      model: "m",
      prepared: partitionedSystems,
      buildFillInstructions,
    });
    partitionedPhase.with((def) => {
      const jobs = def.plan(draftWith(roster), ctx).map(jobOf);
      expect(jobs.map((j) => j.requestName)).toEqual([
        "demo-systems-fill-0-0",
        "demo-systems-fill-0-1",
        "demo-systems-fill-1-0",
        "demo-systems-fill-1-1",
      ]);
      // Every job names its group; each instance appears once per piece.
      expect(jobs.map((j) => j.instanceIndex)).toEqual([0, 1, 0, 1]);
    });
  });

  test("yields one job at instance 0 for a singleton — even when the roster holds a stated-none shape for its key", () => {
    // The singleton branch runs before any roster interpretation today; the
    // ported plan keeps that — the inventory merge ignores the entry, and the
    // fill plan never consults the roster for a non-collection group.
    const roster = {
      widgets: [],
      house: { stated: "none", span: "there is no house" },
    } as unknown as Roster;
    phase.with((def) => {
      const jobs = def.plan(draftWith(roster), ctx).map(jobOf);
      expect(jobs.filter((j) => j.requestName === "demo-house-fill")).toHaveLength(1);
    });
  });

  test("the \"\" fallback group's messages come from buildMessages — the target's own instructions", async () => {
    const { chat, requests } = fakeChat(() => ({
      color: { value: "x", sourceSpan: "span", confidence: 1 },
      size: { value: null, sourceSpan: null, confidence: 1 },
    }));
    const fallbackPhase = fillPhase<FlatValues>({
      target: flatTarget,
      chat,
      model: "m",
      prepared: fallbackPrepared,
      buildFillInstructions,
    });
    await fallbackPhase.with(async (def) => {
      // The fill plan demands the roster note even on the "" path (ADR 0008's
      // demandNote) — the note's absence is what throws, not the group's shape.
      const draft: PhaseDraft<FlatValues> = {
        ...emptyDraft<FlatValues>(),
        notes: emptyNotes().set(rosterNoteKey, {}),
      };
      const [item] = def.plan(draft, flatCtx);
      await def.run(item!, draft, flatCtx);
      const system = requests[0]!.messages[0]!;
      expect(system.role).toBe("system");
      // buildMessages carries the target's instructions verbatim; the scoped
      // builder would have wrapped the scope block around it.
      expect(system.content).toBe("Demo extraction instructions.");
      expect(system.content).not.toContain("Scope:");
    });
  });
});

function twoWidgets(): Roster {
  return {
    widgets: [currentCandidate("the red widget"), currentCandidate("the blue widget")],
    gadgets: [],
    house: [],
  };
}

describe("fillPhase — describeItem", () => {
  test("reports the job's key, instance, instances, part, parts", () => {
    const roster: Roster = { systems: [currentCandidate("a"), currentCandidate("b")] };
    const partitionedPhase = fillPhase<DemoValues>({
      target,
      chat: {} as ChatClient,
      model: "m",
      prepared: partitionedSystems,
      buildFillInstructions,
    });
    partitionedPhase.with((def) => {
      const items = def.plan(draftWith(roster), ctx);
      const described = items.map((item) => def.describeItem?.(item));
      expect(described).toEqual([
        { key: "systems", instance: 1, instances: 2, part: 1, parts: 2 },
        { key: "systems", instance: 2, instances: 2, part: 1, parts: 2 },
        { key: "systems", instance: 1, instances: 2, part: 2, parts: 2 },
        { key: "systems", instance: 2, instances: 2, part: 2, parts: 2 },
      ]);
    });
  });
});

describe("fillPhase — run", () => {
  test("makes the one chat call pinned to the job's schema name and parses it", async () => {
    const { chat, requests } = fakeChat((name) =>
      name.startsWith("demo-house-fill") ? houseResponse() : widgetResponse("red"),
    );
    const phase = fillPhase<DemoValues>({
      target,
      chat,
      model: "demo-model",
      prepared,
      buildFillInstructions,
    });
    const draft = draftWith({
      widgets: [currentCandidate("the red widget")],
      gadgets: [],
      house: [],
    });
    await phase.with(async (def) => {
      const [item] = def.plan(draft, ctx);
      const output = await def.run(item!, draft, ctx);
      expect(requests).toHaveLength(1);
      expect(requests[0]!.response_format.json_schema.name).toBe("demo-widgets-fill-0");
      expect(output.usage?.calls).toBe(1);
    });
  });
});

describe("fillPhase — merge", () => {
  /** Plan, run every job against a name-dispatched response, fold through merge. */
  async function fold(
    roster: Roster,
    prepared_: readonly PreparedGroup[],
    respond: (requestName: string) => unknown,
    fields: DeepPartial<Enveloped<DemoValues>> = {},
  ): Promise<PhaseDraft<DemoValues>> {
    const { chat } = fakeChat(respond);
    const phase = fillPhase<DemoValues>({
      target,
      chat,
      model: "demo-model",
      prepared: prepared_,
      buildFillInstructions,
    });
    const draft = draftWith(roster, fields);
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

  test("recombines two pieces of one slot with mergeGroupPieces — every leaf of every instance survives", async () => {
    const roster: Roster = { systems: [currentCandidate("a"), currentCandidate("b")] };
    const merged = await fold(roster, partitionedSystems, (requestName) => {
      const [, part, instance] = /-(\d+)-(\d+)$/.exec(requestName)!;
      const leaf = part === "0" ? "color" : "size";
      return {
        systems: {
          [leaf]: { value: `${instance}-${leaf}`, sourceSpan: "span", confidence: 1 },
        },
      };
    });

    // `systems` is not a key of the shared DemoValues schema — the phase level
    // never parses against the full schema, so the cast just reads the record.
    const systems = (merged.fields as Record<string, unknown>).systems as {
      color: { value: string };
      size: { value: string };
    }[];
    expect(systems).toHaveLength(2);
    for (let instance = 0; instance < 2; instance++) {
      expect(systems[instance]!.color.value).toBe(`${instance}-color`);
      expect(systems[instance]!.size.value).toBe(`${instance}-size`);
    }
  });

  test("merge writes raw — the assembled pre-normalize record, including the seeded []s", async () => {
    // THE regression pin the previous port failed: today `raw` is ALWAYS present
    // on the result; the engine emits it only when a merge wrote it. The suite's
    // only pre-existing raw assertion compares two results to each other, which
    // passes when both are absent — so a presence assertion is load-bearing.
    const seeded: DeepPartial<Enveloped<DemoValues>> = { gadgets: [] };
    const merged = await fold(
      twoWidgets(),
      prepared,
      (name) => {
        if (name.startsWith("demo-house-fill")) return houseResponse();
        return widgetResponse(name.endsWith("1") ? "blue" : "red");
      },
      seeded,
    );

    expect(merged.raw).toBeDefined();
    expect(merged.raw).toEqual({
      gadgets: [],
      widgets: [leafEnvelope("red"), leafEnvelope("blue")],
      house: leafEnvelope("main"),
    });
  });

  test("assembly is indexed by the job's instanceIndex, never by arrival order", async () => {
    // THE ordering pin: driven through merge DIRECTLY with the outcomes
    // deliberately reversed. mapWithPool writes results[index] and the engine
    // hands that index-ordered array straight to merge, so outcomes always
    // arrive in plan order through extract() — an extract-level "reversed"
    // test would pass against any implementation, including one that pushes in
    // arrival order.
    const chat = {
      complete: async (request: ChatRequest) => {
        const name = request.response_format.json_schema.name;
        const content = name.startsWith("demo-house-fill")
          ? houseResponse()
          : widgetResponse(name.endsWith("1") ? "blue" : "red");
        return { content: JSON.stringify(content), finishReason: "stop" as const };
      },
    };
    const phase = fillPhase<DemoValues>({
      target,
      chat,
      model: "demo-model",
      prepared,
      buildFillInstructions,
    });
    const draft = draftWith(twoWidgets());

    await phase.with(async (def) => {
      const outcomes = [];
      for (const item of def.plan(draft, ctx)) {
        outcomes.push({
          outcome: "result" as const,
          item,
          output: await def.run(item, draft, ctx),
        });
      }
      const merged = def.merge(draft, outcomes.reverse());

      const widgets = merged.fields.widgets as { color: { value: string } }[];
      expect(widgets[0]!.color.value).toBe("red");
      expect(widgets[1]!.color.value).toBe("blue");
    });
  });

  test('a loose "" piece beside a collection group: one fill per piece, buildMessages, merged flat beside the keyed array', async () => {
    // Verify-only (mixed-schema-split design §3 rows 14–15, §8 step 4): a
    // mixed split's loose piece takes the singleton/fallback branch the flat
    // fallback always used — one fill call, no scope semantics, messages from
    // buildMessages — and the merge assigns its leaves flat beside the
    // collection's keyed array. No fill-phase code changed for the mixed case.
    const mixedPatch = z
      .object({
        widgets: z.array(widgetValues).optional(),
        note: z.string().nullable().optional(),
      })
      .strict();
    type MixedValues = z.infer<typeof mixedPatch>;
    const mixedTarget: ExtractionTarget<MixedValues> = {
      name: "demo",
      extractionSchema: enveloped(mixedPatch),
      instructions: "Demo extraction instructions.",
      examples: [],
    };
    const mixedPrepared = prepareGroups(
      mixedTarget,
      splitExtractionSchema(mixedTarget.extractionSchema, MAX_NULLABLE_UNIONS_PER_CALL),
    );
    const mixedCtx: PhaseContext<MixedValues> = {
      transcript: { text: "the full transcript", annotations: {} },
      target: mixedTarget,
    };

    const { chat, requests } = fakeChat((name) => {
      if (name === "demo-widgets-fill-0") return widgetResponse("red");
      if (name === "demo-fill") {
        return { note: { value: "a note", sourceSpan: "the note", confidence: 1 } };
      }
      throw new Error(`unexpected request ${name}`);
    });
    const phase = fillPhase<MixedValues>({
      target: mixedTarget,
      chat,
      model: "m",
      prepared: mixedPrepared,
      buildFillInstructions,
    });
    const roster: Roster = { widgets: [currentCandidate("the red widget")] };
    const draft: PhaseDraft<MixedValues> = {
      ...emptyDraft<MixedValues>(),
      notes: emptyNotes().set(rosterNoteKey, roster),
    };

    await phase.with(async (def) => {
      const items = def.plan(draft, mixedCtx);
      // One fill for the one current widget, then the loose piece's single
      // fill — the loose piece never consults the roster.
      expect(items.map(jobOf).map((j) => j.requestName)).toEqual([
        "demo-widgets-fill-0",
        "demo-fill",
      ]);
      const outcomes = [];
      for (const item of items) {
        outcomes.push({
          outcome: "result" as const,
          item,
          output: await def.run(item, draft, mixedCtx),
        });
      }
      const merged = def.merge(draft, outcomes);
      const fields = merged.fields as {
        widgets?: { color: { value: string } }[];
        note?: { value: string };
      };
      // The keyed collection assembled by instance index; the loose leaf
      // assigned flat — disjoint by construction, so neither clobbers the other.
      expect(fields.widgets).toHaveLength(1);
      expect(fields.widgets![0]!.color.value).toBe("red");
      expect(fields.note!.value).toBe("a note");
    });

    // buildMessages, not the scoped builder: the loose request's system
    // message is the target's instructions verbatim, with no scope block.
    const looseReq = requests.find((r) => r.response_format.json_schema.name === "demo-fill")!;
    expect(looseReq.messages[0]).toEqual({
      role: "system",
      content: "Demo extraction instructions.",
    });
  });

  test('the "" fallback\'s single fill assignment lands flat — the assignment path the non-grouped case was broken on before the merge read fix', async () => {
    // REGRESSION PIN — the latent bug the partition-flatfallback commit fixes:
    // on `origin/main` the merge read `outcome.output.value[job.group.key]`,
    // which is undefined for `key === ""`, wrote `groupResult[""] = undefined`,
    // and the engine's closing parse rejected every scoped-instance extraction
    // of a flat schema. The single-piece case is the one that is shipped today;
    // if a host uses a flat schema and `scopedInstanceExtractor`, this is the
    // path that runs.
    const { chat } = fakeChat((name) => {
      // flatTarget.name is "demo"; unpartitioned flat pieces carry `${name}-fill`
      // (no part suffix). If a flat partitioned piece ever lands here, its name
      // carries a `-<part>` suffix and this branch refuses to respond.
      if (name === "demo-fill") {
        return {
          color: { value: "blue", sourceSpan: "span", confidence: 1 },
          size: { value: null, sourceSpan: null, confidence: 1 },
        };
      }
      throw new Error(`the flat fallback's single-call path must not call ${name}`);
    });
    const phase = fillPhase<FlatValues>({
      target: flatTarget,
      chat,
      model: "demo-model",
      prepared: fallbackPrepared,
      buildFillInstructions,
    });
    const draft: PhaseDraft<FlatValues> = {
      ...emptyDraft<FlatValues>(),
      notes: emptyNotes().set(rosterNoteKey, {}),
    };
    await phase.with(async (def) => {
      const items = def.plan(draft, flatCtx);
      expect(items).toHaveLength(1);
      const outcomes = [];
      for (const item of items) {
        outcomes.push({
          outcome: "result" as const,
          item,
          output: await def.run(item, draft, flatCtx),
        });
      }
      const merged = def.merge(draft, outcomes);
      const fields = merged.fields as Record<string, { value: string | null }>;
      expect(fields.color!.value).toBe("blue");
      // The schema has both leaves; the merge assigns each from the parsed response.
      expect(fields.size).toBeDefined();
      // And `raw` carries the same record — the merge wrote it.
      expect(merged.raw).toEqual({
        color: { value: "blue", sourceSpan: "span", confidence: 1 },
        size: { value: null, sourceSpan: null, confidence: 1 },
      });
    });
  });

  test("a partitioned flat schema's pieces reassemble by per-leaf Object.assign — every leaf reappears, none duplicated", async () => {
    // THE partitioned-flat merge regression pin. Built via prepareGroups on
    // a flat schema with a tight byte cap — the same construction site the
    // preset uses, so a change to the schema the prepared pieces validate
    // against cannot drift. A wrong read — `value[job.group.key]` on a flat
    // piece — yields `undefined` here; the new code path checks `key === ""`
    // and reads the parsed response directly. N flat pieces -> N disjoint
    // calls, each pinned to its own subset of leaves.
    //
    // Long enum values inflate the flat schema's serialized form well past a
    // tight byte cap; 6 leaves with 50-char enum literals partition into
    // pieces of 1-2 leaves each. Without a partitioned split there is no test
    // for the flat merge's piece-order arm.
    const enumByKey: Record<string, string> = {
      a: "option-alpha-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      b: "option-bravo-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      c: "option-charlie-cccccccccccccccccccccccccccccc",
      d: "option-delta-dddddddddddddddddddddddddddddddddd",
      e: "option-echo-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      f: "option-foxtrot-ffffffffffffffffffffffffffffffffff",
    };
    const flatEnumPatch = z
      .object({
        a: z.enum([enumByKey.a!]),
        b: z.enum([enumByKey.b!]),
        c: z.enum([enumByKey.c!]),
        d: z.enum([enumByKey.d!]),
        e: z.enum([enumByKey.e!]),
        f: z.enum([enumByKey.f!]),
      })
      .strict();
    type FlatEnumValues = z.infer<typeof flatEnumPatch>;
    const flatEnumTarget: ExtractionTarget<FlatEnumValues> = {
      name: "demo-flat-enum",
      extractionSchema: enveloped(flatEnumPatch),
      instructions: "Demo flat extraction.",
      examples: [],
    };
    const flatEnumPieces = prepareGroups(
      flatEnumTarget,
      splitExtractionSchema(flatEnumTarget.extractionSchema, {
        maxSerializedCharsPerGroup: 1500,
      }),
    );
    expect(flatEnumPieces.length).toBeGreaterThan(1);
    expect(flatEnumPieces.every((p) => p.key === "")).toBe(true);
    expect(flatEnumPieces.every((p) => p.isCollection === false)).toBe(true);

    const leafEnvelope = (key: string): Record<string, unknown> => ({
      value: enumByKey[key]!,
      sourceSpan: key,
      confidence: 1,
    });

    const flatEnumCtx: PhaseContext<FlatEnumValues> = {
      transcript: { text: "the full transcript", annotations: {} },
      target: flatEnumTarget,
    };

    const { chat } = fakeChat((name) => {
      const m = /-(\d+)$/.exec(name);
      if (m === null) throw new Error(`unexpected flat piece name: ${name}`);
      const part = Number(m[1]);
      const piece = flatEnumPieces[part]!;
      const shape = (piece.schema as z.ZodObject<z.ZodRawShape>).shape as Record<string, z.ZodType>;
      const fields: Record<string, unknown> = {};
      for (const leafKey of Object.keys(shape)) {
        fields[leafKey] = leafEnvelope(leafKey);
      }
      return fields;
    });

    const phase = fillPhase<FlatEnumValues>({
      target: flatEnumTarget,
      chat,
      model: "demo-model",
      prepared: flatEnumPieces,
      buildFillInstructions,
    });
    const draft: PhaseDraft<FlatEnumValues> = {
      ...emptyDraft<FlatEnumValues>(),
      notes: emptyNotes().set(rosterNoteKey, {}),
    };

    await phase.with(async (def) => {
      const items = def.plan(draft, flatEnumCtx);
      expect(items).toHaveLength(flatEnumPieces.length);
      const outcomes = [];
      for (const item of items) {
        outcomes.push({
          outcome: "result" as const,
          item,
          output: await def.run(item, draft, flatEnumCtx),
        });
      }
      const merged = def.merge(draft, outcomes);
      const fields = merged.fields as Record<string, { value: string }>;
      // Every leaf reappears — disjoint pieces, no overlap, Object.assign
      // accumulates in piece order.
      const expectedLeaves = Object.keys(flatEnumPatch.shape);
      for (const key of expectedLeaves) {
        expect(fields[key], `leaf ${key}`).toBeDefined();
        expect(fields[key]!.value).toBe(enumByKey[key]);
      }
      // Exactly these leaves — no piece's subset is missing, no spurious copy.
      expect(Object.keys(fields).sort()).toEqual([...expectedLeaves].sort());
      expect(merged.raw).toBeDefined();
    });
  });
});

describe("fillPhase — requires", () => {
  const base = {
    target,
    chat: {} as ChatClient,
    model: "m",
    prepared,
    buildFillInstructions,
  };

  test("defaults to the inventory phase's id when the option is absent", () => {
    expect(fillPhase<DemoValues>(base).requires).toEqual(["inventory"]);
  });

  test("a caller's requires REPLACES the default — the complete list, not an addition", () => {
    const phase = fillPhase<DemoValues>({ ...base, requires: ["mine"] });
    expect(phase.requires).toEqual(["mine"]);
  });

  test("a caller adding a constraint must still name the roster's provider — the plan reads the note", () => {
    // The consequence documented on the option: overriding `requires` supplies
    // the COMPLETE list. Drop "inventory" and validation fails on the dangling
    // default — the caller took responsibility for naming a provider and did
    // not.
    const phase = fillPhase<DemoValues>({ ...base, requires: ["inventory", "mine"] });
    expect(phase.requires).toEqual(["inventory", "mine"]);
  });

  // THE composition pin the wave exists for, in id terms: a caller-built phase
  // with its own id, and the SHIPPED fill phase told — through the REPLACING
  // option, naming both providers — to wait for it. The list's validity now
  // depends on the caller's phase running before it.
  test("[inventory, mine, fill] validates and [inventory, fill, mine] is rejected", () => {
    const mine = phaseBuilder<DemoValues>()({
      id: "mine",
      plan: () => [],
      // Validation never enters `with`, so the run is never reached; a throw
      // keeps the double honest if a future refactor starts running it.
      run: async () => {
        throw new Error("validation only — this phase must never run in this pin");
      },
      merge: (draft) => draft,
    });
    const fill = fillPhase<DemoValues>({ ...base, requires: ["inventory", "mine"] });
    const inventory = inventoryPhase<DemoValues>({
      inventory: async () => ({}),
      prepared,
      instanceCap: 10,
    });

    expect(() => validatePhases<DemoValues>([inventory, mine, fill])).not.toThrow();
    expect(() => validatePhases<DemoValues>([inventory, fill, mine])).toThrow(
      /phase "fill" requires phase "mine"/,
    );
  });

  test("a dropped dependency is loud, not silent: the plan throws naming the roster note", () => {
    // The most important consequence of replacing semantics: a list whose
    // earlier phases never write the roster note must not become a silent
    // all-null run. Direct plan-level form.
    const phase = fillPhase<DemoValues>(base);
    const empty = { ...emptyDraft<DemoValues>() };
    expect(() => phase.with((def) => def.plan(empty, ctx))).toThrow(new RegExp(rosterNoteKey));
  });

  test("a dropped dependency throws from the RUN's plan before any call is paid for", async () => {
    // Engine-level form of the same pin: `mine` writes no notes, fill demands
    // the roster. The chat is a throwing double because it must never be
    // reached — the throw happens in plan, before any item runs.
    const chat: ChatClient = {
      complete: async () => {
        throw new Error("no call may be made — plan must throw first");
      },
    };
    const mine = phaseBuilder<DemoValues>()({
      id: "mine",
      plan: () => [1],
      run: async () => ({ value: 1 }),
      merge: (draft) => draft,
    });
    const fill = fillPhase<DemoValues>({ ...base, chat, requires: ["mine"] });
    const extractor = phasedExtractor<DemoValues>({ target, phases: [mine, fill] });

    const rejection = await extractor.extract(ctx.transcript).catch((cause: unknown) => cause);
    expect(rejection).toBeInstanceOf(TypeError);
    expect((rejection as Error).message).toMatch(new RegExp(rosterNoteKey));
  });
});

describe("fillPhase — narrowToAbstained", () => {
  /**
   * Both leaves committed — the slot a fill response leaves when it commits
   * everything; "committed" is the value-non-null sense, so any null is not.
   */
  const committedLeaves = (colorValue: string, sizeValue: string): Record<string, unknown> => ({
    color: { value: colorValue, sourceSpan: "span", confidence: 1 },
    size: { value: sizeValue, sourceSpan: "span", confidence: 1 },
  });

  /** Both leaves abstained — the slot a fill response leaves when it commits nothing. */
  const abstainedLeaves = (): Record<string, unknown> => ({
    color: { value: null, sourceSpan: null, confidence: 1 },
    size: { value: null, sourceSpan: null, confidence: 1 },
  });

  /** Plan only; the job list as request names, through the existential hiding. */
  function planNames(phase: Phase<DemoValues>, draft: PhaseDraft<DemoValues>): string[] {
    return phase.with((def) => def.plan(draft, ctx).map((item) => jobOf(item).requestName));
  }

  /** Plan, run every job against the phase's chat, fold through merge. */
  async function runPhase(
    phase: Phase<DemoValues>,
    draft: PhaseDraft<DemoValues>,
  ): Promise<{ names: string[]; merged: PhaseDraft<DemoValues> }> {
    return phase.with(async (def) => {
      const items = def.plan(draft, ctx);
      const names = items.map((item) => jobOf(item).requestName);
      const outcomes = [];
      for (const item of items) {
        outcomes.push({
          outcome: "result" as const,
          item,
          output: await def.run(item, draft, ctx),
        });
      }
      return { names, merged: def.merge(draft, outcomes) };
    });
  }

  test("plans every job the roster yields when the option is absent or false — the presets' behaviour", () => {
    // A fully committed draft is exactly what a narrowed fill would skip — so
    // the default's job list here is the pin that nothing narrows unless asked.
    const draft = draftWith(twoWidgets(), {
      widgets: [committedLeaves("red", "1"), committedLeaves("blue", "2")],
      house: committedLeaves("main", "1950"),
    });
    const absent = fillPhase<DemoValues>({
      target,
      chat: {} as ChatClient,
      model: "m",
      prepared,
      buildFillInstructions,
    });
    expect(planNames(absent, draft)).toEqual([
      "demo-widgets-fill-0",
      "demo-widgets-fill-1",
      "demo-house-fill",
    ]);
    const explicitFalse = fillPhase<DemoValues>({
      target,
      chat: {} as ChatClient,
      model: "m",
      prepared,
      buildFillInstructions,
      narrowToAbstained: false,
    });
    expect(planNames(explicitFalse, draft)).toEqual([
      "demo-widgets-fill-0",
      "demo-widgets-fill-1",
      "demo-house-fill",
    ]);
  });

  test("with narrowToAbstained, an empty draft plans every job — nothing is committed yet", () => {
    const phase = fillPhase<DemoValues>({
      target,
      chat: {} as ChatClient,
      model: "m",
      prepared,
      buildFillInstructions,
      narrowToAbstained: true,
    });
    expect(planNames(phase, draftWith(twoWidgets()))).toEqual([
      "demo-widgets-fill-0",
      "demo-widgets-fill-1",
      "demo-house-fill",
    ]);
  });

  test("with narrowToAbstained, a group whose leaves are all committed skips its job and the others keep theirs", () => {
    const phase = fillPhase<DemoValues>({
      target,
      chat: {} as ChatClient,
      model: "m",
      prepared,
      buildFillInstructions,
      narrowToAbstained: true,
    });
    // Both widget instances are fully committed in the draft; the singleton
    // house has no slot at all. Only the house job may survive.
    const draft = draftWith(twoWidgets(), {
      widgets: [committedLeaves("red", "1"), committedLeaves("blue", "2")],
    });
    expect(planNames(phase, draft)).toEqual(["demo-house-fill"]);
  });

  test("a job with one committed and one abstained leaf plans the whole job — the granularity is the job, not the leaf", () => {
    // Deliberately job-granular — leaf-level narrowing is gapFillPhase's (ADR
    // 0009). Widget 0's color is committed and its size abstained, so its job
    // re-asks about everything in it.
    const phase = fillPhase<DemoValues>({
      target,
      chat: {} as ChatClient,
      model: "m",
      prepared,
      buildFillInstructions,
      narrowToAbstained: true,
    });
    const draft = draftWith(twoWidgets(), {
      widgets: [leafEnvelope("red")],
    });
    expect(planNames(phase, draft)).toEqual([
      "demo-widgets-fill-0",
      "demo-widgets-fill-1",
      "demo-house-fill",
    ]);
  });

  test("two fills compose: [inventory, fill, fill(narrowToAbstained)] — the second plans strictly fewer jobs and the first fill's results survive", async () => {
    // The wave's stated purpose, pinned end to end. The first fill commits
    // every leaf of widget 0 and of the singleton house and abstains across
    // widget 1; the narrowed second fill plans only widget 1's job — no call
    // for what is already done — and its merge starts from the draft, so the
    // first fill's committed leaves survive it.
    const roster: Roster = {
      widgets: [currentCandidate("the red widget"), currentCandidate("the blue widget")],
      gadgets: [],
      house: [],
    };
    const draft0 = emptyDraft<DemoValues>();
    const inventory = inventoryPhase<DemoValues>({
      inventory: async () => roster,
      prepared,
      instanceCap: 10,
    });
    const draft1 = (await runPhase(inventory, draft0)).merged;

    const firstChat = fakeChat((name) => {
      if (name === "demo-widgets-fill-0") return { widgets: committedLeaves("red", "1") };
      if (name === "demo-widgets-fill-1") return { widgets: abstainedLeaves() };
      return { house: committedLeaves("main", "1950") };
    });
    const first = fillPhase<DemoValues>({
      target,
      chat: firstChat.chat,
      model: "demo-model",
      prepared,
      buildFillInstructions,
    });
    const firstRun = await runPhase(first, draft1);
    expect(firstRun.names).toEqual([
      "demo-widgets-fill-0",
      "demo-widgets-fill-1",
      "demo-house-fill",
    ]);

    const secondChat = fakeChat((name) => {
      if (name === "demo-widgets-fill-1") return { widgets: committedLeaves("second-pass", "2") };
      throw new Error(`the narrowed second fill must not call ${name}`);
    });
    const second = fillPhase<DemoValues>({
      target,
      chat: secondChat.chat,
      model: "demo-model",
      prepared,
      buildFillInstructions,
      narrowToAbstained: true,
    });
    const secondRun = await runPhase(second, firstRun.merged);
    expect(secondRun.names.length).toBeLessThan(firstRun.names.length);
    expect(secondRun.names).toEqual(["demo-widgets-fill-1"]);
    expect(secondChat.requests).toHaveLength(1);

    const fields = secondRun.merged.fields as Record<string, unknown>;
    const widgets = fields.widgets as { color: { value: unknown }; size: { value: unknown } }[];
    expect(widgets[0]!.color.value).toBe("red");
    expect(widgets[0]!.size.value).toBe("1");
    expect(widgets[1]!.color.value).toBe("second-pass");
    expect(widgets[1]!.size.value).toBe("2");
    const house = fields.house as { color: { value: unknown }; size: { value: unknown } };
    expect(house.color.value).toBe("main");
    expect(house.size.value).toBe("1950");
  });

  // --- The mixed arm: a "" piece's job narrows too ------------------------------
  //
  // The two "" misreads these tests pin (both pre-existing, both reaching much
  // further now that "" pieces are the common case for the motivating schema
  // class): `pieceLeafKeys` read `shape[""]` → `undefined` → `[]`, and
  // `jobFullyCommitted` read `fields[""]` — a slot no merge ever writes, loose
  // leaves landing at `fields.note` etc. — so a "" piece's fill job was NEVER
  // skipped: a narrowed second fill re-issued the loose job, and its merge's
  // `Object.assign` overwrote the first fill's committed loose leaves with a
  // fresh abstention's nulls. The "" branches now match `per-group.ts`'s
  // `partitionedLeafKeys`: the leaves are the piece schema's own top-level
  // keys, and the slot is the draft itself.
  const mixedNarrowPatch = z
    .object({
      widgets: z.array(widgetValues).optional(),
      note: z.string().nullable().optional(),
    })
    .strict();
  type MixedNarrowValues = z.infer<typeof mixedNarrowPatch>;
  const mixedNarrowTarget: ExtractionTarget<MixedNarrowValues> = {
    name: "demo",
    extractionSchema: enveloped(mixedNarrowPatch),
    instructions: "Demo extraction instructions.",
    examples: [],
  };
  const mixedNarrowPrepared = prepareGroups(
    mixedNarrowTarget,
    splitExtractionSchema(mixedNarrowTarget.extractionSchema, MAX_NULLABLE_UNIONS_PER_CALL),
  );
  const mixedNarrowCtx: PhaseContext<MixedNarrowValues> = {
    transcript: { text: "the full transcript", annotations: {} },
    target: mixedNarrowTarget,
  };

  /** The loose piece's fill response: the note committed, or abstained on null. */
  const noteResponse = (value: string | null): Record<string, unknown> => ({
    note: { value, sourceSpan: value === null ? null : "the note", confidence: 1 },
  });

  /** Plan, run every job against the phase's chat, fold through merge — the mixed-typed runner. */
  async function runMixedPhase(
    phase: Phase<MixedNarrowValues>,
    draft: PhaseDraft<MixedNarrowValues>,
  ): Promise<{ names: string[]; merged: PhaseDraft<MixedNarrowValues> }> {
    return phase.with(async (def) => {
      const items = def.plan(draft, mixedNarrowCtx);
      const names = items.map((item) => jobOf(item).requestName);
      const outcomes = [];
      for (const item of items) {
        outcomes.push({
          outcome: "result" as const,
          item,
          output: await def.run(item, draft, mixedNarrowCtx),
        });
      }
      return { names, merged: def.merge(draft, outcomes) };
    });
  }

  test("[inventory, fill, fill(narrowToAbstained)] over a mixed schema: a committed loose piece's job is not re-issued, and its value survives", async () => {
    // The two-fills composition above, extended to the loose portion. The
    // first fill commits the widget AND the loose note; the narrowed second
    // fill must plan NOTHING. Before the "" fix it re-issued "demo-fill", and
    // the second pass's abstention overwrote the committed note with null.
    const roster: Roster = { widgets: [currentCandidate("the red widget")] };
    const inventory = inventoryPhase<MixedNarrowValues>({
      inventory: async () => roster,
      prepared: mixedNarrowPrepared,
      instanceCap: 10,
    });
    const draft1 = (await runMixedPhase(inventory, emptyDraft<MixedNarrowValues>())).merged;

    const firstChat = fakeChat((name) => {
      if (name === "demo-widgets-fill-0") return { widgets: committedLeaves("red", "1") };
      if (name === "demo-fill") return noteResponse("a note");
      throw new Error(`unexpected request ${name}`);
    });
    const first = fillPhase<MixedNarrowValues>({
      target: mixedNarrowTarget,
      chat: firstChat.chat,
      model: "m",
      prepared: mixedNarrowPrepared,
      buildFillInstructions,
    });
    const firstRun = await runMixedPhase(first, draft1);
    expect(firstRun.names).toEqual(["demo-widgets-fill-0", "demo-fill"]);

    // The second pass would abstain on the note IF ASKED — the hazard's exact
    // shape: a model abstention becoming null over a committed value.
    const secondChat = fakeChat((name) => {
      if (name === "demo-fill") return noteResponse(null);
      throw new Error(`the narrowed second fill must not call ${name}`);
    });
    const second = fillPhase<MixedNarrowValues>({
      target: mixedNarrowTarget,
      chat: secondChat.chat,
      model: "m",
      prepared: mixedNarrowPrepared,
      buildFillInstructions,
      narrowToAbstained: true,
    });
    const secondRun = await runMixedPhase(second, firstRun.merged);

    expect(secondRun.names).toEqual([]);
    expect(secondChat.requests).toHaveLength(0);
    const fields = secondRun.merged.fields as Record<string, unknown>;
    expect((fields.note as { value: unknown }).value).toBe("a note");
    const widgets = fields.widgets as { color: { value: unknown } }[];
    expect(widgets[0]!.color.value).toBe("red");
  });

  test("a loose leaf that abstained re-plans exactly the loose job — the committed group stays skipped", async () => {
    // The narrowing is sound, not just absent: an abstained loose leaf is
    // re-asked, and only it. The first fill commits the widget and abstains
    // on the note; the narrowed second fill re-issues ONLY "demo-fill", and
    // the first fill's committed widget survives the second merge.
    const roster: Roster = { widgets: [currentCandidate("the red widget")] };
    const inventory = inventoryPhase<MixedNarrowValues>({
      inventory: async () => roster,
      prepared: mixedNarrowPrepared,
      instanceCap: 10,
    });
    const draft1 = (await runMixedPhase(inventory, emptyDraft<MixedNarrowValues>())).merged;

    const firstChat = fakeChat((name) => {
      if (name === "demo-widgets-fill-0") return { widgets: committedLeaves("red", "1") };
      if (name === "demo-fill") return noteResponse(null);
      throw new Error(`unexpected request ${name}`);
    });
    const first = fillPhase<MixedNarrowValues>({
      target: mixedNarrowTarget,
      chat: firstChat.chat,
      model: "m",
      prepared: mixedNarrowPrepared,
      buildFillInstructions,
    });
    const firstRun = await runMixedPhase(first, draft1);

    const secondChat = fakeChat((name) => {
      if (name === "demo-fill") return noteResponse("found on the second pass");
      throw new Error(`the narrowed second fill must not call ${name}`);
    });
    const second = fillPhase<MixedNarrowValues>({
      target: mixedNarrowTarget,
      chat: secondChat.chat,
      model: "m",
      prepared: mixedNarrowPrepared,
      buildFillInstructions,
      narrowToAbstained: true,
    });
    const secondRun = await runMixedPhase(second, firstRun.merged);

    expect(secondRun.names).toEqual(["demo-fill"]);
    expect(secondChat.requests).toHaveLength(1);
    const fields = secondRun.merged.fields as Record<string, unknown>;
    expect((fields.note as { value: unknown }).value).toBe("found on the second pass");
    const widgets = fields.widgets as { color: { value: unknown } }[];
    expect(widgets[0]!.color.value).toBe("red");
  });
});

describe("fillPhase — id", () => {
  test('defaults to "fill" and honours an explicit id', () => {
    const defaults = fillPhase<DemoValues>({
      target,
      chat: {} as ChatClient,
      model: "m",
      prepared,
      buildFillInstructions,
    });
    expect(defaults.id).toBe("fill");
    const renamed = fillPhase<DemoValues>({
      target,
      chat: {} as ChatClient,
      model: "m",
      prepared,
      buildFillInstructions,
      id: "fill-second-pass",
    });
    expect(renamed.id).toBe("fill-second-pass");
  });
});

describe("fillPhase — onItemFailure", () => {
  /** The abstained leaf every failed fill writes — the provenance floor. */
  const abstainedLeaf = () => nullEnvelope();

  /** Both leaves committed — "committed" is the value-non-null sense. */
  const committedLeaves = (colorValue: string, sizeValue: string): Record<string, unknown> => ({
    color: { value: colorValue, sourceSpan: "span", confidence: 1 },
    size: { value: sizeValue, sourceSpan: "span", confidence: 1 },
  });

  /**
   * A ChatClient answering every request except the ones `fails` names, which
   * it throws for — deterministically, on every attempt, so the engine's retry
   * budget cannot rescue the item and the failure is the item's, not a flake.
   */
  function chatFailing(
    fails: (requestName: string) => boolean,
    respond: (requestName: string) => unknown,
  ): { chat: ChatClient; requests: ChatRequest[] } {
    const requests: ChatRequest[] = [];
    return {
      requests,
      chat: {
        complete: async (request) => {
          const name = request.response_format.json_schema.name;
          requests.push(request);
          if (fails(name)) throw new Error(`transport failure for ${name}`);
          return { content: JSON.stringify(respond(name)), finishReason: "stop" as const };
        },
      },
    };
  }

  /** Drive [inventory, ...fills] through the engine — `delay` injected so retries sleep zero. */
  async function extractWith<V extends Record<string, unknown>, P = NoProvenance>(
    valuesTarget: ExtractionTarget<V, P>,
    prepared_: readonly PreparedGroup[],
    roster: Roster,
    ...fills: readonly Phase<V, P>[]
  ) {
    const inventory = inventoryPhase<V, P>({
      inventory: async () => roster,
      prepared: prepared_,
      instanceCap: 10,
    });
    const extractor = phasedExtractor<V, P>({
      target: valuesTarget,
      phases: [inventory, ...fills],
      delay: async () => {},
    });
    return extractor.extract({ text: "the full transcript", annotations: {} });
  }

  /** One fill pass over a target's prepared groups, with per-pass overrides. */
  const fillPass = <V extends Record<string, unknown>, P = NoProvenance>(
    valuesTarget: ExtractionTarget<V, P>,
    prepared_: readonly PreparedGroup[],
    chat: ChatClient,
    overrides: Partial<FillPhaseOptions<V, P>> = {},
  ): Phase<V, P> =>
    fillPhase<V, P>({
      target: valuesTarget,
      chat,
      model: "demo-model",
      prepared: prepared_,
      buildFillInstructions,
      ...overrides,
    });

  const standardRespond = (name: string): unknown =>
    name.startsWith("demo-house-fill")
      ? houseResponse()
      : widgetResponse(name.endsWith("1") ? "blue" : "red");

  test("a failed singleton piece resolves with an all-abstained entry; sibling groups keep their values", async () => {
    const { chat } = chatFailing((name) => name === "demo-house-fill", standardRespond);
    const result = await extractWith(
      target,
      prepared,
      twoWidgets(),
      fillPass(target, prepared, chat, { onItemFailure: "skip" }),
    );

    const fields = result.fields as Record<string, unknown>;
    expect(fields.house).toEqual({ color: abstainedLeaf(), size: abstainedLeaf() });
    expect(fields.widgets).toEqual([leafEnvelope("red"), leafEnvelope("blue")]);
  });

  test("a failed collection instance resolves with the abstained element at that index; siblings keep theirs", async () => {
    const { chat } = chatFailing((name) => name === "demo-widgets-fill-1", standardRespond);
    const result = await extractWith(
      target,
      prepared,
      twoWidgets(),
      fillPass(target, prepared, chat, { onItemFailure: "skip" }),
    );

    const fields = result.fields as Record<string, unknown>;
    expect(fields.widgets).toHaveLength(2);
    expect((fields.widgets as unknown[])[0]).toEqual(leafEnvelope("red"));
    expect((fields.widgets as unknown[])[1]).toEqual({
      color: abstainedLeaf(),
      size: abstainedLeaf(),
    });
    expect(fields.house).toEqual(leafEnvelope("main"));
  });

  test("a failed piece of a partitioned group abstains only its leaves; the succeeding sibling's survive the recombine", async () => {
    const roster: Roster = { systems: [currentCandidate("a"), currentCandidate("b")] };
    const { chat } = chatFailing(
      (name) => name === "demo-systems-fill-1-1",
      (name) => {
        const [, part, instance] = /-(\d+)-(\d+)$/.exec(name)!;
        const leaf = part === "0" ? "color" : "size";
        return {
          systems: { [leaf]: { value: `${instance}-${leaf}`, sourceSpan: "span", confidence: 1 } },
        };
      },
    );
    const result = await extractWith(
      systemsTarget,
      partitionedSystems,
      roster,
      fillPass(systemsTarget, partitionedSystems, chat, { onItemFailure: "skip" }),
    );

    const systems = (result.fields as Record<string, unknown>).systems as {
      color: { value: string | null };
      size: { value: string | null };
    }[];
    expect(systems[0]).toEqual({
      color: { value: "0-color", sourceSpan: "span", confidence: 1 },
      size: { value: "0-size", sourceSpan: "span", confidence: 1 },
    });
    expect(systems[1]!.color).toEqual({ value: "1-color", sourceSpan: "span", confidence: 1 });
    expect(systems[1]!.size).toEqual(abstainedLeaf());
  });

  test("a collection whose every job failed yields a full array of abstained elements — no holes", async () => {
    const roster: Roster = { systems: [currentCandidate("a"), currentCandidate("b")] };
    const { chat } = chatFailing(
      () => true,
      () => {
        throw new Error("every systems fill fails");
      },
    );
    const result = await extractWith(
      systemsTarget,
      partitionedSystems,
      roster,
      fillPass(systemsTarget, partitionedSystems, chat, { onItemFailure: "skip" }),
    );

    const systems = (result.fields as Record<string, unknown>).systems as unknown[];
    expect(systems).toHaveLength(2);
    expect(systems[0]).toEqual({ color: abstainedLeaf(), size: abstainedLeaf() });
    expect(systems[1]).toEqual({ color: abstainedLeaf(), size: abstainedLeaf() });
  });

  test("the option absent: the same failure rejects with the original transport error, not a SchemaParseError", async () => {
    // The same failing fixture as the skip tests — the only difference is the
    // option. Abort stays today's (and the default's) behaviour: the transport
    // error rejects the run, it does not become an abstention.
    const { chat } = chatFailing((name) => name === "demo-house-fill", standardRespond);
    const rejection: unknown = await extractWith(
      target,
      prepared,
      twoWidgets(),
      fillPass(target, prepared, chat),
    ).then(
      () => null,
      (cause: unknown) => cause,
    );
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toBe("transport failure for demo-house-fill");
    expect(rejection).not.toBeInstanceOf(SchemaParseError);
  });

  test("a failed re-ask under narrowToAbstained keeps the slot's present envelopes — even a null value carrying a span", async () => {
    // THE under-fill pin: the first fill commits widget 0's color and leaves
    // its size an abstained leaf WITH a citation span; the narrowed second fill
    // re-asks exactly that slot and its call fails. The error arm must fill
    // only ABSENT keys — a present envelope stays untouched whatever its value,
    // because its sourceSpan is evidence a later pass relies on.
    const spannedNull = {
      value: null,
      confidence: 0.4,
      sourceSpan: "no size stated for the red widget",
    };
    const first = chatFailing(
      () => false,
      (name) => {
        if (name === "demo-widgets-fill-0")
          return {
            widgets: {
              color: { value: "red", sourceSpan: "span", confidence: 1 },
              size: spannedNull,
            },
          };
        // Everything except widget 0's size fully committed, so the narrowed
        // second pass re-issues exactly one job.
        if (name === "demo-widgets-fill-1") return { widgets: committedLeaves("blue", "2") };
        return { house: committedLeaves("main", "1950") };
      },
    );
    const second = chatFailing(
      () => true,
      () => {
        throw new Error("the re-ask must fail");
      },
    );

    const result = await extractWith(
      target,
      prepared,
      twoWidgets(),
      fillPass(target, prepared, first.chat),
      fillPass(target, prepared, second.chat, {
        id: "fill-second-pass",
        narrowToAbstained: true,
        onItemFailure: "skip",
      }),
    );

    // The narrowed pass re-issued exactly the one uncommitted slot (each
    // attempt of its retry loop appears; the name set is the pin).
    const reasked = new Set(second.requests.map((r) => r.response_format.json_schema.name));
    expect([...reasked]).toEqual(["demo-widgets-fill-0"]);

    const widgets = (result.fields as Record<string, unknown>).widgets as {
      color: { value: unknown };
      size: unknown;
    }[];
    expect(widgets[0]!.color.value).toBe("red");
    expect(widgets[0]!.size).toEqual(spannedNull);
    expect(widgets[1]).toEqual(committedLeaves("blue", "2"));
  });

  test("a failed flat piece resolves with its leaves abstained at the top level", async () => {
    const { chat } = chatFailing(
      () => true,
      () => undefined,
    );
    const result = await extractWith(
      flatTarget,
      fallbackPrepared,
      {},
      fillPass(flatTarget, fallbackPrepared, chat, { onItemFailure: "skip" }),
    );

    expect(result.fields).toEqual({ color: abstainedLeaf(), size: abstainedLeaf() });
  });

  test("a failed flat re-ask under narrowToAbstained keeps the draft's present leaves", async () => {
    // The flat arm's own under-fill pin: its writes land on the draft's top
    // level, so a naive assign would blank the committed color and the span.
    const spannedNull = { value: null, confidence: 0.4, sourceSpan: "no size stated" };
    const first = chatFailing(
      () => false,
      () => ({ color: { value: "red", sourceSpan: "span", confidence: 1 }, size: spannedNull }),
    );
    const second = chatFailing(
      () => true,
      () => undefined,
    );

    const result = await extractWith(
      flatTarget,
      fallbackPrepared,
      {},
      fillPass(flatTarget, fallbackPrepared, first.chat),
      fillPass(flatTarget, fallbackPrepared, second.chat, {
        id: "fill-second-pass",
        narrowToAbstained: true,
        onItemFailure: "skip",
      }),
    );

    expect(second.requests.length).toBeGreaterThan(0);
    expect(result.fields).toEqual({
      color: { value: "red", sourceSpan: "span", confidence: 1 },
      size: spannedNull,
    });
  });
});
