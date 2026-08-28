import { describe, expect, test } from "vitest";
import { z } from "zod";

import { enveloped, SchemaParseError } from "@azx/ribo-core";
import type { Enveloped, ExtractionTarget } from "@azx/ribo-core";

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
