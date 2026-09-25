import { describe, expect, test } from "vitest";
import { z } from "zod";

import { enveloped } from "../../provenance/enveloped.js";
import { SchemaParseError } from "../schema-parse-error.js";
import { TerminalError } from "../../storage/backoff.js";
import type { ChatClient, ChatCompletion, ChatRequest } from "../../phases/chat-client.js";
import type { Enveloped } from "../../provenance/enveloped.js";
import type { ExtractionTarget } from "../extractor.js";
import type { PhaseUnit } from "../extraction-observer.js";
import type { RetryBudget } from "../../async/retry-budget.js";
import {
  buildFillMessages,
  projectFillExample,
  scopedInstanceExtractor,
  type FillScope,
  type Roster,
} from "./instance-fill.js";

/**
 * Must-fail tests for Task 10 — scoped per-instance fills and assembly. All calls
 * run against a fake {@link ChatClient}, so nothing here touches a model or network.
 */

// --- A tiny two-group target: one collection (`widgets`) and one singleton (`house`). ---

const widgetValues = z
  .object({
    color: z.string().nullable().optional(),
    size: z.number().nullable().optional(),
  })
  .strict();

const houseValues = z
  .object({
    name: z.string().nullable().optional(),
  })
  .strict();

const demoValuesSchema = z
  .object({
    widgets: z.array(widgetValues).optional(),
    gadgets: z.array(widgetValues).optional(),
    house: houseValues.optional(),
  })
  .strict();

type DemoValues = z.infer<typeof demoValuesSchema>;

const demoExtractionSchema = enveloped(demoValuesSchema);

const env = <const V>(value: V, sourceSpan: string | null, confidence = 1) => ({
  value,
  sourceSpan,
  confidence,
});

const demoExample: Enveloped<DemoValues> = {
  widgets: [
    { color: env("red", "red widget", 0.9), size: env(null, null) },
    { color: env("blue", "blue widget", 0.8), size: env(5, "five", 0.9) },
  ],
  gadgets: [{ color: env("green", "green gadget", 0.7), size: env(null, null) }],
  house: { name: env("main", "main house", 1) },
};

const target: ExtractionTarget<DemoValues> = {
  name: "demo",
  extractionSchema: demoExtractionSchema,
  instructions: "Demo extraction instructions.",
  examples: [{ transcript: "Example transcript.", fields: demoExample }],
};

// --- Helpers -----------------------------------------------------------------

function makeRoster(overrides: Partial<Roster> = {}): Roster {
  return {
    widgets: [],
    gadgets: [],
    house: [],
    ...overrides,
  };
}

function fakeChat(responder: (request: ChatRequest, index: number) => ChatCompletion): {
  chat: ChatClient;
  requests: ChatRequest[];
} {
  const requests: ChatRequest[] = [];
  let index = 0;
  const chat: ChatClient = {
    complete: async (request) => {
      requests.push(request);
      return responder(request, index++);
    },
  };
  return { chat, requests };
}

function buildFillInstructions(groupKey: string, scope: FillScope): string {
  return `Fill instructions for ${groupKey}.\n\nScope:\n${JSON.stringify(scope)}`;
}

function widgetResponse(color: string, size: number | null): Record<string, unknown> {
  return {
    widgets: {
      color: { value: color, sourceSpan: color, confidence: 1 },
      size: { value: size, sourceSpan: size === null ? null : String(size), confidence: 1 },
    },
  };
}

function houseResponse(name: string): Record<string, unknown> {
  return {
    house: {
      name: { value: name, sourceSpan: name, confidence: 1 },
    },
  };
}

// --- Tests -------------------------------------------------------------------

