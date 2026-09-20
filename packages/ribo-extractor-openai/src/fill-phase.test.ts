import { emptyDraft, emptyNotes, enveloped } from "@azx/ribo-core";
import type {
  DeepPartial,
  Enveloped,
  ExtractionTarget,
  Phase,
  PhaseContext,
  PhaseDraft,
  Roster,
} from "@azx/ribo-core";
import type { ChatClient, ChatRequest } from "./chat-client.js";
import { z } from "zod";
import { describe, expect, test } from "vitest";

import { inventoryPhase, rosterNoteKey } from "./inventory-phase.js";
import { fillPhase } from "./fill-phase.js";
import type { PreparedGroup } from "./instance-fill.js";

/**
 * Phase-level tests for the scoped-instance fill phase, against hand-built
 * drafts — the engine is not involved here, so `plan`/`run`/`merge` are driven
 * directly through the phase's `with` (the same fold
 * `gap-fill-phase.test.ts` uses). The ordering test drives `merge` DIRECTLY:
 * `mapWithPool` returns an index-ordered array, so outcomes always reach
 * `merge` in plan order and an extract-level "reversed outcomes" test would
 * pass against any implementation, including one that pushes in arrival order.
 */

const widgetValues = z
  .object({
    color: z.string().nullable().optional(),
    size: z.number().nullable().optional(),
  })
  .strict();

const demoValuesSchema = z
  .object({
    widgets: z.array(widgetValues).optional(),
    gadgets: z.array(widgetValues).optional(),
    house: z.object({ name: z.string().nullable().optional() }).strict().optional(),
  })
  .strict();

type DemoValues = z.infer<typeof demoValuesSchema>;

const target: ExtractionTarget<DemoValues> = {
  name: "demo",
  extractionSchema: enveloped(demoValuesSchema),
  instructions: "Demo extraction instructions.",
  examples: [],
};

/** A minimal but valid PreparedGroup; `leafKeys` only for a partitioned piece. */
function preparedGroup(
  key: string,
  isCollection: boolean,
  leaves: readonly string[] = ["color", "size"],
  part?: number,
  parts?: number,
): PreparedGroup {
  // Each leaf is an envelope ({ value, sourceSpan, confidence }) — the shape a
  // fill response carries, as in the instance-fill suite.
  const leafShape = z.strictObject(
    Object.fromEntries(
      leaves.map((leaf) => [
        leaf,
        z.strictObject({
          value: z.string().nullable().optional(),
          sourceSpan: z.string().nullable().optional(),
          confidence: z.number().optional(),
        }),
      ]),
    ),
  );
  // A fill's piece schema is the SINGLE-INSTANCE wrapper — `z.strictObject({
  // [key]: element })` for a collection group (isCollection true), never an
  // array — which is what makes "a fill cannot add an instance" true.
  const schema = z.strictObject({ [key]: leafShape });
  const partSuffix = part !== undefined ? `-${part}` : "";
  return {
    key,
    isCollection,
    schema,
    jsonSchema: z.toJSONSchema(schema, { target: "draft-2020-12" }),
    name: key ? `demo-${key}-fill${partSuffix}` : "demo-fill",
    context: `fill demo "${key}"`,
    part,
    parts,
    leafKeys: part !== undefined ? leaves : undefined,
  };
}

const prepared: readonly PreparedGroup[] = [
  preparedGroup("widgets", true),
  preparedGroup("gadgets", true),
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
    const partitioned: readonly PreparedGroup[] = [
      preparedGroup("systems", true, ["color"], 0, 2),
      preparedGroup("systems", true, ["size"], 1, 2),
    ];
    const roster: Roster = { systems: [currentCandidate("a"), currentCandidate("b")] };
    const partitionedPhase = fillPhase<DemoValues>({
      target,
      chat: {} as ChatClient,
      model: "m",
      prepared: partitioned,
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
    const fallback: readonly PreparedGroup[] = [preparedGroup("", false)];
    const { chat, requests } = fakeChat(() => ({ "": leafEnvelope("x") }));
    const fallbackPhase = fillPhase<DemoValues>({
      target,
      chat,
      model: "m",
      prepared: fallback,
      buildFillInstructions,
    });
    await fallbackPhase.with(async (def) => {
      const draft = draftWith({});
      const [item] = def.plan(draft, ctx);
      await def.run(item!, draft, ctx);
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
    const partitioned: readonly PreparedGroup[] = [
      preparedGroup("systems", true, ["color"], 0, 2),
      preparedGroup("systems", true, ["size"], 1, 2),
    ];
    const roster: Roster = { systems: [currentCandidate("a"), currentCandidate("b")] };
    const partitionedPhase = fillPhase<DemoValues>({
      target,
      chat: {} as ChatClient,
      model: "m",
      prepared: partitioned,
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
    const partitioned: readonly PreparedGroup[] = [
      preparedGroup("systems", true, ["color"], 0, 2),
      preparedGroup("systems", true, ["size"], 1, 2),
    ];
    const roster: Roster = { systems: [currentCandidate("a"), currentCandidate("b")] };
    const merged = await fold(roster, partitioned, (requestName) => {
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

describe("fillPhase — metadata", () => {
  test("declares seedsDraft — its merge writes envelopes from the roster into the draft's fields", () => {
    const phase = fillPhase<DemoValues>({
      target,
      chat: {} as ChatClient,
      model: "m",
      prepared,
      buildFillInstructions,
    });
    expect(phase.seedsDraft).toBe(true);
    expect(phase.requiresDraft).toBeUndefined();
  });
});

describe("fillPhase — narrowToAbstained", () => {
  /**
   * Both leaves committed — the slot a fill response leaves when it commits
   * everything. "Committed" is the value-non-null sense the rest of the
   * codebase uses; a slot holding any null value is not committed.
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
    // Deliberately job-granular: leaf-level narrowing — re-asking exactly the
    // abstained leaf — is what gapFillPhase does and is a different phase
    // (design `sp4a-composable-phases-design.md` §7 records the limit). Widget
    // 0's color is committed and its size abstained, so its job re-asks about
    // everything in it.
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
