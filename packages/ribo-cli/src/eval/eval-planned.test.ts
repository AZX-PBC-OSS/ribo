/**
 * @file Planned eval execution through core's reviewed-plan strategy.
 * Every transport and transcriber is a stub; construction faults are run
 * refusals, while extraction faults remain per-case measurements.
 */
import path from "node:path";

import {
  ChatError,
  enveloped,
  parseSchemaPlan,
  planFingerprint,
  plannedPerGroupPlan,
  SCHEMA_PLAN_CONTRACT_VERSION,
  scriptedChat,
  toJsonSchemaForWire,
} from "@azx/ribo-core";
import type {
  DocumentCapture,
  ExtractionTarget,
  SchemaPlan,
  SchemaPlanPiece,
  Transcriber,
  Transcript,
} from "@azx/ribo-core";
import { afterEach, expect, test } from "vitest";
import { z } from "zod";

import { loadCorpus } from "../corpus/loader.js";
import type { LoadedCorpus } from "../corpus.js";
import { buildArm } from "./arm.js";
import { asCapableChat } from "./chat.js";
import { EvalError } from "./error.js";
import { runEval, runEvalWithSettings } from "./run.js";
import type { RunEvalOptions } from "./run.js";
import { buildEvalTarget } from "./target.js";
import { replyFor, stubChat } from "./test-support/stub-chat.js";
import {
  copiedCorpus,
  corpusWithCases,
  corpusWithDocumentCase,
  corpusWithNestedRows,
  editJson,
  FIXTURE_CORPUS,
  removeTemporaries,
} from "./test-support/corpus.js";
import type { EvalSettingsInput } from "./types.js";

afterEach(() => {
  removeTemporaries();
});

const fixturePieces: readonly SchemaPlanPiece[] = [
  {
    name: "Frame",
    description: "The frame's material and serial number stay together.",
    key: "frame",
    paths: ["frame.material", "frame.serial"],
  },
  {
    name: "Service",
    description: "The service date and notes stay together.",
    key: "service",
    paths: ["service.date", "service.notes"],
  },
];

const nestedPieces: readonly SchemaPlanPiece[] = [
  {
    name: "Construction",
    description: "Construction facts are reviewed as one semantic piece.",
    key: "building",
    paths: ["building.details.year", "building.details.color"],
  },
  {
    name: "Components",
    description: "Component identities are reviewed as one semantic piece.",
    key: "systems",
    paths: ["systems.name", "systems.serial"],
  },
];

function makePlan(schema: z.ZodObject, pieces: readonly SchemaPlanPiece[]): SchemaPlan {
  return parseSchemaPlan(
    {
      version: SCHEMA_PLAN_CONTRACT_VERSION,
      schemaFingerprint: "a".repeat(64),
      fieldPaths: pieces.flatMap((piece) => piece.paths),
      pieces: [...pieces],
      provenance: {
        model: "planning-stub",
        backend: "stub-backend",
        createdAt: "2026-11-13T09:00:00.000Z",
      },
    },
    schema,
  );
}

const fixturePlan = (corpus: LoadedCorpus): SchemaPlan => makePlan(corpus.schema, fixturePieces);
const nestedPlan = (corpus: LoadedCorpus): SchemaPlan => makePlan(corpus.schema, nestedPieces);

function countingTranscriber(): {
  readonly transcriber: Transcriber<DocumentCapture>;
  readonly calls: () => number;
} {
  let calls = 0;
  return {
    calls: () => calls,
    transcriber: {
      engine: "counting-stub",
      capability: () => Promise.resolve({ status: "ready" }),
      transcribe: (item): Promise<Transcript> => {
        calls += 1;
        return Promise.resolve({
          recordingId: item.id,
          text: "the counted document transcription",
          engine: "counting-stub",
        });
      },
    },
  };
}

type DryRunTarget = ExtractionTarget<Record<string, unknown>>;