describe("scopedInstanceExtractor", () => {
  test("a mixed schema: the roster pass skips the loose piece, fills run one call per piece, and the merged result parses clean", async () => {
    // The scoped-instance preset over a MIXED schema (collection + singleton +
    // loose leaf) — verify-only for the mixed-schema split (design §10's
    // scoped-instance must-fail, §8 step 4): the loose piece flows the
    // existing "" branches of prepareGroups, the inventory phase and the fill
    // phase, none of which changed.
    const mixedValuesSchema = z
      .object({
        widgets: z.array(widgetValues).optional(),
        house: houseValues.optional(),
        note: z.string().nullable().optional(),
      })
      .strict();
    type MixedValues = z.infer<typeof mixedValuesSchema>;
    const mixedTarget: ExtractionTarget<MixedValues> = {
      name: "demo-mixed",
      extractionSchema: enveloped(mixedValuesSchema),
      instructions: "Demo extraction instructions.",
      examples: [],
    };

    const roster: Roster = {
      widgets: [
        {
          mentionSpan: "the red widget",
          discriminator: "the red widget",
          distinguishedBy: null,
          eligibility: "current",
          eligibilitySpan: null,
        },
      ],
    };

    const { chat, requests } = fakeChat((request) => {
      const name = request.response_format.json_schema.name;
      if (name === "demo-mixed-widgets-fill-0") {
        return { content: JSON.stringify(widgetResponse("red", null)), finishReason: "stop" };
      }
      if (name === "demo-mixed-house-fill") {
        return { content: JSON.stringify(houseResponse("main")), finishReason: "stop" };
      }
      if (name === "demo-mixed-fill") {
        // The loose piece's fill: the response is the loose leaves directly —
        // no wrapping key — exactly the flat fallback's answer shape.
        return {
          content: JSON.stringify({
            note: { value: "a note", sourceSpan: "the note", confidence: 1 },
          }),
          finishReason: "stop",
        };
      }
      throw new Error(`Unexpected request: ${name}`);
    });

    const extractor = scopedInstanceExtractor({
      target: mixedTarget,
      chat,
      model: "demo-model",
      inventory: async () => roster,
      buildFillInstructions,
    });

    const result = await extractor.extract({ text: "the full transcript", annotations: {} });

    // The merged whole parses clean against the mixed schema: the collection
    // by instance index, the singleton under its key, the loose leaf flat.
    expect(result.fields.widgets).toHaveLength(1);
    expect(result.fields.widgets?.[0]?.color.value).toBe("red");
    expect(result.fields.house?.name.value).toBe("main");
    expect(result.fields.note?.value).toBe("a note");
    // Inventory + one fill per piece. The loose piece is one call, named
    // without the group infix — the flat fallback's fill name.
    expect(result.usage.calls).toBe(4);
    expect(requests.map((r) => r.response_format.json_schema.name).sort()).toEqual([
      "demo-mixed-fill",
      "demo-mixed-house-fill",
      "demo-mixed-widgets-fill-0",
    ]);
    // The roster pass never touched the loose piece: no "" key anywhere.
    // (Object.keys, not toHaveProperty: the matcher cannot take a "" key path.)
    expect(Object.keys(result.statedEmptyGroups ?? {})).not.toContain("");
  });

  test("fills one instance per current candidate and assembles arrays in roster order", async () => {
    const roster = makeRoster({
      widgets: [
        {
          mentionSpan: "the red widget",
          discriminator: "the red widget",
          distinguishedBy: null,
          eligibility: "current",
          eligibilitySpan: null,
        },
        {
          mentionSpan: "the blue widget",
          discriminator: "the blue widget",
          distinguishedBy: "the blue widget",
          eligibility: "current",
          eligibilitySpan: null,
        },
      ],
    });

    const { chat, requests } = fakeChat((request) => {
      const name = request.response_format.json_schema.name;
      if (name === "demo-widgets-fill-0") {
        return { content: JSON.stringify(widgetResponse("red", null)), finishReason: "stop" };
      }
      if (name === "demo-widgets-fill-1") {
        return { content: JSON.stringify(widgetResponse("blue", 5)), finishReason: "stop" };
      }
      if (name === "demo-house-fill") {
        return { content: JSON.stringify(houseResponse("main")), finishReason: "stop" };
      }
      throw new Error(`Unexpected request: ${name}`);
    });

    const extractor = scopedInstanceExtractor({
      target,
      chat,
      model: "demo-model",
      inventory: async () => roster,
      buildFillInstructions,
    });

    const result = await extractor.extract({ text: "the full transcript", annotations: {} });

    expect(result.fields.widgets).toHaveLength(2);
    expect(result.fields.widgets?.[0]?.color.value).toBe("red");
    expect(result.fields.widgets?.[1]?.color.value).toBe("blue");
    expect(result.fields.house?.name.value).toBe("main");
    expect(result.usage.calls).toBe(4); // inventory + 2 widget fills + 1 house fill
    expect(requests).toHaveLength(3);
  });

  test("the fill response schema is a single object — a fill cannot add an instance", async () => {
    const roster = makeRoster({
      widgets: [
        {
          mentionSpan: "the red widget",
          discriminator: "the red widget",
          distinguishedBy: null,
          eligibility: "current",
          eligibilitySpan: null,
        },
      ],
    });

    const { chat } = fakeChat(() => ({
      // Wrong: an array in the response. The per-instance wrapper schema expects a single object.
      content: JSON.stringify({ widgets: [{ color: "red" }, { color: "blue" }] }),
      finishReason: "stop",
    }));

    const extractor = scopedInstanceExtractor({
      target,
      chat,
      model: "demo-model",
      inventory: async () => roster,
      buildFillInstructions,
    });

    await expect(
      extractor.extract({ text: "the full transcript", annotations: {} }),
    ).rejects.toBeInstanceOf(SchemaParseError);
  });

  test("the scope block names sibling discriminators, spans, and excluded candidates", async () => {
    const roster = makeRoster({
      widgets: [
        {
          mentionSpan: "the red widget",
          discriminator: "the red widget",
          distinguishedBy: null,
          eligibility: "current",
          eligibilitySpan: null,
        },
        {
          mentionSpan: "the blue widget",
          discriminator: "the blue widget",
          distinguishedBy: "the blue widget",
          eligibility: "current",
          eligibilitySpan: null,
        },
        {
          mentionSpan: "the broken widget",
          discriminator: "the broken widget",
          distinguishedBy: null,
          eligibility: "decommissioned",
          eligibilitySpan: "the broken widget is decommissioned",
        },
      ],
    });

    const { chat, requests } = fakeChat((request) => {
      const name = request.response_format.json_schema.name;
      if (name === "demo-widgets-fill-0") {
        return { content: JSON.stringify(widgetResponse("red", null)), finishReason: "stop" };
      }
      if (name === "demo-widgets-fill-1") {
        return { content: JSON.stringify(widgetResponse("blue", 5)), finishReason: "stop" };
      }
      return { content: JSON.stringify(houseResponse("main")), finishReason: "stop" };
    });

    const extractor = scopedInstanceExtractor({
      target,
      chat,
      model: "demo-model",
      inventory: async () => roster,
      buildFillInstructions,
    });

    await extractor.extract({ text: "the full transcript", annotations: {} });

    const firstFill = requests.find(
      (r) => r.response_format.json_schema.name === "demo-widgets-fill-0",
    );
    expect(firstFill).toBeDefined();
    const system = firstFill!.messages[0]!.content;
    expect(system).toContain("the red widget");
    expect(system).toContain("the blue widget");
    expect(system).toContain("the broken widget");
    expect(system).toContain("the broken widget is decommissioned");
  });

  test("the fill call receives the whole transcript, not a slice", async () => {
    const transcript = "First paragraph about the widget. Second paragraph about the house.";
    const roster = makeRoster({
      widgets: [
        {
          mentionSpan: "the widget",
          discriminator: "the widget",
          distinguishedBy: null,
          eligibility: "current",
          eligibilitySpan: null,
        },
      ],
    });

    const { chat, requests } = fakeChat((request) => {
      const name = request.response_format.json_schema.name;
      if (name === "demo-house-fill") {
        return { content: JSON.stringify(houseResponse("main")), finishReason: "stop" };
      }
      return { content: JSON.stringify(widgetResponse("red", null)), finishReason: "stop" };
    });

    const extractor = scopedInstanceExtractor({
      target,
      chat,
      model: "demo-model",
      inventory: async () => roster,
      buildFillInstructions,
    });

    await extractor.extract({ text: transcript, annotations: {} });

    const widgetFill = requests.find(
      (r) => r.response_format.json_schema.name === "demo-widgets-fill-0",
    );
    expect(widgetFill).toBeDefined();
    const last = widgetFill!.messages[widgetFill!.messages.length - 1];
    expect(last).toEqual({ role: "user", content: transcript });
  });

  test("a group with no current candidates makes no fill calls and yields an empty array", async () => {
    const roster = makeRoster({
      widgets: [
        {
          mentionSpan: "the old widget",
          discriminator: "the old widget",
          distinguishedBy: null,
          eligibility: "decommissioned",
          eligibilitySpan: "decommissioned",
        },
      ],
    });

    const { chat, requests } = fakeChat(() => ({
      content: JSON.stringify(houseResponse("main")),
      finishReason: "stop",
    }));

    const extractor = scopedInstanceExtractor({
      target,
      chat,
      model: "demo-model",
      inventory: async () => roster,
      buildFillInstructions,
    });

    const result = await extractor.extract({ text: "the full transcript", annotations: {} });

    expect(result.fields.widgets).toEqual([]);
    expect(
      requests.some((r) => r.response_format.json_schema.name.startsWith("demo-widgets-fill")),
    ).toBe(false);
  });

  test("exceeding the instance cap fails loudly rather than truncating", async () => {
    const roster = makeRoster({
      widgets: [
        {
          mentionSpan: "a",
          discriminator: "a",
          distinguishedBy: null,
          eligibility: "current",
          eligibilitySpan: null,
        },
        {
          mentionSpan: "b",
          discriminator: "b",
          distinguishedBy: "b",
          eligibility: "current",
          eligibilitySpan: null,
        },
      ],
    });

    const { chat } = fakeChat(() => ({
      content: JSON.stringify(widgetResponse("red", null)),
      finishReason: "stop",
    }));

    const extractor = scopedInstanceExtractor({
      target,
      chat,
      model: "demo-model",
      inventory: async () => roster,
      buildFillInstructions,
      instanceCap: 1,
    });

    await expect(
      extractor.extract({ text: "the full transcript", annotations: {} }),
    ).rejects.toThrow("cap");
  });

  test("a stated-none group surfaces on statedEmptyGroups and makes zero fill calls", async () => {
    const roster = makeRoster({
      widgets: { stated: "none", span: "there's no attic access" },
      gadgets: [],
    });

    const { chat, requests } = fakeChat((request) => {
      const name = request.response_format.json_schema.name;
      if (name === "demo-house-fill") {
        return { content: JSON.stringify(houseResponse("main")), finishReason: "stop" };
      }
      throw new Error(`Unexpected request: ${name}`);
    });

    const extractor = scopedInstanceExtractor({
      target,
      chat,
      model: "demo-model",
      inventory: async () => roster,
      buildFillInstructions,
    });

    const result = await extractor.extract({ text: "the full transcript", annotations: {} });

    expect(result.statedEmptyGroups).toEqual({ widgets: "there's no attic access" });
    expect(result.statedEmptyGroups?.gadgets).toBeUndefined();
    expect(result.fields.widgets).toEqual([]);
    expect(result.fields.gadgets).toEqual([]);
    expect(
      requests.some((r) => r.response_format.json_schema.name.startsWith("demo-widgets-fill")),
    ).toBe(false);
  });

  test("a singleton group is unaffected even if roster holds a stated-none shape for its key", async () => {
    const roster = makeRoster({
      house: { stated: "none", span: "there's no house" } as unknown as readonly {
        mentionSpan: string;
        discriminator: string;
        distinguishedBy: string | null;
        eligibility: string;
        eligibilitySpan: string | null;
      }[],
    });

    const { chat, requests } = fakeChat(() => ({
      content: JSON.stringify(houseResponse("main")),
      finishReason: "stop",
    }));

    const extractor = scopedInstanceExtractor({
      target,
      chat,
      model: "demo-model",
      inventory: async () => roster,
      buildFillInstructions,
    });

    const result = await extractor.extract({ text: "the full transcript", annotations: {} });

    // The singleton branch runs exactly as today regardless of roster shape.
    expect(result.fields.house?.name.value).toBe("main");
    expect(requests.some((r) => r.response_format.json_schema.name === "demo-house-fill")).toBe(
      true,
    );
  });
});

