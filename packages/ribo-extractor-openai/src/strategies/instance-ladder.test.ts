import { describe, expect, test } from "vitest";
import { z } from "zod";

import {
  enveloped,
  isTransientFailure,
  SchemaParseError,
  terminalFallsThrough,
} from "@azx/ribo-core";
import type {
  ChatClient,
  ChatRequest,
  Enveloped,
  ExtractionArbiter,
  ExtractionTarget,
  ExtractionUnit,
  ResultOutcome,
} from "@azx/ribo-core";
import { instanceLadder } from "./instance-ladder.js";
import { perGroupArrayExtractor, perGroupSingletonExtractor } from "./per-group.js";
import type { FillScope } from "../scoped-instance/instance-fill.js";

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
    (outcome): outcome is ResultOutcome<Enveloped<DemoValues>> => outcome.outcome === "result",
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

    const result = await ladder.extract({ text: "the transcript", annotations: {} });

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

    const result = await ladder.extract({ text: "the transcript", annotations: {} });

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
    }).extract({ text: "the transcript", annotations: {} });

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
    }).extract({ text: "the transcript", annotations: {} });

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
      await ladder.extract({ text: "the transcript", annotations: {} });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(tier3Error);
    // The relay sees the same error it would see if the tier-3 extractor were used
    // directly, so its `dead`/transient classification is unchanged.
    expect(isTransientFailure(thrown)).toBe(true);
  });

  // --- Task 5 — observer threading and tier attribution -----------------------

  test("tier 1 failing and tier 2 succeeding emits tier 1 units stamped 'tier1' and tier 2 units stamped 'tier2'", async () => {
    const events: ExtractionUnit[] = [];
    const tier2 = tier2ArrayChat();
    const ladder = instanceLadder({
      arbiter: terminalFallsThrough,
      onUnit: (e) => events.push(e),
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

    await ladder.extract({ text: "the transcript", annotations: {} });

    const tier1Events = events.filter((e) => e.strategy === "tier1");
    const tier2Events = events.filter((e) => e.strategy === "tier2");

    // Tier 1 emits inventory-phase units (the inventory pass fails with
    // SchemaParseError). Category 1 — tier 1 is the ported scopedInstanceExtractor,
    // whose events are now PhaseUnit: `unit: "phase"` with `phaseId: "inventory"`.
    expect(tier1Events.length).toBeGreaterThan(0);
    expect(tier1Events.every((e) => e.unit === "phase" && e.phaseId === "inventory")).toBe(true);

    // Tier 2 emits group units (it succeeds).
    expect(tier2Events.length).toBeGreaterThan(0);
    expect(tier2Events.every((e) => e.unit === "group")).toBe(true);
  });

  test("every event a tier emits carries a strategy; none arrives unstamped", async () => {
    const events: ExtractionUnit[] = [];
    const tier2 = tier2ArrayChat();
    const ladder = instanceLadder({
      arbiter: terminalFallsThrough,
      onUnit: (e) => events.push(e),
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

    await ladder.extract({ text: "the transcript", annotations: {} });

    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.strategy !== undefined)).toBe(true);
  });

  test("a tier with its own onUnit and a ladder with one: both fire, and the ladder's copy is stamped", async () => {
    const ladderEvents: ExtractionUnit[] = [];
    const tierEvents: ExtractionUnit[] = [];
    const tier2 = tier2ArrayChat();
    const ladder = instanceLadder({
      arbiter: terminalFallsThrough,
      onUnit: (e) => ladderEvents.push(e),
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
        onUnit: (e) => tierEvents.push(e),
      },
      tier2: { target, chat: tier2.chat, model: "demo-model", delay: noDelay },
      tier3: { target, chat: tier3SingletonChat().chat, model: "demo-model", delay: noDelay },
    });

    await ladder.extract({ text: "the transcript", annotations: {} });

    // Both handlers saw tier 1's inventory events. Category 1 — tier 1's events
    // are PhaseUnit now; the discriminator is `unit: "phase"`, `phaseId: "inventory"`.
    const ladderTier1 = ladderEvents.filter((e) => e.strategy === "tier1");
    const tierTier1 = tierEvents.filter((e) => e.unit === "phase" && e.phaseId === "inventory");
    expect(ladderTier1.length).toBeGreaterThan(0);
    expect(tierTier1.length).toBeGreaterThan(0);

    // The ladder's copy is stamped; the tier's own copy is not.
    expect(ladderTier1.every((e) => e.strategy === "tier1")).toBe(true);
    expect(tierTier1.every((e) => e.strategy === undefined)).toBe(true);
  });

  test("with the ladder's onUnit absent, tiers behave identically and any tier-level onUnit still fires", async () => {
    const tierEvents: ExtractionUnit[] = [];
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
        onUnit: (e) => tierEvents.push(e),
      },
      tier2: { target, chat: tier2.chat, model: "demo-model", delay: noDelay },
      tier3: { target, chat: tier3SingletonChat().chat, model: "demo-model", delay: noDelay },
    });

    const result = await ladder.extract({ text: "the transcript", annotations: {} });

    // The tier-level onUnit still fires even without a ladder-level observer.
    // Category 1 — tier 1's events are PhaseUnit now (`phaseId: "inventory"`).
    expect(tierEvents.length).toBeGreaterThan(0);
    expect(tierEvents.every((e) => e.unit === "phase" && e.phaseId === "inventory")).toBe(true);

    // The extraction result is unaffected.
    expect(result.fields.widgets).toHaveLength(2);
    expect(result.usage.strategy).toBe("tier2");
  });
});

describe("instanceLadder provenance parameter", () => {
  test("accepts tier options whose target declares a row group", () => {
    const rowSchema = z
      .object({
        rooms: z
          .array(
            z
              .object({
                name: z.string().nullable().optional(),
              })
              .strict(),
          )
          .optional(),
      })
      .strict();
    type RowValues = z.infer<typeof rowSchema>;
    const rowTarget: ExtractionTarget<RowValues, { rooms: "row" }> = {
      name: "row-demo",
      extractionSchema: enveloped(rowSchema, { provenance: { rooms: "row" } }),
      instructions: "Extract rooms as a row group.",
    };
    const chat: ChatClient = {
      complete: async () => ({ content: "{}", finishReason: "stop" }),
    };

    const ladder = instanceLadder<RowValues, { rooms: "row" }>({
      arbiter: terminalFallsThrough,
      tier1: {
        target: rowTarget,
        chat,
        model: "test",
        inventory: async () => ({ rooms: [] }),
        buildFillInstructions: () => "",
      },
      tier2: { target: rowTarget, chat, model: "test" },
      tier3: { target: rowTarget, chat, model: "test", singleton: true },
    });

    expect(ladder).toBeDefined();
  });
});