const targetList = (entry: DryRunTarget | readonly DryRunTarget[]): readonly DryRunTarget[] =>
  Array.isArray(entry) ? (entry as readonly DryRunTarget[]) : [entry as DryRunTarget];

function dryRunTargets(
  corpus: LoadedCorpus,
  plan: SchemaPlan,
  settings: EvalSettingsInput,
): { readonly targets: readonly DryRunTarget[]; readonly chatCalls: () => number } {
  const chat = stubChat();
  const { target } = buildEvalTarget(
    corpus.schema,
    corpus.manifest.prompt,
    corpus.manifest.name,
    settings.splitCaps ?? {},
  );
  const compiled = plannedPerGroupPlan({
    target,
    plan,
    chat,
    model: settings.model,
    ...(settings.responseCap === undefined ? {} : { maxTokens: settings.responseCap }),
    ...(settings.splitCaps?.maxNullableUnionsPerGroup === undefined
      ? {}
      : { maxNullableUnionsPerGroup: settings.splitCaps.maxNullableUnionsPerGroup }),
    ...(settings.splitCaps?.maxSerializedCharsPerGroup === undefined
      ? {}
      : { maxSerializedCharsPerGroup: settings.splitCaps.maxSerializedCharsPerGroup }),
    ...(corpus.manifest.prompt.fieldDescriptions === undefined
      ? {}
      : { fieldDescriptions: corpus.manifest.prompt.fieldDescriptions }),
  });
  const byKey = compiled.targets as unknown as Record<
    string,
    DryRunTarget | readonly DryRunTarget[]
  >;
  return {
    targets: Object.values(byKey).flatMap(targetList),
    chatCalls: () => chat.calls.length,
  };
}

const envelope = (value: unknown, sourceSpan = "nested citation") => ({
  value,
  confidence: 0.9,
  sourceSpan,
});

test("planned requests match core's dry run and preserve nested values, guidance and usage", async () => {
  const corpus = loadCorpus(corpusWithNestedRows());
  const plan = nestedPlan(corpus);
  const settings: EvalSettingsInput = {
    strategies: ["planned"],
    model: "planned-model",
    responseCap: 444,
    splitCaps: { maxNullableUnionsPerGroup: 4 },
  };
  const expected = dryRunTargets(corpus, plan, settings);
  const chat = stubChat({
    sourceSpan: "nested citation",
    values: {
      "building.details.year": 1984,
      "building.details.color": "red",
      "systems.name": "boiler",
      "systems.serial": "A-1",
    },
  });

  const run = await runEvalWithSettings(corpus, chat, settings, { plan });

  expect(expected.chatCalls()).toBe(0);
  expect(expected.targets.length).toBeGreaterThan(1);
  expect(
    chat.calls.map((request) => ({
      name: request.responseFormat.json_schema.name,
      schema: request.responseFormat.json_schema.schema,
      model: request.model,
      maxTokens: request.maxTokens,
    })),
  ).toEqual(
    expected.targets.map((target) => ({
      name: target.name,
      schema: toJsonSchemaForWire(target.extractionSchema, { keepDescriptions: false }),
      model: settings.model,
      maxTokens: settings.responseCap,
    })),
  );
  for (const piece of nestedPieces) {
    expect(
      chat.calls.some((request) => request.messages[0]?.content.includes(piece.description)),
    ).toBe(true);
  }
  expect(
    chat.calls.every(
      (request) =>
        !request.messages[0]?.content.includes("Manifest group guidance must not replace"),
    ),
  ).toBe(true);
  expect(
    chat.calls.some((request) => request.messages[0]?.content.includes("construction year")),
  ).toBe(true);
  expect(run.results).toHaveLength(1);
  expect(run.results[0]?.status).toBe("extracted");
  expect(run.results[0]?.fields).toEqual({
    building: {
      details: { year: envelope(1984), color: envelope("red") },
    },
    systems: [{ name: envelope("boiler"), serial: envelope("A-1") }],
  });
  expect(run.results[0]?.usage).toMatchObject({
    calls: chat.calls.length,
    engine: "scripted",
    strategy: "planned",
  });
  expect(run.settings.planFingerprint).toBe(await planFingerprint(plan));
  expect(run.settings).not.toHaveProperty("plan");
});

