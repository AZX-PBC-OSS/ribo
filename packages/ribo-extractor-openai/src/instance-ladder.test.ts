import { describe, expect, test } from "vitest";
import { z } from "zod";

import {
  enveloped,
  isTransientFailure,
  SchemaParseError,
  terminalFallsThrough,
} from "@azx/ribo-core";
import type {
  Enveloped,
  ExtractionArbiter,
  ExtractionResult,
  ExtractionTarget,
} from "@azx/ribo-core";

import type { ChatClient, ChatRequest } from "./chat-client.js";
import { instanceLadder } from "./instance-ladder.js";
import { perGroupArrayExtractor, perGroupSingletonExtractor } from "./per-group.js";
import type { FillScope } from "./instance-fill.js";

/**
 * Must-fail tests for Task 16 — the instance-modeling strategy ladder. Every call
 * runs against a fake {@link ChatClient}, so nothing here touches a model or network.
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
  instructions: "Extract the widgets and the house.",
  examples: [{ transcript: "Example transcript.", fields: demoExample }],
};

// --- Helpers -----------------------------------------------------------------

const noDelay = (): Promise<void> => Promise.resolve();

function buildFillInstructions(groupKey: string, scope: FillScope): string {
  return `Fill instructions for ${groupKey}.\n\nScope:\n${JSON.stringify(scope)}`;
}

function tier1FillChat(): {
  chat: ChatClient;
  requests: ChatRequest[];
  callCount: () => number;
} {
  const requests: ChatRequest[] = [];
  const chat: ChatClient = {
    complete: async (request) => {
      requests.push(request);
      const name = request.response_format.json_schema.name;
      if (name === "demo-widgets-fill-0") {
        return {
          content: JSON.stringify({
            widgets: { color: env("red", "red"), size: env(null, null) },
          }),
          finishReason: "stop",
        };
      }
      if (name === "demo-widgets-fill-1") {
        return {
          content: JSON.stringify({
            widgets: { color: env("blue", "blue"), size: env(5, "five") },
          }),
          finishReason: "stop",
        };
      }
      if (name === "demo-house-fill") {
        return {
          content: JSON.stringify({ house: { name: env("main", "main") } }),
          finishReason: "stop",
        };
      }
      throw new Error(`Unexpected tier-1 fill request: ${name}`);
    },
  };
  return {
    chat,
    requests,
    callCount: () => requests.length,
  };
}

function tier2ArrayChat(): {
  chat: ChatClient;
  requests: ChatRequest[];
  callCount: () => number;
} {
  const requests: ChatRequest[] = [];
  const chat: ChatClient = {
    complete: async (request) => {
      requests.push(request);
      const name = request.response_format.json_schema.name;
      if (name === "demo-widgets") {
        return {
          content: JSON.stringify({
            widgets: [
              { color: env("red", "red"), size: env(null, null) },
              { color: env("blue", "blue"), size: env(5, "five") },
            ],
          }),
          finishReason: "stop",
        };
      }
      if (name === "demo-house") {
        return {
          content: JSON.stringify({ house: { name: env("main", "main") } }),
          finishReason: "stop",
        };
      }
      throw new Error(`Unexpected tier-2 request: ${name}`);
    },
  };
  return {
    chat,
    requests,
    callCount: () => requests.length,
  };
}

function tier3SingletonChat(): {
  chat: ChatClient;
  requests: ChatRequest[];
  callCount: () => number;
} {
  const requests: ChatRequest[] = [];
  const chat: ChatClient = {
    complete: async (request) => {
      requests.push(request);
      const name = request.response_format.json_schema.name;
      if (name === "demo-widgets") {
        return {
          content: JSON.stringify({
            widgets: { color: env("red", "red"), size: env(null, null) },
          }),
          finishReason: "stop",
        };
      }
      if (name === "demo-house") {
        return {
          content: JSON.stringify({ house: { name: env("main", "main") } }),
          finishReason: "stop",
        };
      }
      throw new Error(`Unexpected tier-3 request: ${name}`);
    },
  };
  return {
    chat,
    requests,
    callCount: () => requests.length,
  };
}

function tier3FailingChat(error: unknown): {
  chat: ChatClient;
  requests: ChatRequest[];
} {
  const requests: ChatRequest[] = [];
  const chat: ChatClient = {
    complete: async (request) => {
      requests.push(request);
      throw error;
    },
  };
  return { chat, requests };
}

/** Arbiter that accepts tier 1 or tier 2 results and declines tier 3 at exhaustion. */
const declineTier3AtExhaustion: ExtractionArbiter<Enveloped<DemoValues>> = (input) => {
  const firstResult = input.outcomes.find(
    (outcome): outcome is { candidate: string; result: ExtractionResult<Enveloped<DemoValues>> } =>
      "result" in outcome && outcome.result !== undefined,
  );
  if (firstResult) {
    return { accept: firstResult.result };
  }
  if (input.exhausted) {
    const last = input.outcomes[input.outcomes.length - 1];
    if (last && "error" in last) {
      return { giveUp: last.error };
    }
  }
  return { continue: true };
};

// --- Ladder composition tests ------------------------------------------------

