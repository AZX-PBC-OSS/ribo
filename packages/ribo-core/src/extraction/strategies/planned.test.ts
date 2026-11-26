import { describe, expect, test } from "vitest";
import { z } from "zod";

import type { AnnotatedTranscript } from "../../capture/annotated-transcript.js";
import type { ChatClient, ChatRequest } from "../../phases/chat-client.js";
import { enveloped } from "../../provenance/enveloped.js";
import type { Enveloped } from "../../provenance/enveloped.js";
import type { GroupUnit } from "../extraction-observer.js";
import type { ExtractionTarget, Extractor } from "../extractor.js";
import { groupedExtractor } from "../grouped-extractor.js";
import { createPlannedMerge } from "../planned-merge.js";
import { SchemaParseError } from "../schema-parse-error.js";
import { SCHEMA_PLAN_CONTRACT_VERSION } from "../schema-plan.js";
import type { SchemaPlan, SchemaPlanPiece } from "../schema-plan.js";

import { plannedExtractor, plannedPerGroupPlan } from "./planned.js";
import type { PlannedExtractorOptions } from "./planned.js";

const patch = z.object({
  building: z.object({
    details: z.object({
      year: z.number().nullable().optional(),
      color: z.string().nullable().optional(),
    }),
  }),
  systems: z.array(
    z.object({
      components: z.array(
        z.object({
          name: z.string().nullable().optional(),
          serial: z.string().nullable().optional(),
        }),
      ),
    }),
  ),
});
type Values = z.infer<typeof patch>;
const provenance = { systems: "row" } as const;
type Fields = Enveloped<Values, typeof provenance>;

const target: ExtractionTarget<Values, typeof provenance> = {
  name: "planned-nested",
  extractionSchema: enveloped(patch, { provenance }),
  instructions: "Extract only the reviewed fields.",
  examples: [],
};

const pieces: readonly SchemaPlanPiece[] = [
  {
    name: "construction",
    description: "Construction details stay together.",
    key: "building",
    paths: ["building.details.year"],
  },
  {
    name: "finish",
    description: "Finish is reviewed separately.",
    key: "building",
    paths: ["building.details.color"],
  },
  {
    name: "component names",
    description: "Name every component.",
    key: "systems",
    paths: ["systems.components.name"],
  },
  {
    name: "component serials",
    description: "Record component serial numbers.",
    key: "systems",
    paths: ["systems.components.serial"],
  },
];

const plan: SchemaPlan = {
  version: SCHEMA_PLAN_CONTRACT_VERSION,
  schemaFingerprint: "b".repeat(64),
  fieldPaths: pieces.flatMap((entry) => entry.paths),
  pieces: [...pieces],
  provenance: {
    model: "stub-model",
    backend: "stub-backend",
    createdAt: "2026-09-21T12:00:00.000Z",
  },
};

const transcript: AnnotatedTranscript = {
  text: "Built in 1984 with red siding. The boiler serial is A-1.",
  annotations: {},
};

const envelope = (value: unknown, sourceSpan: string | null) => ({
  value,
  confidence: 0.8,
  sourceSpan,
});

const requestName = (pieceIndex: number, slug: string, key: string): string =>
  `${target.name}-${pieceIndex}-${slug}-${key}`;

const names = {
  construction: requestName(0, "construction", "building"),
  finish: requestName(1, "finish", "building"),
  componentNames: requestName(2, "component-names", "systems"),
  componentSerials: requestName(3, "component-serials", "systems"),
} as const;

const successfulResponses: Readonly<Record<string, string>> = {
  [names.construction]: JSON.stringify({
    building: { details: { year: envelope(1984, "Built in 1984") } },
  }),
  [names.finish]: JSON.stringify({
    building: { details: { color: envelope("red", "red siding") } },
  }),
  [names.componentNames]: JSON.stringify({
    systems: [
      {
        sourceSpan: "The boiler serial is A-1.",
        components: [{ sourceSpan: "The boiler serial is A-1.", name: "boiler" }],
      },
    ],
  }),
  [names.componentSerials]: JSON.stringify({
    systems: [{ components: [{ serial: "A-1" }] }],
  }),
};

