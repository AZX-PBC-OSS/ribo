/**
 * @file The two fingerprints: what moves them and what does not.
 *
 * The run fingerprint covers the schema document and the prompt inputs, and
 * nothing else. The corpus fingerprint covers the cases' inputs and expected
 * answers, and nothing else. These suites pin both halves of that rule: a
 * prompt edit always moves the run fingerprint (a whitespace-only edit
 * included), a cosmetic JSON edit never does, and the two fingerprints never
 * cover each other's business.
 *
 * The runs are driven over the stub chat — no model, no network, no
 * credential — and every suite asserts the stub saw calls.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, expect, test } from "vitest";

import { isRecordCurrent } from "./record-fingerprint.js";
import type { EvalRunRecord, EvalRunRecordDraft } from "./record-schema.js";
import { corpusWithoutDocuments, removeTemporaries } from "./test-support/corpus.js";
import { recordOverCorpus } from "./test-support/record.js";

afterEach(() => {
  removeTemporaries();
});

/** The settings every fingerprint suite runs under. */
const settings = { strategies: ["single-shot"], model: "ribo-test" } as const;

/** A draft as a complete record, with the empty lineage a first write gives it. */
const asRecord = (draft: EvalRunRecordDraft): EvalRunRecord => ({ ...draft, history: [] });

/** The identity a record carries — the four fields freshness is judged on. */
const identityOf = (record: EvalRunRecord) => ({
  backend: record.backend,
  model: record.model,
  settings: record.settings,
  fingerprint: record.fingerprint,
});

/**
 * Edit a copied corpus's manifest prompt.
 * @param dir - The copied corpus's directory.
 * @param edit - The edit to apply to the prompt inputs.
 */
const editManifest = (dir: string, edit: (prompt: Record<string, unknown>) => void): void => {
  const file = path.join(dir, "manifest.json");
  const document = JSON.parse(readFileSync(file, "utf8")) as { prompt: Record<string, unknown> };
  edit(document.prompt);
  writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`);
};

/**
 * Edit a copied corpus's case file.
 * @param dir - The copied corpus's directory.
 * @param caseId - The case's id.
 * @param edit - The edit to apply to the case file.
 */
const editCase = (
  dir: string,
  caseId: string,
  edit: (document: Record<string, unknown>) => void,
): void => {
  const file = path.join(dir, caseId, "case.json");
  const document = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  edit(document);
  writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`);
};

/**
 * Reorder every object's keys, at every depth, and reformat the whitespace.
 *
 * This is the "cosmetic" edit the design fixes: the parsed values are
 * unchanged, so a canonical fingerprint does not move.
 * @param value - The value to rewrite.
 * @returns The same value, with every object's keys reversed.
 */
const reorderKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(reorderKeys);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).reverse();
    return Object.fromEntries(entries.map(([key, member]) => [key, reorderKeys(member)]));
  }
  return value;
};

/**
 * Rewrite a JSON file with its keys reordered and its whitespace reformatted.
 * @param file - The file to rewrite.
 */
const rewriteCosmetically = (file: string): void => {
  const document = JSON.parse(readFileSync(file, "utf8")) as unknown;
  writeFileSync(file, `${JSON.stringify(reorderKeys(document), null, 4)}\n`);
};

test("two runs differing only in their instructions produce different fingerprints", async () => {
  const first = await recordOverCorpus(corpusWithoutDocuments(), settings);
  const changed = corpusWithoutDocuments();
  editManifest(changed, (prompt) => {
    prompt["instructions"] = "Read the note and extract the frame details and the service details.";
  });
  const second = await recordOverCorpus(changed, settings);

  expect(first.calls).toBeGreaterThan(0);
  expect(second.calls).toBeGreaterThan(0);
  expect(first.record.fingerprint).not.toBe(second.record.fingerprint);

  // A freshness consumer shown the earlier record against the later
  // fingerprint reports it stale.
  const earlier = asRecord(first.record);
  expect(isRecordCurrent(earlier, identityOf(asRecord(second.record)))).toBe(false);
});

test("two runs differing only in their examples produce different fingerprints", async () => {
  const first = await recordOverCorpus(corpusWithoutDocuments(), settings);
  const changed = corpusWithoutDocuments();
  editManifest(changed, (prompt) => {
    const examples = prompt["examples"] as { transcript: string }[];
    examples[0]!.transcript = "Dropped off a carbon frame, serial number BW-2000.";
  });
  const second = await recordOverCorpus(changed, settings);

  expect(first.calls).toBeGreaterThan(0);
  expect(second.calls).toBeGreaterThan(0);
  expect(first.record.fingerprint).not.toBe(second.record.fingerprint);
  expect(isRecordCurrent(asRecord(first.record), identityOf(asRecord(second.record)))).toBe(false);
});

test("a whitespace-only edit to the instructions changes the fingerprint", async () => {
  const first = await recordOverCorpus(corpusWithoutDocuments(), settings);
  const changed = corpusWithoutDocuments();
  editManifest(changed, (prompt) => {
    const instructions = prompt["instructions"] as string;
    prompt["instructions"] = `${instructions} `;
  });
  const second = await recordOverCorpus(changed, settings);

  expect(first.calls).toBeGreaterThan(0);
  expect(second.calls).toBeGreaterThan(0);
  // The prompt text is hashed exactly: no whitespace folding, ever.
  expect(first.record.fingerprint).not.toBe(second.record.fingerprint);
});