describe("instanceLadder", () => {
  test("a tier-1 SchemaParseError falls through to tier 2 and the extraction still returns", async () => {
    const tier2 = tier2ArrayChat();
    const tier3 = tier3SingletonChat();
    const ladder = instanceLadder({
      arbiter: terminalFallsThrough,
      tier1: {
        target,
        chat: tier1FillChat().chat,
        model: "demo-model",
        inventory: async () => {
          throw new SchemaParseError("tier-1 roster parse failed", {
            cause: new z.ZodError([]),
          });
        },
        buildFillInstructions,
        delay: noDelay,
      },
      tier2: { target, chat: tier2.chat, model: "demo-model", delay: noDelay },
      tier3: { target, chat: tier3.chat, model: "demo-model", delay: noDelay },
    });

    const result = await ladder.extract("the transcript");

    expect(result.fields.widgets).toHaveLength(2);
    expect(result.fields.widgets?.[0]?.color.value).toBe("red");
    expect(result.fields.widgets?.[1]?.color.value).toBe("blue");
    expect(result.fields.house?.name.value).toBe("main");
    // Tier 3 should not have run — tier 2 succeeded and the arbiter accepted it.
    expect(tier3.callCount()).toBe(0);
  });

  test("usage.strategy names the accepted tier", async () => {
    const tier2 = tier2ArrayChat();
    const ladder = instanceLadder({
      arbiter: terminalFallsThrough,
      tier1: {
        target,
        chat: tier1FillChat().chat,
        model: "demo-model",
        inventory: async () => {
          throw new SchemaParseError("tier-1 roster parse failed", {
            cause: new z.ZodError([]),
          });
        },
        buildFillInstructions,
        delay: noDelay,
      },
      tier2: { target, chat: tier2.chat, model: "demo-model", delay: noDelay },
      tier3: { target, chat: tier3SingletonChat().chat, model: "demo-model", delay: noDelay },
    });

    const result = await ladder.extract("the transcript");

    expect(result.usage.strategy).toBe("tier2");
    expect(result.usage.calls).toBeGreaterThan(0);
  });

  test("tier 2 emits arrays and is not tier 3 renamed", async () => {
    const arrayChat = tier2ArrayChat();
    const arrayResult = await perGroupArrayExtractor({
      target,
      chat: arrayChat.chat,
      model: "demo-model",
      delay: noDelay,
    }).extract("the transcript");

    // Tier 2 must preserve the collection as an array, capable of carrying two instances.
    expect(Array.isArray(arrayResult.fields.widgets)).toBe(true);
    expect(arrayResult.fields.widgets).toHaveLength(2);
    expect(arrayResult.fields.widgets?.[0]?.color.value).toBe("red");
    expect(arrayResult.fields.widgets?.[1]?.color.value).toBe("blue");

    // The model was asked for an array shape (the request schema is the array group schema).
    const widgetsRequest = arrayChat.requests.find(
      (r) => r.response_format.json_schema.name === "demo-widgets",
    );
    expect(widgetsRequest).toBeDefined();
    const widgetsSchema = widgetsRequest!.response_format.json_schema.schema as {
      properties: Record<string, { type: string }>;
    };
    expect(widgetsSchema.properties.widgets?.type).toBe("array");

    const singletonChat = tier3SingletonChat();
    const singletonResult = await perGroupSingletonExtractor({
      target,
      chat: singletonChat.chat,
      model: "demo-model",
      delay: noDelay,
    }).extract("the transcript");

    // Tier 3 asks for a singleton and wraps it back to a one-element array,
    // so it cannot represent a second instance.
    expect(Array.isArray(singletonResult.fields.widgets)).toBe(true);
    expect(singletonResult.fields.widgets).toHaveLength(1);

    const singletonWidgetsRequest = singletonChat.requests.find(
      (r) => r.response_format.json_schema.name === "demo-widgets",
    );
    expect(singletonWidgetsRequest).toBeDefined();
    const singletonWidgetsSchema = singletonWidgetsRequest!.response_format.json_schema.schema as {
      properties: Record<string, { type: string }>;
    };
    expect(singletonWidgetsSchema.properties.widgets?.type).toBe("object");
  });

  test("an arbiter that declines tier 3 at exhaustion throws, and the relay's dead handling classifies it exactly as it would with no ladder in the path", async () => {
    const tier3Error = Object.assign(new Error("service unavailable"), { status: 503 });
    const tier3 = tier3FailingChat(tier3Error);
    const ladder = instanceLadder({
      arbiter: declineTier3AtExhaustion,
      tier1: {
        target,
        chat: tier1FillChat().chat,
        model: "demo-model",
        inventory: async () => {
          throw new SchemaParseError("tier-1 roster parse failed", {
            cause: new z.ZodError([]),
          });
        },
        buildFillInstructions,
        delay: noDelay,
      },
      tier2: {
        target,
        chat: {
          complete: async () => {
            throw new SchemaParseError("tier-2 parse failed", { cause: new z.ZodError([]) });
          },
        },
        model: "demo-model",
        delay: noDelay,
      },
      tier3: { target, chat: tier3.chat, model: "demo-model", delay: noDelay },
    });

    let thrown: unknown;
    try {
      await ladder.extract("the transcript");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(tier3Error);
    // The relay sees the same error it would see if the tier-3 extractor were used
    // directly, so its `dead`/transient classification is unchanged.
    expect(isTransientFailure(thrown)).toBe(true);
  });
});