describe("projectFillExample", () => {
  test("projects a collection example to the single element at the requested index", () => {
    const projected = projectFillExample(
      { transcript: "Example.", fields: demoExample },
      "widgets",
      1,
    );
    expect(projected).toEqual({
      transcript: "Example.",
      fields: {
        widgets: {
          color: { value: "blue", sourceSpan: "blue widget", confidence: 0.8 },
          size: { value: 5, sourceSpan: "five", confidence: 0.9 },
        },
      },
    });
  });

  test("falls back to the first element when the requested index is out of range", () => {
    const projected = projectFillExample(
      { transcript: "Example.", fields: demoExample },
      "widgets",
      99,
    );
    expect(projected).toEqual({
      transcript: "Example.",
      fields: {
        widgets: {
          color: { value: "red", sourceSpan: "red widget", confidence: 0.9 },
          size: { value: null, sourceSpan: null, confidence: 1 },
        },
      },
    });
  });

  test("projects a singleton example unchanged", () => {
    const projected = projectFillExample(
      { transcript: "Example.", fields: demoExample },
      "house",
      0,
    );
    expect(projected).toEqual({
      transcript: "Example.",
      fields: {
        house: {
          name: { value: "main", sourceSpan: "main house", confidence: 1 },
        },
      },
    });
  });

  test("returns null when the group key is absent from the example", () => {
    const projected = projectFillExample(
      { transcript: "Example.", fields: { house: demoExample.house } as Enveloped<DemoValues> },
      "widgets",
      0,
    );
    expect(projected).toBeNull();
  });
});

describe("buildFillMessages", () => {
  test("the assistant turn is a single-instance object, not a collection array", () => {
    const scope: FillScope = {
      groupKey: "widgets",
      positive: {
        mentionSpan: "x",
        discriminator: "x",
        distinguishedBy: null,
        eligibility: "current",
        eligibilitySpan: null,
      },
      positiveIndex: 0,
      siblings: [],
      excluded: [],
    };

    const messages = buildFillMessages(
      target,
      "widgets",
      0,
      scope,
      "Live transcript.",
      buildFillInstructions,
    );

    expect(messages).toHaveLength(4);
    expect(messages[0]!.role).toBe("system");
    expect(messages[1]!.role).toBe("user");
    expect(messages[2]!.role).toBe("assistant");
    expect(messages[3]!).toEqual({ role: "user", content: "Live transcript." });

    const assistant = JSON.parse(messages[2]!.content) as Record<string, unknown>;
    expect(Object.keys(assistant)).toEqual(["widgets"]);
    expect(Array.isArray(assistant["widgets"])).toBe(false);
    expect(assistant["widgets"]).toEqual({
      color: { value: "red", sourceSpan: "red widget", confidence: 0.9 },
      size: { value: null, sourceSpan: null, confidence: 1 },
    });
  });
});

