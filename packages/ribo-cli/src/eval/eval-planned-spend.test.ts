/**
 * @file Planned spend bounds come from core's actual dry-run targets and the
 * requests those targets project. Caps, semantic guidance, ladders, retries,
 * consensus and the pre-chat ceiling are all measured with stub transports.
 */
import {
  describeExtraction,
  parseSchemaPlan,
  plannedPerGroupPlan,
  SCHEMA_PLAN_CONTRACT_VERSION,
} from "@azx/ribo-core";
import type { ExtractionTarget, SchemaPlan } from "@azx/ribo-core";
import { afterEach, expect, test } from "vitest";

import { loadCorpus } from "../corpus/loader.js";
import type { LoadedCorpus } from "../corpus/loader.js";
import { describeCalls } from "../inspect/calls.js";
import { schemaFingerprint } from "../inspect/fingerprint.js";
import { runEvalWithSettings } from "./run.js";
import { enforceSpendCeiling } from "./spend-ceiling.js";
import { CHARS_PER_TOKEN, estimateSpend } from "./spend-guard.js";
import { buildEvalTarget } from "./target.js";
import { stubChat } from "./test-support/stub-chat.js";
import { FIXTURE_SPLIT_CORPUS, removeTemporaries } from "./test-support/corpus.js";
import type { EvalSettingsInput } from "./types.js";

afterEach(() => {
  removeTemporaries();
});

type DryRunTarget = ExtractionTarget<Record<string, unknown>>;

function makePlan(corpus: LoadedCorpus): SchemaPlan {
  return parseSchemaPlan(
    {
      version: SCHEMA_PLAN_CONTRACT_VERSION,
      schemaFingerprint: schemaFingerprint(corpus.schemaDocument),
      fieldPaths: [
        "equipment.assetTag",
        "equipment.model",
        "equipment.serial",
        "equipment.installedOn",
        "equipment.warrantyEnds",
        "equipment.lastServiced",
        "site.siteName",
        "site.address",
        "site.technician",
        "site.visits",
        "site.accessNotes",
        "site.alarms",
      ],
      pieces: [
        {
          name: "Equipment",
          description: "The equipment's identity and service history stay together.",
          key: "equipment",
          paths: [
            "equipment.assetTag",
            "equipment.model",
            "equipment.serial",
            "equipment.installedOn",
            "equipment.warrantyEnds",
            "equipment.lastServiced",
          ],
        },
        {
          name: "Site",
          description: "The site's identity, access and service notes stay together.",
          key: "site",
          paths: [
            "site.siteName",
            "site.address",
            "site.technician",
            "site.visits",
            "site.accessNotes",
            "site.alarms",
          ],
        },
      ],
      provenance: {
        model: "planning-stub",
        backend: "stub-backend",
        createdAt: "2026-11-13T09:00:00.000Z",
      },
    },
    corpus.schema,
  );
}

const targetList = (entry: DryRunTarget | readonly DryRunTarget[]): readonly DryRunTarget[] =>
  Array.isArray(entry) ? (entry as readonly DryRunTarget[]) : [entry as DryRunTarget];

