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

import { isRecordCurrent, corpusFingerprint } from "./record-fingerprint.js";
import type { EvalRunRecord, EvalRunRecordDraft } from "./record-schema.js";
import {
  copiedCorpus,
  corpusWithoutDocuments,
  editJson,
  FIXTURE_CORPUS,
  removeTemporaries,
} from "./test-support/corpus.js";
import { recordOverCorpus } from "./test-support/record.js";
import { loadCorpus } from "../corpus/loader.js";

/**
 * Rewrite a copied corpus case's `inputs` list.
 * @param dir - The copied corpus's directory.
 * @param caseId - The case's id.
 * @param inputs - The inputs list to write.
 */
const editCaseInputs = (
  dir: string,
  caseId: string,
  inputs: readonly { file: string; kind: string }[],
): void => {
  editJson(path.join(dir, caseId, "case.json"), (document) => {
    document["inputs"] = inputs;
  });
};

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

// ---------------------------------------------------------------------------
// The corpus fingerprint's inputs list and combine policy — no chat, no
// transcription: the fingerprint is a hash over the loaded corpus, so these
// load and hash directly.
// ---------------------------------------------------------------------------

test("the corpus fingerprint is stable across loads, and a valid 64-hex digest", async () => {
  const dir = copiedCorpus(FIXTURE_CORPUS, (root) => {
    writeFileSync(path.join(root, "spoken-note", "second.txt"), "a second input\n");
    editCaseInputs(root, "spoken-note", [
      { file: "input.txt", kind: "transcript" },
      { file: "second.txt", kind: "text" },
    ]);
  });
  const first = corpusFingerprint(loadCorpus(dir));
  const second = corpusFingerprint(loadCorpus(dir));

  expect(first).toMatch(/^[0-9a-f]{64}$/);
  expect(second).toBe(first);
});

test("reordering a case's inputs changes the corpus fingerprint", () => {
  const dir = copiedCorpus(FIXTURE_CORPUS, (root) => {
    writeFileSync(path.join(root, "spoken-note", "second.txt"), "a second input\n");
    editCaseInputs(root, "spoken-note", [
      { file: "input.txt", kind: "transcript" },
      { file: "second.txt", kind: "text" },
    ]);
  });
  const forward = corpusFingerprint(loadCorpus(dir));
  editCaseInputs(dir, "spoken-note", [
    { file: "second.txt", kind: "text" },
    { file: "input.txt", kind: "transcript" },
  ]);
  const reversed = corpusFingerprint(loadCorpus(dir));

  expect(reversed).not.toBe(forward);
});

test("flipping the effective markCaptures changes the corpus fingerprint", () => {
  const dir = copiedCorpus(FIXTURE_CORPUS);
  const marked = corpusFingerprint(loadCorpus(dir));
  editJson(path.join(dir, "manifest.json"), (document) => {
    document["combine"] = { markCaptures: false };
  });
  const unmarked = corpusFingerprint(loadCorpus(dir));

  expect(unmarked).not.toBe(marked);
});

test("omitted, empty and explicit-true combine blocks are one effective policy — and one fingerprint", () => {
  const dir = copiedCorpus(FIXTURE_CORPUS);
  const omitted = corpusFingerprint(loadCorpus(dir));

  editJson(path.join(dir, "manifest.json"), (document) => {
    document["combine"] = {};
  });
  const empty = corpusFingerprint(loadCorpus(dir));
  expect(empty).toBe(omitted);

  editJson(path.join(dir, "manifest.json"), (document) => {
    document["combine"] = { markCaptures: true };
  });
  const explicit = corpusFingerprint(loadCorpus(dir));
  expect(explicit).toBe(omitted);
});

test("changing an input file's bytes changes the corpus fingerprint", () => {
  const dir = copiedCorpus(FIXTURE_CORPUS);
  const before = corpusFingerprint(loadCorpus(dir));
  writeFileSync(path.join(dir, "spoken-note", "input.txt"), "a different note\n");
  const after = corpusFingerprint(loadCorpus(dir));

  expect(after).not.toBe(before);
});