/** Compose the public dry-run plan explicitly, including the planned-only merge. */
function manuallyComposed<V extends Record<string, unknown>, P>(
  options: PlannedExtractorOptions<V, P>,
): Extractor<Enveloped<V, P>> {
  const compiled = plannedPerGroupPlan(options);
  return groupedExtractor({
    target: options.target,
    groups: compiled.groups,
    mergeSameKey: createPlannedMerge(options.target.extractionSchema),
    normalize: options.normalize,
    concurrency: options.concurrency,
    maxRetries: options.maxRetries,
    stepTimeoutMs: options.stepTimeoutMs,
    perCallCeilingMs: options.perCallCeilingMs,
    delay: options.delay,
    baseMs: options.baseMs,
    capMs: options.capMs,
    random: options.random,
    onUnit: options.onUnit,
    onRetryBudget: options.onRetryBudget,
    requireRetryBudget: options.requireRetryBudget,
  });
}

function stubChat(
  responses: Readonly<Record<string, string>>,
  failFirstName?: string,
): { chat: ChatClient; requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  const attempts = new Map<string, number>();
  const chat: ChatClient = {
    complete: async (request) => {
      requests.push(request);
      const name = request.responseFormat.json_schema.name;
      const attempt = (attempts.get(name) ?? 0) + 1;
      attempts.set(name, attempt);
      if (name === failFirstName && attempt === 1) throw new Error("transient stub failure");
      const content = responses[name];
      if (content === undefined) throw new Error(`No stub response for "${name}".`);
      return {
        content,
        finishReason: "stop",
        usage: {
          promptTokens: requests.length * 10,
          completionTokens: requests.length,
          cachedPromptTokens: requests.length,
          cacheCreationPromptTokens: requests.length * 2,
        },
      };
    },
  };
  return { chat, requests };
}

const normalizeFields = (fields: Fields): Fields => ({
  ...fields,
  building: {
    ...fields.building,
    details: {
      ...fields.building.details,
      color: { ...fields.building.details.color, confidence: 0 },
    },
  },
});

const eventShape = (event: GroupUnit): Record<string, unknown> => ({
  unit: event.unit,
  phase: event.phase,
  attempt: event.attempt,
  key: event.key,
  part: event.part,
  parts: event.parts,
  ...(event.usage === undefined ? {} : { usage: event.usage }),
  ...(event.error instanceof Error ? { error: event.error.message } : {}),
});