// --- Leaf-count partitioning: groups over the default per-call leaf cap ------
//
// A collection group (`systems`) whose per-instance leaf count exceeds the
// default cap is filled as one call per PIECE per instance, and a singleton
// group (`profile`) as one call per piece; the pieces' responses must be
// recombined per (group, instance), not last-piece-wins.

const tenLeafValues = z
  .object({
    f1: z.string().nullable().optional(),
    f2: z.string().nullable().optional(),
    f3: z.string().nullable().optional(),
    f4: z.string().nullable().optional(),
    f5: z.string().nullable().optional(),
    f6: z.string().nullable().optional(),
    f7: z.string().nullable().optional(),
    f8: z.string().nullable().optional(),
    f9: z.string().nullable().optional(),
    f10: z.string().nullable().optional(),
  })
  .strict();

const nineLeafValues = z
  .object({
    f1: z.string().nullable().optional(),
    f2: z.string().nullable().optional(),
    f3: z.string().nullable().optional(),
    f4: z.string().nullable().optional(),
    f5: z.string().nullable().optional(),
    f6: z.string().nullable().optional(),
    f7: z.string().nullable().optional(),
    f8: z.string().nullable().optional(),
    f9: z.string().nullable().optional(),
  })
  .strict();

const bigValuesSchema = z
  .object({
    systems: z.array(tenLeafValues).optional(),
    profile: nineLeafValues.optional(),
  })
  .strict();

type BigValues = z.infer<typeof bigValuesSchema>;

const bigTarget: ExtractionTarget<BigValues> = {
  name: "demo-big",
  extractionSchema: enveloped(bigValuesSchema),
  instructions: "Demo big instructions.",
  examples: [],
};

/** The leaf keys of each piece the default cap partitions each group into. */
const SYSTEMS_PIECES = [
  ["f1", "f2", "f3", "f4", "f5"],
  ["f6", "f7", "f8", "f9", "f10"],
];
const PROFILE_PIECES = [
  ["f1", "f2", "f3", "f4", "f5"],
  ["f6", "f7", "f8", "f9"],
];

/** One piece's worth of enveloped leaves: `f3` → `{ value: "<prefix>-f3", ... }`. */
function leafPiece(leaves: readonly string[], prefix: string): Record<string, unknown> {
  return Object.fromEntries(leaves.map((leaf) => [leaf, env(`${prefix}-${leaf}`, `${leaf} span`)]));
}

function currentCandidate(name: string): {
  mentionSpan: string;
  discriminator: string;
  distinguishedBy: string | null;
  eligibility: string;
  eligibilitySpan: string | null;
} {
  return {
    mentionSpan: name,
    discriminator: name,
    distinguishedBy: null,
    eligibility: "current",
    eligibilitySpan: null,
  };
}

const bigRoster: Roster = {
  systems: [currentCandidate("system one"), currentCandidate("system two")],
  profile: [],
};

/**
 * Fake chat dispatching on the partitioned request names: a collection piece's
 * fill is `...-fill-<part>-<instance>`, a singleton piece's `...-fill-<part>`.
 * Each response carries ONLY that piece's leaves for that instance — the split
 * the merge step must reassemble.
 */
function fakeBigChat(): { chat: ChatClient; requests: ChatRequest[] } {
  return fakeChat((request) => {
    const name = request.response_format.json_schema.name;
    const systems = /^demo-big-systems-fill-(\d+)-(\d+)$/.exec(name);
    if (systems) {
      const [, part, instance] = systems;
      return {
        content: JSON.stringify({
          systems: leafPiece(SYSTEMS_PIECES[Number(part)]!, `i${instance}`),
        }),
        finishReason: "stop",
      };
    }
    const profile = /^demo-big-profile-fill-(\d+)$/.exec(name);
    if (profile) {
      return {
        content: JSON.stringify({ profile: leafPiece(PROFILE_PIECES[Number(profile[1])]!, "p") }),
        finishReason: "stop",
      };
    }
    throw new Error(`Unexpected request: ${name}`);
  });
}