test("a cosmetic rewrite of an input file's JSON case keys leaves the corpus fingerprint unchanged", () => {
  const dir = copiedCorpus(FIXTURE_CORPUS);
  const before = corpusFingerprint(loadCorpus(dir));
  rewriteCosmetically(path.join(dir, "spoken-note", "case.json"));
  const after = corpusFingerprint(loadCorpus(dir));

  expect(after).toBe(before);
});

test("case, input and default edits count while capture and unrelated manifest metadata do not", () => {
  const dir = copiedCorpus(FIXTURE_CORPUS);
  const base = corpusFingerprint(loadCorpus(dir));

  // The capture metadata beside a document's bytes describes the capture,
  // not the question: neither field moves the fingerprint.
  editJson(path.join(dir, "service-sheet", "case.json"), (document) => {
    const inputs = document["inputs"] as { capture?: { capturedAt: string; pageCount: number } }[];
    inputs[0]!.capture!.capturedAt = "2030-01-01T00:00:00Z";
    inputs[0]!.capture!.pageCount = 9;
  });
  expect(corpusFingerprint(loadCorpus(dir))).toBe(base);

  // Neither does any manifest field the fingerprint does not name — the
  // schema, the prompt and the free-text description are all excluded.
  editJson(path.join(dir, "manifest.json"), (document) => {
    document["description"] = "A reader-facing note nothing reads.";
  });
  expect(corpusFingerprint(loadCorpus(dir))).toBe(base);

  // A case's answers and its defaults are its questions: either edit moves
  // the fingerprint.
  editJson(path.join(dir, "spoken-note", "case.json"), (document) => {
    document["defaults"] = [{ scope: "frame", status: "declared-absent" }];
  });
  expect(corpusFingerprint(loadCorpus(dir))).not.toBe(base);
});

// ---------------------------------------------------------------------------
// Proposal provenance and review state (ADR 0049) — no chat, no transcription:
// the fingerprint is a hash over the loaded corpus, so these load and hash
// directly.
// ---------------------------------------------------------------------------

/** Stamp a pending asserted proposal onto the fixture's `frame.material` entry. */
const proposeMaterial = (
  dir: string,
  proposalBlock: Record<string, unknown>,
  review: string,
): void => {
  editJson(path.join(dir, "spoken-note", "case.json"), (document) => {
    const expected = document["expected"] as Record<string, Record<string, unknown>>;
    expected["frame.material"] = {
      ...expected["frame.material"]!,
      proposal: proposalBlock,
      review,
    };
  });
};

/** The proposal block the provenance suites stamp, at the given model. */
const proposalBlock = (model: string): Record<string, unknown> => ({
  status: "asserted",
  value: "steel",
  evidence: { quote: "steel frame", input: "input.txt" },
  backend: "http",
  model,
  proposedAt: "2026-01-01T00:00:00Z",
});

test("flipping an entry's review state moves the corpus fingerprint", () => {
  const dir = copiedCorpus(FIXTURE_CORPUS);
  proposeMaterial(dir, proposalBlock("proposer-1"), "pending");
  const pending = corpusFingerprint(loadCorpus(dir));

  editJson(path.join(dir, "spoken-note", "case.json"), (document) => {
    const expected = document["expected"] as Record<string, { review: string }>;
    expected["frame.material"]!.review = "confirmed";
  });
  const confirmed = corpusFingerprint(loadCorpus(dir));

  expect(confirmed).not.toBe(pending);
});

test("changing the proposer's model moves the corpus fingerprint", () => {
  const dir = copiedCorpus(FIXTURE_CORPUS);
  proposeMaterial(dir, proposalBlock("proposer-1"), "confirmed");
  const first = corpusFingerprint(loadCorpus(dir));

  proposeMaterial(dir, proposalBlock("proposer-2"), "confirmed");
  const second = corpusFingerprint(loadCorpus(dir));

  expect(second).not.toBe(first);
});

test("a proposal-free corpus hashes to its pre-proposal value", () => {
  const dir = copiedCorpus(FIXTURE_CORPUS);
  // Pinned: the format's proposal and review members are additive, and a
  // corpus without them fingerprints exactly as it did before they existed.
  expect(corpusFingerprint(loadCorpus(dir))).toBe(
    "62c8b2d193562af597d5668d5e1b7414072f3ae26190b1dcc47241f30369d3f2",
  );
});