test("buildArm runs planned nested rows with one citation per row and forwards retry delay", async () => {
  const patch = z.object({
    building: z.object({
      details: z.object({ year: z.number(), color: z.string() }),
    }),
    systems: z.array(
      z.object({
        components: z.array(z.object({ name: z.string(), serial: z.string() })),
      }),
    ),
  });
  const pieces: readonly SchemaPlanPiece[] = [
    {
      name: "year",
      description: "The construction year.",
      key: "building",
      paths: ["building.details.year"],
    },
    {
      name: "finish",
      description: "The exterior finish.",
      key: "building",
      paths: ["building.details.color"],
    },
    {
      name: "component names",
      description: "The component names.",
      key: "systems",
      paths: ["systems.components.name"],
    },
    {
      name: "component serials",
      description: "The component serial numbers.",
      key: "systems",
      paths: ["systems.components.serial"],
    },
  ];
  const plan = makePlan(patch, pieces);
  const target = {
    name: "planned-row-eval",
    extractionSchema: enveloped(patch, { provenance: { systems: "row" } }),
    instructions: "Extract the reviewed fields.",
    examples: [],
  } as unknown as ExtractionTarget<Record<string, unknown>>;
  const name = (pieceIndex: number, slug: string, key: string) =>
    `planned-row-eval-${pieceIndex}-${slug}-${key}`;
  const responses: Readonly<Record<string, unknown>> = {
    [name(0, "year", "building")]: {
      building: { details: { year: envelope(1984, "Built in 1984") } },
    },
    [name(1, "finish", "building")]: {
      building: { details: { color: envelope("red", "red siding") } },
    },
    [name(2, "component-names", "systems")]: {
      systems: [
        {
          sourceSpan: "system row",
          components: [{ sourceSpan: "component row", name: "boiler" }],
        },
      ],
    },
    [name(3, "component-serials", "systems")]: {
      systems: [{ components: [{ serial: "A-1" }] }],
    },
  };
  const chat = scriptedChat((request, context) => {
    if (context.call === 0) throw ChatError.transport("transient planned failure");
    const content = responses[request.responseFormat.json_schema.name];
    if (content === undefined) throw new Error("the planned stub received an unknown request");
    return { content: JSON.stringify(content) };
  });
  const delays: number[] = [];
  const arm = buildArm({
    target,
    groups: [],
    chat: asCapableChat(chat),
    model: "planned-row-model",
    plan,
    settings: {
      strategies: ["planned"],
      model: "planned-row-model",
      planFingerprint: await planFingerprint(plan),
      maxRetries: 1,
    },
    delay: async (ms) => {
      delays.push(ms);
    },
  });

  const result = await arm.extract({
    text: "Built in 1984 with red siding. The boiler serial is A-1.",
    annotations: {},
  });

  expect(
    chat.calls.filter(
      (request) => request.responseFormat.json_schema.name === name(0, "year", "building"),
    ),
  ).toHaveLength(2);
  expect(delays).toHaveLength(1);
  expect(result.usage).toMatchObject({ calls: chat.calls.length, strategy: "planned" });
  expect(result.fields).toEqual({
    building: {
      details: {
        year: { ...envelope(1984, "Built in 1984"), confidence: 0.9 },
        color: { ...envelope("red", "red siding"), confidence: 0.9 },
      },
    },
    systems: [
      {
        sourceSpan: "system row",
        components: [{ sourceSpan: "component row", name: "boiler", serial: "A-1" }],
      },
    ],
  });
  const fields = result.fields as unknown as {
    systems: (Record<string, unknown> & { components: Record<string, unknown>[] })[];
  };
  expect(Object.keys(fields.systems[0]!).sort()).toEqual(["components", "sourceSpan"]);
  expect(Object.keys(fields.systems[0]!.components[0]!).sort()).toEqual([
    "name",
    "serial",
    "sourceSpan",
  ]);
});

