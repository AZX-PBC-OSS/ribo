import {
  emptyDraft,
  emptyNotes,
  enveloped,
  phaseBuilder,
  phasedExtractor,
  validatePhases,
} from "@azx/ribo-core";
import type {
  ChatClient,
  ChatRequest,
  DeepPartial,
  Enveloped,
  ExtractionTarget,
  Phase,
  PhaseContext,
  PhaseDraft,
  Roster,
} from "@azx/ribo-core";
import { z } from "zod";
import { describe, expect, test } from "vitest";

import { inventoryPhase, rosterNoteKey } from "./inventory-phase.js";
import { fillPhase } from "./fill-phase.js";
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