describe("plannedExtractor — composition with the reviewed static plan", () => {
  test("requests, labels, schedule, retries, usage, normalization and nested fields match manual composition", async () => {
    const plannedStub = stubChat(successfulResponses, names.construction);
    const manualStub = stubChat(successfulResponses, names.construction);
    const plannedEvents: GroupUnit[] = [];
    const manualEvents: GroupUnit[] = [];
    const plannedDelays: number[] = [];
    const manualDelays: number[] = [];
    const plannedNormalized: Fields[] = [];
    const manualNormalized: Fields[] = [];
    const common = {
      target,
      plan,
      model: "stub-model",
      maxTokens: 500,
      concurrency: 1,
      maxRetries: 1,
      stepTimeoutMs: 2_000_000,
      baseMs: 200,
      capMs: 400,
      random: () => 0.5,
    };

    const planned = plannedExtractor({
      ...common,
      chat: plannedStub.chat,
      onUnit: (event) => plannedEvents.push(event),
      delay: async (ms) => {
        plannedDelays.push(ms);
      },
      normalize: (fields) => {
        plannedNormalized.push(fields);
        return normalizeFields(fields);
      },
    });
    const manual = manuallyComposed({
      ...common,
      chat: manualStub.chat,
      onUnit: (event) => manualEvents.push(event),
      delay: async (ms) => {
        manualDelays.push(ms);
      },
      normalize: (fields) => {
        manualNormalized.push(fields);
        return normalizeFields(fields);
      },
    });

    const plannedResult = await planned.extract(transcript);
    const manualResult = await manual.extract(transcript);

    expect(plannedStub.requests).toEqual(manualStub.requests);
    expect(plannedStub.requests.map((request) => request.responseFormat.json_schema.name)).toEqual([
      names.construction,
      names.construction,
      names.finish,
      names.componentNames,
      names.componentSerials,
    ]);
    expect(plannedStub.requests[0]).toEqual(plannedStub.requests[1]);
    for (const [index, entry] of pieces.entries()) {
      const request = plannedStub.requests.find(
        (candidate) =>
          candidate.responseFormat.json_schema.name ===
          requestName(index, entry.name.replaceAll(" ", "-"), entry.key),
      );
      expect(request?.messages[0]?.content).toContain(entry.description);
      expect(request?.messages[0]?.content).toContain(
        `This call covers the ${entry.name} fields of ${entry.key}.`,
      );
    }

    expect(plannedEvents.map(eventShape)).toEqual(manualEvents.map(eventShape));
    expect(plannedEvents.map(eventShape)).toEqual([
      { unit: "group", phase: "start", attempt: 1, key: "building", part: 1, parts: 2 },
      {
        unit: "group",
        phase: "error",
        attempt: 1,
        key: "building",
        part: 1,
        parts: 2,
        error: "transient stub failure",
      },
      { unit: "group", phase: "start", attempt: 2, key: "building", part: 1, parts: 2 },
      {
        unit: "group",
        phase: "done",
        attempt: 2,
        key: "building",
        part: 1,
        parts: 2,
        usage: { inputTokens: 20, outputTokens: 2 },
      },
      { unit: "group", phase: "start", attempt: 1, key: "building", part: 2, parts: 2 },
      {
        unit: "group",
        phase: "done",
        attempt: 1,
        key: "building",
        part: 2,
        parts: 2,
        usage: { inputTokens: 30, outputTokens: 3 },
      },
      { unit: "group", phase: "start", attempt: 1, key: "systems", part: 1, parts: 2 },
      {
        unit: "group",
        phase: "done",
        attempt: 1,
        key: "systems",
        part: 1,
        parts: 2,
        usage: { inputTokens: 40, outputTokens: 4 },
      },
      { unit: "group", phase: "start", attempt: 1, key: "systems", part: 2, parts: 2 },
      {
        unit: "group",
        phase: "done",
        attempt: 1,
        key: "systems",
        part: 2,
        parts: 2,
        usage: { inputTokens: 50, outputTokens: 5 },
      },
    ]);
    expect(plannedDelays).toEqual([100]);
    expect(manualDelays).toEqual(plannedDelays);

    expect(plannedResult).toEqual(manualResult);
    expect(plannedResult.fields).toEqual({
      building: {
        details: {
          year: envelope(1984, "Built in 1984"),
          color: { ...envelope("red", "red siding"), confidence: 0 },
        },
      },
      systems: [
        {
          sourceSpan: "The boiler serial is A-1.",
          components: [{ sourceSpan: "The boiler serial is A-1.", name: "boiler", serial: "A-1" }],
        },
      ],
    });
    expect(plannedResult.usage).toEqual({
      calls: 5,
      promptTokens: 140,
      completionTokens: 14,
      cachedPromptTokens: 14,
      cacheCreationPromptTokens: 28,
    });
    expect(plannedNormalized).toHaveLength(1);
    expect(manualNormalized).toHaveLength(1);
    expect(plannedNormalized[0]).toEqual(plannedResult.raw);
    expect(manualNormalized[0]).toEqual(manualResult.raw);
  });

  test("caller cancellation reaches the in-flight stub identically in both compositions", async () => {
    const run = async (manualComposition: boolean) => {
      const controller = new AbortController();
      let requests = 0;
      let observedAbort = false;
      let announceStart: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        announceStart = resolve;
      });
      const chat: ChatClient = {
        complete: (_request, options) => {
          requests += 1;
          announceStart?.();
          return new Promise((_, reject) => {
            options?.signal?.addEventListener(
              "abort",
              () => {
                observedAbort = true;
                reject(new Error("stub chat aborted"));
              },
              { once: true },
            );
          });
        },
      };
      const options = { target, plan, chat, model: "stub-model", concurrency: 1 };
      const extractor = manualComposition ? manuallyComposed(options) : plannedExtractor(options);
      const running = extractor.extract(transcript, { signal: controller.signal });
      await started;
      controller.abort();
      const error = await running.catch((cause: unknown) => cause);
      return { requests, observedAbort, error };
    };

    const planned = await run(false);
    const manual = await run(true);

    expect(planned.error).toBeInstanceOf(Error);
    expect((planned.error as Error).message).toBe("stub chat aborted");
    expect(planned.requests).toBe(1);
    expect(planned.observedAbort).toBe(true);
    expect(manual).toEqual(planned);
  });

  test("unequal nested collection answers still fail at the authoritative closing full-schema parse", async () => {
    const stub = stubChat({
      ...successfulResponses,
      [names.componentNames]: JSON.stringify({
        systems: [
          {
            sourceSpan: "first system",
            components: [{ sourceSpan: "first component", name: "boiler" }],
          },
          {
            sourceSpan: "second system",
            components: [{ sourceSpan: "second component", name: "pump" }],
          },
        ],
      }),
    });
    const extractor = plannedExtractor({ target, plan, chat: stub.chat, model: "stub-model" });

    const error = await extractor.extract(transcript).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(SchemaParseError);
    expect((error as Error).message).toContain('merged response for "planned-nested"');
  });
});