test("runner identity matches core across schema property reorder and changes on semantic edits", async () => {
  const original = loadCorpus(corpusWithCases("spoken-note"));
  const plan = fixturePlan(original);
  const settings: EvalSettingsInput = { strategies: ["planned"], model: "ribo-test" };
  const first = await runEvalWithSettings(original, stubChat(), settings, { plan });

  const reorderedDir = corpusWithCases("spoken-note");
  editJson(path.join(reorderedDir, "schema.json"), (document) => {
    const properties = document["properties"] as Record<string, unknown>;
    document["properties"] = Object.fromEntries(Object.entries(properties).reverse());
  });
  const reordered = loadCorpus(reorderedDir);
  const reorderedRun = await runEvalWithSettings(reordered, stubChat(), settings, { plan });

  const semanticPlan = structuredClone(plan);
  semanticPlan.pieces[0]!.description = "A materially different semantic assignment.";
  const semanticRun = await runEvalWithSettings(original, stubChat(), settings, {
    plan: semanticPlan,
  });
  const compatibility = await runEval(original, stubChat(), settings, { plan });

  expect(first.settings).toEqual({ ...settings, planFingerprint: await planFingerprint(plan) });
  expect(reorderedRun.settings.planFingerprint).toBe(await planFingerprint(plan));
  expect(reorderedRun.settings.planFingerprint).toBe(first.settings.planFingerprint);
  expect(semanticRun.settings.planFingerprint).toBe(await planFingerprint(semanticPlan));
  expect(semanticRun.settings.planFingerprint).not.toBe(first.settings.planFingerprint);
  expect(Array.isArray(compatibility)).toBe(true);
  expect(compatibility).toEqual(first.results);
  expect(compatibility).not.toHaveProperty("settings");
});

async function expectDocumentPreflightRefusal(
  settings: EvalSettingsInput,
  expected: RegExp,
  options: (corpus: LoadedCorpus) => Omit<RunEvalOptions, "transcriber"> = () => ({}),
): Promise<void> {
  const corpus = loadCorpus(corpusWithDocumentCase());
  const chat = stubChat();
  const counting = countingTranscriber();
  const failure = await runEvalWithSettings(corpus, chat, settings, {
    ...options(corpus),
    transcriber: counting.transcriber,
  }).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(EvalError);
  expect(failure instanceof Error ? failure.message : String(failure)).toMatch(expected);
  expect(counting.calls()).toBe(0);
  expect(chat.calls).toHaveLength(0);
}

test("a planned run without a parsed plan refuses before document transcription or chat", async () => {
  await expectDocumentPreflightRefusal(
    { strategies: ["planned"], model: "ribo-test" },
    /planned.*options\.plan|options\.plan.*planned/iu,
  );
});

test("a parsed plan supplied to a non-planned run refuses before document transcription or chat", async () => {
  await expectDocumentPreflightRefusal(
    { strategies: ["single-shot"], model: "ribo-test" },
    /options\.plan.*planned|planned.*options\.plan/iu,
    (corpus) => ({ plan: fixturePlan(corpus) }),
  );
});

test("stale plan membership refuses before document transcription or chat", async () => {
  await expectDocumentPreflightRefusal(
    { strategies: ["planned"], model: "ribo-test" },
    /coverage|omitted|stale/iu,
    (corpus) => {
      const stale = structuredClone(fixturePlan(corpus));
      stale.fieldPaths = stale.fieldPaths.filter((path) => path !== "service.notes");
      stale.pieces[1]!.paths = stale.pieces[1]!.paths.filter((path) => path !== "service.notes");
      return { plan: stale };
    },
  );
});