describe("scopedInstanceExtractor — leaf-count partitioning", () => {
  test("pieces of one over-cap group are recombined per (group, instance) — every leaf from every piece survives for every instance", async () => {
    // THE regression test for partitioned fills: with a plain overwrite at
    // assembly, only the last piece's leaves would survive per instance — and
    // because every leaf is optional in the schema, the closing parse would
    // not catch it. Both a collection group (per-instance merge) and a
    // singleton group (per-group merge) are exercised in one extraction.
    const { chat, requests } = fakeBigChat();

    const extractor = scopedInstanceExtractor({
      target: bigTarget,
      chat,
      model: "demo-model",
      inventory: async () => bigRoster,
      buildFillInstructions,
    });

    const result = await extractor.extract({ text: "the full transcript", annotations: {} });

    // One call per piece per instance for the collection group, one per piece
    // for the singleton group, plus the inventory call.
    expect(requests).toHaveLength(6);
    expect(result.usage.calls).toBe(7);

    // Each request was actually pinned to one piece's leaf subset — the merge
    // assertions below are meaningless if nothing was partitioned.
    for (const request of requests) {
      const name = request.response_format.json_schema.name;
      const schema = request.response_format.json_schema.schema as {
        properties: Record<string, { properties: Record<string, unknown> }>;
      };
      const groupKey = name.includes("systems") ? "systems" : "profile";
      expect(
        Object.keys(schema.properties[groupKey]!.properties).length,
        `${name} leaf count`,
      ).toBeLessThanOrEqual(5);
    }

    // Every instance carries every leaf, from BOTH pieces.
    const systems = result.fields.systems;
    expect(systems).toHaveLength(2);
    for (let instance = 0; instance < 2; instance++) {
      for (let leaf = 1; leaf <= 10; leaf++) {
        const key = `f${leaf}` as keyof (typeof systems)[number];
        expect(systems[instance]![key].value, `systems[${instance}].f${leaf}`).toBe(
          `i${instance}-f${leaf}`,
        );
      }
    }

    // The singleton group's pieces are likewise recombined.
    const profile = result.fields.profile;
    for (let leaf = 1; leaf <= 9; leaf++) {
      const key = `f${leaf}` as keyof typeof profile;
      expect(profile[key].value, `profile.f${leaf}`).toBe(`p-f${leaf}`);
    }
  });

  test("a partitioned piece's few-shot example is narrowed to that piece's leaves", async () => {
    // The same rationale as buildGroupMessages' leafKeys: the assistant turn a
    // piece imitates must not carry fields its own response_format rejects.
    const targetWithExample: ExtractionTarget<BigValues> = {
      ...bigTarget,
      examples: [
        {
          transcript: "Every field was mentioned.",
          fields: {
            systems: [leafPiece([...SYSTEMS_PIECES[0]!, ...SYSTEMS_PIECES[1]!], "ex")],
            profile: leafPiece([...PROFILE_PIECES[0]!, ...PROFILE_PIECES[1]!], "ex"),
          } as unknown as Enveloped<BigValues>,
        },
      ],
    };
    const { chat, requests } = fakeBigChat();

    await scopedInstanceExtractor({
      target: targetWithExample,
      chat,
      model: "demo-model",
      inventory: async () => bigRoster,
      buildFillInstructions,
    }).extract({ text: "the full transcript", annotations: {} });

    expect(requests).toHaveLength(6);
    for (const request of requests) {
      const name = request.response_format.json_schema.name;
      const part = Number(/-(\d+)(?:-\d+)?$/.exec(name)![1]);
      const assistant = request.messages.find((m) => m.role === "assistant")!;
      const fields = JSON.parse(assistant.content) as Record<string, Record<string, unknown>>;
      const groupKey = name.includes("systems") ? "systems" : "profile";
      const pieces = groupKey === "systems" ? SYSTEMS_PIECES : PROFILE_PIECES;
      // The example carries EXACTLY this piece's leaves — a single-instance
      // object (collection group projected to one element), narrowed further.
      expect(Object.keys(fields[groupKey]!).sort(), name).toEqual([...pieces[part]!].sort());
    }
  });

  test("the instance cap is enforced per group regardless of partitioning — it throws before any fill call", async () => {
    const { chat, requests } = fakeBigChat();

    const extractor = scopedInstanceExtractor({
      target: bigTarget,
      chat,
      model: "demo-model",
      inventory: async () => bigRoster,
      buildFillInstructions,
      instanceCap: 1,
    });

    await expect(
      extractor.extract({ text: "the full transcript", annotations: {} }),
    ).rejects.toThrow("cap");
    expect(requests).toHaveLength(0);
  });

  test("a group under the cap is not partitioned — same calls, same request names as before", async () => {
    const roster = makeRoster({
      widgets: [currentCandidate("the red widget")],
    });
    const { chat, requests } = fakeChat((request) => {
      const name = request.response_format.json_schema.name;
      if (name === "demo-widgets-fill-0") {
        return { content: JSON.stringify(widgetResponse("red", null)), finishReason: "stop" };
      }
      if (name === "demo-house-fill") {
        return { content: JSON.stringify(houseResponse("main")), finishReason: "stop" };
      }
      throw new Error(`Unexpected request: ${name}`);
    });

    const extractor = scopedInstanceExtractor({
      target,
      chat,
      model: "demo-model",
      inventory: async () => roster,
      buildFillInstructions,
    });

    const result = await extractor.extract({ text: "the full transcript", annotations: {} });

    expect(requests.map((r) => r.response_format.json_schema.name)).toEqual([
      "demo-widgets-fill-0",
      "demo-house-fill",
    ]);
    expect(result.usage.calls).toBe(3); // inventory + 2 fills
    expect(result.fields.widgets?.[0]?.color.value).toBe("red");
    expect(result.fields.house?.name.value).toBe("main");
  });
});

// --- Task 4: extraction observability -----------------------------------------
//
// Eight must-fail tests: inventory and per-instance progress events, the retry
// budget surfaced from extract(), and the requireRetryBudget terminal throw.

/** Collect `onUnit` events for assertion. */
function collectUnits(): {
  // Category 2 — the observer's unit type widened: the ported preset emits
  // `PhaseUnit` events through the engine, not `InventoryUnit`/`InstanceUnit`.
  events: PhaseUnit[];
  onUnit: (event: PhaseUnit) => void;
} {
  const events: PhaseUnit[] = [];
  return { events, onUnit: (e) => void events.push(e) };
}

/** A one-collection-group schema used by the observer tests. */
const obsValuesSchema = z
  .object({
    widgets: z.array(widgetValues).optional(),
  })
  .strict();

type ObsValues = z.infer<typeof obsValuesSchema>;

const obsTarget: ExtractionTarget<ObsValues> = {
  name: "demo-obs",
  extractionSchema: enveloped(obsValuesSchema),
  instructions: "Extract widgets.",
  examples: [],
};

const twoCandidateRoster: Roster = {
  widgets: [currentCandidate("the red widget"), currentCandidate("the blue widget")],
};

function obsChat(): { chat: ChatClient; requests: ChatRequest[] } {
  return fakeChat((request) => {
    const name = request.response_format.json_schema.name;
    if (name === "demo-obs-widgets-fill-0")
      return { content: JSON.stringify(widgetResponse("red", null)), finishReason: "stop" };
    if (name === "demo-obs-widgets-fill-1")
      return { content: JSON.stringify(widgetResponse("blue", 5)), finishReason: "stop" };
    throw new Error(`Unexpected request: ${name}`);
  });
}