test("a whitespace-only edit to an example's transcript changes the fingerprint", async () => {
  const first = await recordOverCorpus(corpusWithoutDocuments(), settings);
  const changed = corpusWithoutDocuments();
  editManifest(changed, (prompt) => {
    const examples = prompt["examples"] as { transcript: string }[];
    examples[0]!.transcript = `${examples[0]!.transcript}\n`;
  });
  const second = await recordOverCorpus(changed, settings);

  expect(first.calls).toBeGreaterThan(0);
  expect(second.calls).toBeGreaterThan(0);
  expect(first.record.fingerprint).not.toBe(second.record.fingerprint);
});

test("a cosmetic rewrite of the schema and the manifest leaves the fingerprint unchanged", async () => {
  const first = await recordOverCorpus(corpusWithoutDocuments(), settings);
  const cosmetic = corpusWithoutDocuments();
  rewriteCosmetically(path.join(cosmetic, "schema.json"));
  rewriteCosmetically(path.join(cosmetic, "manifest.json"));
  const second = await recordOverCorpus(cosmetic, settings);

  expect(first.calls).toBeGreaterThan(0);
  expect(second.calls).toBeGreaterThan(0);
  expect(second.record.fingerprint).toBe(first.record.fingerprint);
});

test("a cosmetic rewrite of a case file leaves the corpus fingerprint unchanged", async () => {
  const first = await recordOverCorpus(corpusWithoutDocuments(), settings);
  const cosmetic = corpusWithoutDocuments();
  rewriteCosmetically(path.join(cosmetic, "spoken-note", "case.json"));
  const second = await recordOverCorpus(cosmetic, settings);

  expect(first.calls).toBeGreaterThan(0);
  expect(second.calls).toBeGreaterThan(0);
  expect(second.record.corpus.fingerprint).toBe(first.record.corpus.fingerprint);
});

test("an edit to a group instruction changes the fingerprint, and reordering the map's keys does not", async () => {
  const withGroups = corpusWithoutDocuments();
  editManifest(withGroups, (prompt) => {
    prompt["groupInstructions"] = {
      frame: "Extract only the frame details.",
      service: "Extract only the service details.",
    };
  });
  const reordered = corpusWithoutDocuments();
  editManifest(reordered, (prompt) => {
    prompt["groupInstructions"] = {
      service: "Extract only the service details.",
      frame: "Extract only the frame details.",
    };
  });
  const edited = corpusWithoutDocuments();
  editManifest(edited, (prompt) => {
    prompt["groupInstructions"] = {
      frame: "Extract only the frame details, please.",
      service: "Extract only the service details.",
    };
  });

  const base = await recordOverCorpus(withGroups, settings);
  const sameMap = await recordOverCorpus(reordered, settings);
  const different = await recordOverCorpus(edited, settings);

  expect(base.calls).toBeGreaterThan(0);
  expect(sameMap.calls).toBeGreaterThan(0);
  expect(different.calls).toBeGreaterThan(0);
  // A map is hashed as a map: key order is free.
  expect(sameMap.record.fingerprint).toBe(base.record.fingerprint);
  // The group's text is prompt text: it is hashed exactly.
  expect(different.record.fingerprint).not.toBe(base.record.fingerprint);
});

test("switching the field-descriptions mode changes the fingerprint", async () => {
  const first = await recordOverCorpus(corpusWithoutDocuments(), settings);
  const changed = corpusWithoutDocuments();
  editManifest(changed, (prompt) => {
    prompt["fieldDescriptions"] = "prompt";
  });
  const second = await recordOverCorpus(changed, settings);

  expect(first.calls).toBeGreaterThan(0);
  expect(second.calls).toBeGreaterThan(0);
  expect(second.record.fingerprint).not.toBe(first.record.fingerprint);
});

test("the two fingerprints cover their own input sets and no other", async () => {
  const base = corpusWithoutDocuments();
  const editedCase = corpusWithoutDocuments();
  editCase(editedCase, "spoken-note", (document) => {
    const expected = document["expected"] as Record<string, { value: string }>;
    expected["frame.material"] = { ...expected["frame.material"]!, value: "aluminium" };
  });
  const editedPrompt = corpusWithoutDocuments();
  editManifest(editedPrompt, (prompt) => {
    prompt["instructions"] = "A different instruction, word for word.";
  });

  const original = await recordOverCorpus(base, settings);
  const caseEdit = await recordOverCorpus(editedCase, settings);
  const promptEdit = await recordOverCorpus(editedPrompt, settings);

  expect(original.calls).toBeGreaterThan(0);
  expect(caseEdit.calls).toBeGreaterThan(0);
  expect(promptEdit.calls).toBeGreaterThan(0);

  // An edited answer changes the corpus fingerprint and leaves the run
  // fingerprint alone.
  expect(caseEdit.record.corpus.fingerprint).not.toBe(original.record.corpus.fingerprint);
  expect(caseEdit.record.fingerprint).toBe(original.record.fingerprint);

  // An edited instruction does the reverse.
  expect(promptEdit.record.corpus.fingerprint).toBe(original.record.corpus.fingerprint);
  expect(promptEdit.record.fingerprint).not.toBe(original.record.fingerprint);
});