test("an unbuildable planned layout refuses before document transcription or chat", async () => {
  await expectDocumentPreflightRefusal(
    {
      strategies: ["planned"],
      model: "ribo-test",
      splitCaps: { maxSerializedCharsPerGroup: 1 },
    },
    /planned.*layout|maxSerializedCharsPerGroup/iu,
    (corpus) => ({ plan: fixturePlan(corpus) }),
  );
});

test("a runtime caller planFingerprint is refused, never compared with the derived value", async () => {
  const smuggled = {
    strategies: ["planned"],
    model: "ribo-test",
    planFingerprint: "f".repeat(64),
  } as EvalSettingsInput & { readonly planFingerprint: string };
  await expectDocumentPreflightRefusal(
    smuggled,
    /planFingerprint.*runner|runner.*planFingerprint/iu,
    (corpus) => ({ plan: fixturePlan(corpus) }),
  );
});

test("planned terminal failure retains per-group fallback and shares document transcription", async () => {
  const corpus = loadCorpus(copiedCorpus(FIXTURE_CORPUS));
  const plan = fixturePlan(corpus);
  const counting = countingTranscriber();
  const chat = scriptedChat((request) => {
    const name = request.responseFormat.json_schema.name;
    if (/^ribo-eval-\d+-/u.test(name)) throw ChatError.http(400, "planned rung refused");
    return { content: replyFor(request) };
  });

  const run = await runEvalWithSettings(
    corpus,
    chat,
    { strategies: ["planned", "per-group"], model: "ribo-test" },
    { plan, transcriber: counting.transcriber },
  );

  expect(counting.calls()).toBe(1);
  expect(run.results.map((entry) => entry.status)).toEqual(["extracted", "extracted", "extracted"]);
  expect(run.results.every((entry) => entry.usage?.strategy === "per-group")).toBe(true);
  expect(
    chat.calls.some((request) => /^ribo-eval-\d+-/u.test(request.responseFormat.json_schema.name)),
  ).toBe(true);
  expect(
    chat.calls.some((request) => request.responseFormat.json_schema.name === "ribo-eval-frame"),
  ).toBe(true);
  expect(
    chat.calls.some((request) =>
      request.messages.at(-1)?.content.includes("the counted document transcription"),
    ),
  ).toBe(true);
});

test("the consensus modifier retains the whole planned ladder", async () => {
  const corpus = loadCorpus(corpusWithCases("spoken-note"));
  const plan = fixturePlan(corpus);
  const settings: EvalSettingsInput = {
    strategies: ["planned"],
    model: "ribo-test",
    consensusCandidates: 2,
    consensusArbiter: "unanimous",
  };
  const expected = dryRunTargets(corpus, plan, settings);
  const chat = stubChat();

  const run = await runEvalWithSettings(corpus, chat, settings, { plan });

  expect(run.results[0]?.status).toBe("extracted");
  expect(chat.calls).toHaveLength(expected.targets.length * settings.consensusCandidates!);
  expect(run.results[0]?.usage?.calls).toBe(chat.calls.length);
  expect(run.results[0]?.fields).toMatchObject({ frame: { material: { value: "sample" } } });
});

test("planned case failures remain measurements and later cases still run", async () => {
  const corpus = loadCorpus(corpusWithCases("spoken-note", "written-ticket"));
  const chat = scriptedChat((request) => {
    throw ChatError.http(
      400,
      `planned refusal for ${request.messages.at(-1)?.content ?? "unknown case"}`,
    );
  });

  const results = await runEval(
    corpus,
    chat,
    { strategies: ["planned"], model: "ribo-test" },
    { plan: fixturePlan(corpus) },
  );

  expect(results.map((entry) => entry.caseId)).toEqual(["spoken-note", "written-ticket"]);
  expect(results.map((entry) => entry.status)).toEqual(["failed", "failed"]);
  expect(results.every((entry) => entry.error?.includes("planned refusal for"))).toBe(true);
  expect(chat.calls.length).toBeGreaterThanOrEqual(results.length);
});