describe("scopedInstanceExtractor — extraction observability (Task 4)", () => {
  test("a roster with one collection group of two current candidates emits one inventory start/done pair then two instance units", async () => {
    const { chat } = obsChat();
    const { events, onUnit } = collectUnits();

    await scopedInstanceExtractor({
      target: obsTarget,
      chat,
      model: "m",
      inventory: async () => twoCandidateRoster,
      buildFillInstructions,
      onUnit,
    }).extract({ text: "transcript", annotations: {} });

    // One inventory start/done pair, then two fill start/done pairs — six events
    // under either stream.
    expect(events).toHaveLength(6);

    // Category 1 — events changed from InventoryUnit/InstanceUnit to PhaseUnit:
    // the discriminator is now `unit: "phase"` with the phase's identity in
    // `phaseId`. The inventory phase is pass 0 and runs before any fill call.
    expect(events[0]!.unit).toBe("phase");
    expect(events[0]!.phaseId).toBe("inventory");
    expect(events[0]!.pass).toBe(0);
    expect(events[0]!.phase).toBe("start");
    expect(events[0]!.attempt).toBe(1);
    expect(events[1]!.unit).toBe("phase");
    expect(events[1]!.phaseId).toBe("inventory");
    expect(events[1]!.phase).toBe("done");
    expect(events[1]!.attempt).toBe(1);
    // Inventory carries no usage — inventory is a caller-supplied function,
    // not a completion, so its cost never reaches this extractor.
    expect((events[1] as { usage?: unknown }).usage).toBeUndefined();

    // Two fill units: instance 1 and 2, both instances: 2 — the piece
    // coordinates survive on PhaseUnit (Task 1), so only the discriminator
    // needed amending here.
    const fillStarts = events.filter((e) => e.phaseId === "fill" && e.phase === "start");
    expect(fillStarts).toHaveLength(2);
    expect(fillStarts[0]!.key).toBe("widgets");
    expect(fillStarts[0]!.instance).toBe(1);
    expect(fillStarts[0]!.instances).toBe(2);
    expect(fillStarts[1]!.key).toBe("widgets");
    expect(fillStarts[1]!.instance).toBe(2);
    expect(fillStarts[1]!.instances).toBe(2);

    // Same id across start/done for each fill; different ids between them.
    const fillDones = events.filter((e) => e.phaseId === "fill" && e.phase === "done");
    expect(fillDones).toHaveLength(2);
    expect(fillStarts[0]!.id).toBe(fillDones[0]!.id);
    expect(fillStarts[1]!.id).toBe(fillDones[1]!.id);
    expect(fillStarts[0]!.id).not.toBe(fillStarts[1]!.id);
  });

  test("a group whose roster says stated: none makes no fill call and emits no instance unit for it", async () => {
    const roster: Roster = {
      widgets: { stated: "none", span: "there are no widgets" },
    };
    const { chat, requests } = obsChat();
    const { events, onUnit } = collectUnits();

    const result = await scopedInstanceExtractor({
      target: obsTarget,
      chat,
      model: "m",
      inventory: async () => roster,
      buildFillInstructions,
      onUnit,
    }).extract({ text: "transcript", annotations: {} });

    // Inventory start/done, but no fill units — the stated-empty path is silent.
    // Category 1 — the discriminator: `unit: "phase"`, phaseId names the phase.
    expect(events.filter((e) => e.phaseId === "inventory")).toHaveLength(2);
    expect(events.filter((e) => e.phaseId === "fill")).toHaveLength(0);
    expect(requests).toHaveLength(0);
    expect(result.fields.widgets).toEqual([]);
  });

  test("a failing inventory emits inventory start then error, and no instance units at all", async () => {
    const { chat, requests } = obsChat();
    const { events, onUnit } = collectUnits();

    await expect(
      scopedInstanceExtractor({
        target: obsTarget,
        chat,
        model: "m",
        inventory: async () => {
          throw new Error("inventory failed");
        },
        buildFillInstructions,
        onUnit,
      }).extract({ text: "transcript", annotations: {} }),
    ).rejects.toThrow("inventory failed");

    // Category 5 — the failing-inventory event stream: one start and one error
    // for the inventory phase's single item (the phase pins maxRetries: 0), and
    // the fill phase never runs. The count stays two; what changed is the
    // discriminator (category 1) — today's `unit: "inventory"` becomes
    // `unit: "phase"` with `phaseId: "inventory"`.
    expect(events).toHaveLength(2);
    expect(events[0]!.unit).toBe("phase");
    expect(events[0]!.phaseId).toBe("inventory");
    expect(events[0]!.phase).toBe("start");
    expect(events[1]!.unit).toBe("phase");
    expect(events[1]!.phaseId).toBe("inventory");
    expect(events[1]!.phase).toBe("error");
    expect((events[1] as { error?: unknown }).error).toBeInstanceOf(Error);
    expect(((events[1] as { error?: Error }).error as Error).message).toBe("inventory failed");
    expect(requests).toHaveLength(0);
  });

  test("a partitioned tier-1 group emits two units for the same (key, instance) differing only in part", async () => {
    const { chat } = fakeBigChat();
    const { events, onUnit } = collectUnits();

    await scopedInstanceExtractor({
      target: bigTarget,
      chat,
      model: "demo-model",
      inventory: async () => bigRoster,
      buildFillInstructions,
      onUnit,
    }).extract({ text: "the full transcript", annotations: {} });

    // The systems group (10 leaves) partitions into 2 pieces at the default cap.
    // For instance 1, there should be two start events with the same (key, instance)
    // but different part values — the assertion that §0.2 was necessary.
    // Category 1 — discriminator only: the piece coordinates survive on PhaseUnit.
    const systemsStarts = events.filter(
      (e) => e.phaseId === "fill" && e.phase === "start" && e.key === "systems" && e.instance === 1,
    );
    expect(systemsStarts).toHaveLength(2);
    expect(systemsStarts[0]!.part).not.toBe(systemsStarts[1]!.part);
    expect(systemsStarts[0]!.parts).toBe(2);
    expect(systemsStarts[1]!.parts).toBe(2);
    // Both carry the same instance count.
    expect(systemsStarts[0]!.instances).toBe(2);
    expect(systemsStarts[1]!.instances).toBe(2);
  });

  test("a singleton group reports instance: 1, instances: 1", async () => {
    const roster = makeRoster({
      widgets: [],
      gadgets: [],
    });
    const { chat } = fakeChat((request) => {
      const name = request.response_format.json_schema.name;
      if (name === "demo-house-fill")
        return { content: JSON.stringify(houseResponse("main")), finishReason: "stop" };
      throw new Error(`Unexpected request: ${name}`);
    });
    const { events, onUnit } = collectUnits();

    await scopedInstanceExtractor({
      target,
      chat,
      model: "m",
      inventory: async () => roster,
      buildFillInstructions,
      onUnit,
    }).extract({ text: "transcript", annotations: {} });

    // The house singleton emits one fill unit with instance: 1, instances: 1.
    // Category 1 — discriminator only.
    const houseStarts = events.filter(
      (e) => e.phaseId === "fill" && e.phase === "start" && e.key === "house",
    );
    expect(houseStarts).toHaveLength(1);
    expect(houseStarts[0]!.instance).toBe(1);
    expect(houseStarts[0]!.instances).toBe(1);
  });

  test("with onUnit absent, an identical run produces an identical result and call sequence", async () => {
    const roster = makeRoster({
      widgets: [currentCandidate("the red widget")],
    });

    function makeChat(): { chat: ChatClient; requests: ChatRequest[] } {
      return fakeChat((request) => {
        const name = request.response_format.json_schema.name;
        if (name === "demo-widgets-fill-0")
          return { content: JSON.stringify(widgetResponse("red", null)), finishReason: "stop" };
        if (name === "demo-house-fill")
          return { content: JSON.stringify(houseResponse("main")), finishReason: "stop" };
        throw new Error(`Unexpected request: ${name}`);
      });
    }

    const withObserver = makeChat();
    const withoutObserver = makeChat();

    const resultWith = await scopedInstanceExtractor({
      target,
      chat: withObserver.chat,
      model: "m",
      inventory: async () => roster,
      buildFillInstructions,
      onUnit: () => {},
    }).extract({ text: "transcript", annotations: {} });

    const resultWithout = await scopedInstanceExtractor({
      target,
      chat: withoutObserver.chat,
      model: "m",
      inventory: async () => roster,
      buildFillInstructions,
    }).extract({ text: "transcript", annotations: {} });

    // Results are identical.
    expect(resultWithout.fields).toEqual(resultWith.fields);
    expect(resultWithout.usage.calls).toBe(resultWith.usage.calls);
    expect(resultWithout.raw).toEqual(resultWith.raw);

    // Call sequences are identical — same request names in the same order.
    const namesWith = withObserver.requests.map((r) => r.response_format.json_schema.name);
    const namesWithout = withoutObserver.requests.map((r) => r.response_format.json_schema.name);
    expect(namesWithout).toEqual(namesWith);
  });

  test("onRetryBudget fires from extract(), after the roster, carrying the job-derived batches", async () => {
    const { chat } = obsChat();
    const budgets: RetryBudget[] = [];

    await scopedInstanceExtractor({
      target: obsTarget,
      chat,
      model: "m",
      inventory: async () => twoCandidateRoster,
      buildFillInstructions,
      concurrency: 1,
      maxRetries: 2,
      stepTimeoutMs: 362_999,
      onRetryBudget: (b) => void budgets.push(b),
    }).extract({ text: "transcript", annotations: {} });

    // The budget was reduced (derived 0 < requested 2), so onRetryBudget fired.
    expect(budgets).toHaveLength(1);
    expect(budgets[0]!.requested).toBe(2);
    expect(budgets[0]!.derived).toBe(0);
    // Category 3 — onRetryBudget now fires per reduced phase, and the fill
    // phase's batches are derived from the fill jobs alone:
    // batches = ceil(jobs / concurrency) = ceil(2/1) = 2. Today's estimate
    // padded the inventory call into the job count (ceil((1 + 2)/1) = 3).
    // The inventory phase cannot fire the observer at all — it pins
    // maxRetries: 0, and a budget of 0 cannot be reduced.
    expect(budgets[0]!.batches).toBe(2);
  });

  test("requireRetryBudget: true with a deriving-to-zero configuration rejects with TerminalError; absent succeeds", async () => {
    function makeChat(): { chat: ChatClient; requests: ChatRequest[] } {
      return obsChat();
    }

    // With requireRetryBudget: true, extract() rejects with TerminalError.
    const strict = makeChat();
    await expect(
      scopedInstanceExtractor({
        target: obsTarget,
        chat: strict.chat,
        model: "m",
        inventory: async () => twoCandidateRoster,
        buildFillInstructions,
        concurrency: 1,
        maxRetries: 2,
        stepTimeoutMs: 362_999,
        requireRetryBudget: true,
      }).extract({ text: "transcript", annotations: {} }),
    ).rejects.toBeInstanceOf(TerminalError);
    // No fill calls were made — the throw is before the pool.
    expect(strict.requests).toHaveLength(0);

    // With requireRetryBudget absent, extract() succeeds.
    const lenient = makeChat();
    const result = await scopedInstanceExtractor({
      target: obsTarget,
      chat: lenient.chat,
      model: "m",
      inventory: async () => twoCandidateRoster,
      buildFillInstructions,
      concurrency: 1,
      maxRetries: 2,
      stepTimeoutMs: 362_999,
    }).extract({ text: "transcript", annotations: {} });

    expect(result.fields.widgets).toHaveLength(2);
    expect(lenient.requests).toHaveLength(2);
  });
});