function dryRunTargets(
  corpus: LoadedCorpus,
  plan: SchemaPlan,
  settings: EvalSettingsInput,
): readonly DryRunTarget[] {
  const { target } = buildEvalTarget(
    corpus.schema,
    corpus.manifest.prompt,
    corpus.manifest.name,
    settings.splitCaps ?? {},
  );
  const compiled = plannedPerGroupPlan({
    target,
    plan,
    chat: stubChat(),
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
  return Object.values(
    compiled.targets as unknown as Record<string, DryRunTarget | readonly DryRunTarget[]>,
  ).flatMap(targetList);
}

const settingsWithCaps = (caps: number): EvalSettingsInput => ({
  strategies: ["planned"],
  model: "ribo-test",
  maxRetries: 0,
  splitCaps: { maxSerializedCharsPerGroup: caps },
});

test("cap-sensitive planned counts come from core's dry run and match the stub calls", async () => {
  const corpus = loadCorpus(FIXTURE_SPLIT_CORPUS);
  const plan = makePlan(corpus);
  const uncapped = settingsWithCaps(100_000);
  const capped = settingsWithCaps(1500);
  const baselineCount = dryRunTargets(corpus, plan, uncapped).length;
  const cappedTargets = dryRunTargets(corpus, plan, capped);
  expect(cappedTargets.length).toBeGreaterThan(baselineCount);

  const estimate = estimateSpend({
    corpus,
    arms: [capped],
    backend: "openai-compatible",
    model: capped.model,
    plan,
  });
  const chat = stubChat();
  const run = await runEvalWithSettings(corpus, chat, capped, { plan });

  expect(run.results[0]?.status).toBe("extracted");
  expect(chat.calls).toHaveLength(cappedTargets.length);
  expect(estimate.arms[0]?.rungs).toEqual([{ strategy: "planned", calls: cappedTargets.length }]);
  expect(estimate.arms[0]?.callsPerCase).toBe(chat.calls.length);
  expect(estimate.worstCaseCalls).toBe(chat.calls.length);
});

test("planned prompt size measures the actual projected requests, including semantic plan text", async () => {
  const corpus = loadCorpus(FIXTURE_SPLIT_CORPUS);
  const original = makePlan(corpus);
  const semanticMarker = `Reviewed semantic guidance ${"keep these facts together ".repeat(80)}`;
  const plan = structuredClone(original);
  plan.pieces[0]!.description = semanticMarker;
  const settings = settingsWithCaps(1500);

  const baseline = estimateSpend({
    corpus,
    arms: [settings],
    backend: "openai-compatible",
    model: settings.model,
    plan: original,
  });
  const estimate = estimateSpend({
    corpus,
    arms: [settings],
    backend: "openai-compatible",
    model: settings.model,
    plan,
  });
  const chat = stubChat();
  await runEvalWithSettings(corpus, chat, settings, { plan });

  expect(chat.calls.some((request) => request.messages[0]?.content.includes(semanticMarker))).toBe(
    true,
  );
  const measuredRequests = chat.calls.map((request) => {
    const messageChars = request.messages.reduce(
      (total, message) => total + message.content.length + 8,
      0,
    );
    const wireChars = JSON.stringify(request.responseFormat.json_schema.schema).length;
    return Math.ceil((messageChars + wireChars) / CHARS_PER_TOKEN);
  });
  expect(estimate.arms[0]?.promptTokensPerCall).toBe(Math.max(...measuredRequests));
  expect(estimate.arms[0]?.promptTokensPerCall).toBeGreaterThan(
    baseline.arms[0]?.promptTokensPerCall ?? 0,
  );
});

test("the planned rung retains ladder, retry and consensus multipliers", () => {
  const corpus = loadCorpus(FIXTURE_SPLIT_CORPUS);
  const plan = makePlan(corpus);
  const plannedCount = dryRunTargets(corpus, plan, settingsWithCaps(1500)).length;
  const caps = { maxSerializedCharsPerGroup: 1500 };
  const perGroupCount = describeCalls(
    describeExtraction({ schema: corpus.schema, ...caps }),
    caps,
  ).perGroup;
  expect(perGroupCount).not.toBeNull();
  const settings: EvalSettingsInput = {
    strategies: ["planned", "per-group"],
    model: "ribo-test",
    maxRetries: 2,
    consensusCandidates: 3,
    consensusArbiter: "majority",
    responseCap: 123,
    splitCaps: caps,
  };

  const estimate = estimateSpend({
    corpus,
    arms: [settings],
    backend: "openai-compatible",
    model: settings.model,
    plan,
  });
  const arm = estimate.arms[0]!;

  expect(arm.rungs).toEqual([
    { strategy: "planned", calls: plannedCount },
    { strategy: "per-group", calls: perGroupCount },
  ]);
  expect(arm.retryMultiplier).toBe(3);
  expect(arm.consensusCandidates).toBe(3);
  expect(arm.callsPerCase).toBe((plannedCount + perGroupCount!) * 3 * 3);
  expect(arm.completionTokensPerCall).toBe(settings.responseCap);
  expect(estimate.worstCaseCalls).toBe(arm.callsPerCase * corpus.cases.length);
});

test("an over-ceiling planned estimate refuses before the guarded runner can make a chat call", async () => {
  const corpus = loadCorpus(FIXTURE_SPLIT_CORPUS);
  const plan = makePlan(corpus);
  const settings = settingsWithCaps(1500);
  const estimate = estimateSpend({
    corpus,
    arms: [settings],
    backend: "openai-compatible",
    model: settings.model,
    plan,
  });
  const chat = stubChat();
  expect(estimate.arms[0]?.rungs[0]?.calls).toBe(dryRunTargets(corpus, plan, settings).length);

  const guardedRun = async () => {
    await enforceSpendCeiling({ estimate, maxSpendUsd: 0, yes: false });
    return runEvalWithSettings(corpus, chat, settings, { plan });
  };

  await expect(guardedRun()).rejects.toThrow(/above the ceiling/u);
  expect(chat.calls).toHaveLength(0);
});

test("a stray plan is not silently ignored by a non-planned estimate", () => {
  const corpus = loadCorpus(FIXTURE_SPLIT_CORPUS);
  const plan = makePlan(corpus);
  const settings: EvalSettingsInput = { strategies: ["single-shot"], model: "ribo-test" };

  expect(() =>
    estimateSpend({
      corpus,
      arms: [settings],
      backend: "openai-compatible",
      model: settings.model,
      plan,
    }),
  ).toThrow(/plan.*planned|planned.*plan/u);
});
