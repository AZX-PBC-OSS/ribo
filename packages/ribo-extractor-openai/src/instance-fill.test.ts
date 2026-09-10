import { describe, expect, test } from "vitest";
import { z } from "zod";

import { enveloped, SchemaParseError, TerminalQueueError } from "@azx/ribo-core";
import type {
  Enveloped,
  ExtractionTarget,
  InventoryUnit,
  InstanceUnit,
  RetryBudget,
} from "@azx/ribo-core";

import type { ChatClient, ChatCompletion, ChatRequest } from "./chat-client.js";
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

    const result = await extractor.extract("the full transcript");

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

    await expect(extractor.extract("the full transcript")).rejects.toBeInstanceOf(SchemaParseError);
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

    await extractor.extract("the full transcript");

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

    await extractor.extract(transcript);

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

    const result = await extractor.extract("the full transcript");

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

    await expect(extractor.extract("the full transcript")).rejects.toThrow("cap");
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

    const result = await extractor.extract("the full transcript");

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

    const result = await extractor.extract("the full transcript");

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

    const result = await extractor.extract("the full transcript");

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
    const systems = result.fields.systems!;
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
    const profile = result.fields.profile!;
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
    }).extract("the full transcript");

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

    await expect(extractor.extract("the full transcript")).rejects.toThrow("cap");
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

    const result = await extractor.extract("the full transcript");

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
  events: (InventoryUnit | InstanceUnit)[];
  onUnit: (event: InventoryUnit | InstanceUnit) => void;
} {
  const events: (InventoryUnit | InstanceUnit)[] = [];
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
    }).extract("transcript");

    // One inventory start/done pair, then two instance start/done pairs.
    expect(events).toHaveLength(6);

    // Inventory events come first — the pass runs before any fill call.
    expect(events[0]!.unit).toBe("inventory");
    expect(events[0]!.phase).toBe("start");
    expect(events[0]!.attempt).toBe(1);
    expect(events[1]!.unit).toBe("inventory");
    expect(events[1]!.phase).toBe("done");
    expect(events[1]!.attempt).toBe(1);
    // Inventory carries no usage — inventory is a caller-supplied function,
    // not a completion, so its cost never reaches this extractor.
    expect((events[1] as { usage?: unknown }).usage).toBeUndefined();

    // Two instance units: instance 1 and 2, both instances: 2.
    const instanceStarts = events.filter(
      (e): e is InstanceUnit => e.unit === "instance" && e.phase === "start",
    );
    expect(instanceStarts).toHaveLength(2);
    expect(instanceStarts[0]!.instance).toBe(1);
    expect(instanceStarts[0]!.instances).toBe(2);
    expect(instanceStarts[1]!.instance).toBe(2);
    expect(instanceStarts[1]!.instances).toBe(2);

    // Same id across start/done for each instance; different ids between instances.
    const instanceDones = events.filter(
      (e): e is InstanceUnit => e.unit === "instance" && e.phase === "done",
    );
    expect(instanceDones).toHaveLength(2);
    expect(instanceStarts[0]!.id).toBe(instanceDones[0]!.id);
    expect(instanceStarts[1]!.id).toBe(instanceDones[1]!.id);
    expect(instanceStarts[0]!.id).not.toBe(instanceStarts[1]!.id);
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
    }).extract("transcript");

    // Inventory start/done, but no instance units — the stated-empty path is silent.
    expect(events.filter((e) => e.unit === "inventory")).toHaveLength(2);
    expect(events.filter((e) => e.unit === "instance")).toHaveLength(0);
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
      }).extract("transcript"),
    ).rejects.toThrow("inventory failed");

    // Inventory start then error; no instance units.
    expect(events).toHaveLength(2);
    expect(events[0]!.unit).toBe("inventory");
    expect(events[0]!.phase).toBe("start");
    expect(events[1]!.unit).toBe("inventory");
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
    }).extract("the full transcript");

    // The systems group (10 leaves) partitions into 2 pieces at the default cap.
    // For instance 1, there should be two start events with the same (key, instance)
    // but different part values — the assertion that §0.2 was necessary.
    const systemsStarts = events.filter(
      (e): e is InstanceUnit =>
        e.unit === "instance" && e.phase === "start" && e.key === "systems" && e.instance === 1,
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
    }).extract("transcript");

    // The house singleton emits one instance unit with instance: 1, instances: 1.
    const houseStarts = events.filter(
      (e): e is InstanceUnit => e.unit === "instance" && e.phase === "start" && e.key === "house",
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
    }).extract("transcript");

    const resultWithout = await scopedInstanceExtractor({
      target,
      chat: withoutObserver.chat,
      model: "m",
      inventory: async () => roster,
      buildFillInstructions,
    }).extract("transcript");

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
    }).extract("transcript");

    // The budget was reduced (derived 0 < requested 2), so onRetryBudget fired.
    expect(budgets).toHaveLength(1);
    expect(budgets[0]!.requested).toBe(2);
    expect(budgets[0]!.derived).toBe(0);
    // batches = ceil((1 + jobs) / concurrency) = ceil(3/1) = 3
    expect(budgets[0]!.batches).toBe(3);
  });

  test("requireRetryBudget: true with a deriving-to-zero configuration rejects with TerminalQueueError; absent succeeds", async () => {
    function makeChat(): { chat: ChatClient; requests: ChatRequest[] } {
      return obsChat();
    }

    // With requireRetryBudget: true, extract() rejects with TerminalQueueError.
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
      }).extract("transcript"),
    ).rejects.toBeInstanceOf(TerminalQueueError);
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
    }).extract("transcript");

    expect(result.fields.widgets).toHaveLength(2);
    expect(lenient.requests).toHaveLength(2);
  });
});