// --- Wave 5 regression pins — assertions nothing covered before the port -----

describe("scopedInstanceExtractor — Wave 5 regression pins", () => {
  test("result.raw is defined and carries the assembled shape, including the seeded []s", async () => {
    // The suite's only pre-port raw assertion compared two results to each
    // other — which passes when both raws are ABSENT, so the port could have
    // dropped the member silently. A presence assertion is the pin; today raw
    // is always present and holds the assembled pre-normalize record, seeded
    // groups included.
    const roster = makeRoster({
      widgets: { stated: "none", span: "there are no widgets" },
      gadgets: [],
    });
    const { chat } = fakeChat((request) => {
      const name = request.response_format.json_schema.name;
      if (name === "demo-house-fill") {
        return { content: JSON.stringify(houseResponse("main")), finishReason: "stop" };
      }
      throw new Error(`Unexpected request: ${name}`);
    });

    const result = await scopedInstanceExtractor({
      target,
      chat,
      model: "demo-model",
      inventory: async () => roster,
      buildFillInstructions,
    }).extract({ text: "the full transcript", annotations: {} });

    expect(result.raw).toBeDefined();
    expect(result.raw).toEqual({
      widgets: [], // seeded [] by the inventory phase's merge — in raw too
      gadgets: [],
      house: { name: { value: "main", sourceSpan: "main", confidence: 1 } },
    });
  });

  test("statedEmptyGroups is absent rather than {} when no group stated one", async () => {
    // extractor.ts documents absence as "this extractor ran no roster pass",
    // so an empty record must be omitted, never emitted as {}.
    const roster = makeRoster({
      widgets: [currentCandidate("the red widget")],
    });
    const { chat } = fakeChat((request) => {
      const name = request.response_format.json_schema.name;
      if (name === "demo-house-fill") {
        return { content: JSON.stringify(houseResponse("main")), finishReason: "stop" };
      }
      return { content: JSON.stringify(widgetResponse("red", null)), finishReason: "stop" };
    });

    const result = await scopedInstanceExtractor({
      target,
      chat,
      model: "demo-model",
      inventory: async () => roster,
      buildFillInstructions,
    }).extract({ text: "the full transcript", annotations: {} });

    expect("statedEmptyGroups" in result).toBe(false);
  });

  test("a transiently failing inventory is attempted exactly once — the pass is one-shot", async () => {
    let inventoryCalls = 0;
    const { chat } = obsChat();

    await expect(
      scopedInstanceExtractor({
        target: obsTarget,
        chat,
        model: "m",
        inventory: async () => {
          inventoryCalls += 1;
          throw new Error("inventory blip"); // transient — would be retried elsewhere
        },
        buildFillInstructions,
      }).extract({ text: "transcript", annotations: {} }),
    ).rejects.toThrow("inventory blip");

    expect(inventoryCalls).toBe(1);
  });

  test("a fill failing once transiently then succeeding reports usage.calls of the SUCCESSFUL items, not attempts", async () => {
    // Category 6 — usage.calls semantic change: today every attempt incremented
    // the tally before the call (inventory + 2 + 1 = 4); the engine sums usage
    // from resolved outcomes only, so the retrying fill reports its single
    // success (inventory + 1 + 1 = 3). Host-visible; pinned here and named in
    // the changeset.
    let widgetFillAttempts = 0;
    const { chat, requests } = fakeChat((request) => {
      const name = request.response_format.json_schema.name;
      if (name === "demo-obs-widgets-fill-0") {
        widgetFillAttempts += 1;
        if (widgetFillAttempts === 1) {
          throw Object.assign(new Error("service unavailable"), { status: 503 });
        }
        return { content: JSON.stringify(widgetResponse("red", null)), finishReason: "stop" };
      }
      if (name === "demo-obs-widgets-fill-1") {
        return { content: JSON.stringify(widgetResponse("blue", 5)), finishReason: "stop" };
      }
      if (name === "demo-house-fill") {
        return { content: JSON.stringify(houseResponse("main")), finishReason: "stop" };
      }
      throw new Error(`Unexpected request: ${name}`);
    });

    const result = await scopedInstanceExtractor({
      target: obsTarget,
      chat,
      model: "m",
      inventory: async () => twoCandidateRoster,
      buildFillInstructions,
      delay: () => Promise.resolve(),
    }).extract({ text: "transcript", annotations: {} });

    expect(widgetFillAttempts).toBe(2); // the retry really happened
    expect(requests).toHaveLength(3); // inventory makes no chat call
    expect(result.fields.widgets).toHaveLength(2);
    expect(result.usage.calls).toBe(3); // 1 inventory + 2 successful fills — NOT 4
  });

  test("a fill failing with a 4xx status is attempted exactly once — the budget is not burned", async () => {
    // Category 7 — retry classification tightens: today's inline loop retried
    // everything except TerminalError and abort, so a 404 burned the whole
    // budget. The engine composes retryAsync, which stops on a 4xx with a
    // status.
    let widgetFillAttempts = 0;
    const { chat } = fakeChat((request) => {
      const name = request.response_format.json_schema.name;
      if (name === "demo-obs-widgets-fill-0") {
        widgetFillAttempts += 1;
        throw Object.assign(new Error("not found"), { status: 404 });
      }
      if (name === "demo-obs-widgets-fill-1") {
        return { content: JSON.stringify(widgetResponse("blue", 5)), finishReason: "stop" };
      }
      throw new Error(`Unexpected request: ${name}`);
    });

    await expect(
      scopedInstanceExtractor({
        target: obsTarget,
        chat,
        model: "m",
        inventory: async () => twoCandidateRoster,
        buildFillInstructions,
        delay: () => Promise.resolve(),
      }).extract({ text: "transcript", annotations: {} }),
    ).rejects.toThrow("not found");

    expect(widgetFillAttempts).toBe(1);
  });
});

