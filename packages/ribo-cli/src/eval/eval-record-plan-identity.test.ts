/**
 * @file Planned settings persist core's semantic plan identity without
 * changing the schema/prompt fingerprint or collapsing record lineage.
 */
import { planFingerprint, SCHEMA_PLAN_CONTRACT_VERSION } from "@azx/ribo-core";
import type { SchemaPlan } from "@azx/ribo-core";
import { afterEach, expect, test } from "vitest";

import type { LoadedCorpus } from "../corpus.js";
import { buildEvalRunRecord } from "./record-build.js";
import { recordIdentity, runFingerprint } from "./record-fingerprint.js";
import { corpusWithoutDocuments, removeTemporaries } from "./test-support/corpus.js";
import { recordOverCorpus } from "./test-support/record.js";

afterEach(() => {
  removeTemporaries();
});

/** A semantic plan over the fixture corpus's complete field set. */
const plan = (): SchemaPlan => ({
  version: SCHEMA_PLAN_CONTRACT_VERSION,
  schemaFingerprint: "a".repeat(64),
  fieldPaths: ["frame.material", "frame.serial", "service.date", "service.notes"],
  pieces: [
    {
      name: "Frame",
      description: "The frame's material and serial number.",
      key: "frame",
      paths: ["frame.material", "frame.serial"],
    },
    {
      name: "Service",
      description: "The service date and notes.",
      key: "service",
      paths: ["service.date", "service.notes"],
    },
  ],
  provenance: {
    model: "planning-stub",
    backend: "stub-backend",
    createdAt: "2026-11-13T09:00:00.000Z",
  },
});

/** One scored fixture run, with a factory for runner-issued planned settings. */
const plannedRecords = async () => {
  const run = await recordOverCorpus(corpusWithoutDocuments(), {
    strategies: ["single-shot"],
    model: "ribo-test",
  });
  return {
    run,
    recordFor: async (semanticPlan: SchemaPlan, corpus: LoadedCorpus = run.corpus) => {
      const planIdentity = await planFingerprint(semanticPlan);
      const record = buildEvalRunRecord({
        corpus,
        backend: "openai-compatible",
        settings: {
          strategies: ["planned"],
          model: "ribo-test",
          planFingerprint: planIdentity,
        },
        results: run.results,
        score: run.score,
        capturedAt: "2026-11-13T10:00:00.000Z",
      });
      return { record, planIdentity };
    },
  };
};

test("reordering root fieldPaths alone leaves plan and record identity unchanged", async () => {
  const { run, recordFor } = await plannedRecords();
  const original = await recordFor(plan());
  const reorderedPlan = { ...plan(), fieldPaths: [...plan().fieldPaths].reverse() };
  const reordered = await recordFor(reorderedPlan);

  expect(original.record.settings.planFingerprint).toBe(original.planIdentity);
  expect(reordered.record.settings.planFingerprint).toBe(await planFingerprint(reorderedPlan));
  expect(reordered.planIdentity).toBe(original.planIdentity);
  expect(recordIdentity(reordered.record)).toBe(recordIdentity(original.record));
  expect(reordered.record.fingerprint).toBe(run.record.fingerprint);
});

test("piece-path order, membership, name and description move both identities only", async () => {
  const { run, recordFor } = await plannedRecords();
  const original = await recordFor(plan());
  const edits: ReadonlyArray<readonly [string, (candidate: SchemaPlan) => void]> = [
    ["piece-path order", (candidate) => candidate.pieces[0]!.paths.reverse()],
    [
      "piece membership",
      (candidate) => {
        candidate.pieces = [
          { ...candidate.pieces[0]!, paths: ["frame.material"] },
          {
            name: "Frame identifiers",
            description: "The serial number, planned separately.",
            key: "frame",
            paths: ["frame.serial"],
          },
          candidate.pieces[1]!,
        ];
      },
    ],
    ["piece name", (candidate) => void (candidate.pieces[0]!.name = "Renamed frame")],
    [
      "piece description",
      (candidate) => void (candidate.pieces[0]!.description = "A different semantic description."),
    ],
  ];

  for (const [name, edit] of edits) {
    const changedPlan = structuredClone(plan());
    edit(changedPlan);
    const changed = await recordFor(changedPlan);
    expect(changed.planIdentity, name).not.toBe(original.planIdentity);
    expect(recordIdentity(changed.record), name).not.toBe(recordIdentity(original.record));
    expect(changed.record.settings.planFingerprint, name).toBe(await planFingerprint(changedPlan));
    expect(changed.record.fingerprint, name).toBe(run.record.fingerprint);
  }
});

test("provenance, stored schema fingerprints and schema property order are not identity", async () => {
  const { run, recordFor } = await plannedRecords();
  const original = await recordFor(plan());

  const provenancePlan = structuredClone(plan());
  provenancePlan.provenance = {
    model: "another-planner",
    backend: "another-backend",
    createdAt: "2027-01-02T03:04:05.000Z",
  };
  const provenanceOnly = await recordFor(provenancePlan);

  const storedFingerprintPlan = { ...plan(), schemaFingerprint: "b".repeat(64) };
  const storedFingerprintOnly = await recordFor(storedFingerprintPlan);

  const reorderedDocument = structuredClone(run.corpus.schemaDocument) as {
    properties: Record<string, unknown>;
  };
  reorderedDocument.properties = Object.fromEntries(
    Object.entries(reorderedDocument.properties).reverse(),
  );
  const propertyOrderOnly = await recordFor(plan(), {
    ...run.corpus,
    schemaDocument: reorderedDocument,
  });

  for (const changed of [provenanceOnly, storedFingerprintOnly, propertyOrderOnly]) {
    expect(changed.planIdentity).toBe(original.planIdentity);
    expect(recordIdentity(changed.record)).toBe(recordIdentity(original.record));
    expect(changed.record.fingerprint).toBe(original.record.fingerprint);
  }
});

test("real schema and prompt edits still move runFingerprint", async () => {
  const { run, recordFor } = await plannedRecords();
  const original = await recordFor(plan());

  const changedDocument = structuredClone(run.corpus.schemaDocument) as { description: string };
  changedDocument.description = "A materially different schema description.";
  const changedSchemaCorpus = { ...run.corpus, schemaDocument: changedDocument };
  const changedSchema = await recordFor(plan(), changedSchemaCorpus);

  const changedPromptCorpus = {
    ...run.corpus,
    manifest: {
      ...run.corpus.manifest,
      prompt: {
        ...run.corpus.manifest.prompt,
        instructions: `${run.corpus.manifest.prompt.instructions} Include every observation.`,
      },
    },
  };
  const changedPrompt = await recordFor(plan(), changedPromptCorpus);

  for (const [corpus, changed] of [
    [changedSchemaCorpus, changedSchema],
    [changedPromptCorpus, changedPrompt],
  ] as const) {
    const expected = runFingerprint(corpus.schemaDocument, corpus.manifest.prompt);
    expect(expected).not.toBe(original.record.fingerprint);
    expect(changed.record.fingerprint).toBe(expected);
    expect(changed.planIdentity).toBe(original.planIdentity);
  }
});