/**
 * The byte cap reaches the fill split end-to-end through scopedInstanceExtractor:
 * a flat (non-grouped) target with a tight cap produces N fill calls under the
 * same `key === ""` and the merge reassembles every leaf. Without the option
 * flowing through (finding 3), the preset would always pack against the union
 * cap alone and the partitioned flat path would only be reachable through
 * prepareGroups+fillPhase hand composition.
 */
describe("scopedInstanceExtractor — byte-cap option flow-through (flat partitioning end-to-end)", () => {
  test("maxSerializedCharsPerGroup on the preset partitions a flat schema at construction, schedules N fill calls, and reassembles every leaf", async () => {
    // Long enum values inflate the flat schema's serialized form well past a
    // tight cap; 6 leaves with 50-char enum literals partition into 1-2-leaf
    // pieces sharing key === "".
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
      instructions: "Extract leaves.",
      examples: [],
    };

    const requests: ChatRequest[] = [];
    const chat: ChatClient = {
      complete: async (request) => {
        requests.push(request);
        const name = request.response_format.json_schema.name;
        const m = /-(\d+)$/.exec(name);
        if (m === null) throw new Error(`unpartitioned fill should not appear here: ${name}`);
        // Each response carries exactly the leaves its request's response_format
        // accepts — read the schema off the request so the partition layout is
        // not hard-coded here.
        const schema = request.response_format.json_schema.schema as {
          properties: Record<string, unknown>;
        };
        const fields: Record<string, unknown> = {};
        for (const key of Object.keys(schema.properties)) {
          fields[key] = { value: enumByKey[key]!, sourceSpan: key, confidence: 1 };
        }
        return { content: JSON.stringify(fields), finishReason: "stop" };
      },
    };

    const result = await scopedInstanceExtractor({
      target: flatEnumTarget,
      chat,
      model: "demo-model",
      inventory: async () => ({}),
      buildFillInstructions,
      maxSerializedCharsPerGroup: 1500,
    }).extract({ text: "the full transcript", annotations: {} });

    // N fill calls (no inventory replies needed — the flat schema's pieces
    // occupy the call budget); one per piece, with a distinct -<part> suffix.
    expect(requests.length).toBeGreaterThan(1);
    const names = requests.map((r) => r.response_format.json_schema.name);
    // Every name carries a part suffix — distinct wire identifiers, the bug
    // finding 2 fixed.
    expect(new Set(names).size).toBe(requests.length);
    for (const name of names) expect(name).toMatch(/-\d+$/);

    // The merge reassembled every leaf — disjoint pieces, no overlap,
    // Object.assign accumulates in piece order.
    const fields = result.fields as unknown as Record<string, { value: string }>;
    for (const key of Object.keys(enumByKey)) {
      expect(fields[key], `leaf ${key}`).toBeDefined();
      expect(fields[key]!.value).toBe(enumByKey[key]);
    }
  });
});
