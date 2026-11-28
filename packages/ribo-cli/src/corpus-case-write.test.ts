/**
 * The guarded case writer's tests: a write changes only `expected`, survives
 * its faults, and leaves a file the loader still accepts (T5 acceptance).
 *
 * The real filesystem carries every test except the injected rename fault,
 * which needs a fault the real fs cannot be told to raise on demand. No test
 * makes a model call and none reads a schema document — the writer has no
 * surface for either.
 */
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, test } from "vitest";

import { nodeCaseWriteFs, writeCaseExpected } from "./corpus/case-write.js";
import type { CaseWriteFs, ExpectedEdit } from "./corpus/case-write.js";
import { CorpusError } from "./corpus/error.js";
import { loadCorpus } from "./corpus/loader.js";

/** The committed fixture corpus, for the load-through test. */
const FIXTURE = fileURLToPath(new URL("./fixtures/corpus", import.meta.url));

/** The temp directories this suite created, so each test cleans up after itself. */
const temporaries: string[] = [];

/** A fresh temp directory, cleaned up after the test. */
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  temporaries.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of temporaries.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The serialisation the schema-init scaffold writes: two-space JSON, trailing newline. */
const canonical = (document: unknown): string => `${JSON.stringify(document, null, 2)}\n`;

/** A minimal valid case document, in the scaffold's serialisation. */
const writeCaseFile = (dir: string, document: Record<string, unknown>): string => {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "case.json");
  writeFileSync(file, canonical(document));
  return file;
};

/** The case document this suite edits: one text input, one expected entry. */
const simpleCase = (): Record<string, unknown> => ({
  id: "note-case",
  inputs: [{ file: "input.txt", kind: "text" }],
  expected: {
    note: { status: "asserted", value: "pump the bike", sourceSpan: "pump the bike" },
  },
});

/** The edit that proposes one new leaf, the way the add-only mode is meant to be driven. */
const addAuthor: ExpectedEdit = (expected) => ({
  ...expected,
  author: { status: "asserted", value: "Robin" },
});

// ---------------------------------------------------------------------------
// Add-only mode
// ---------------------------------------------------------------------------

test("add-only adds a new leaf after the existing ones, in the caller's order", () => {
  const file = writeCaseFile(tempDir("ribo-case-write-"), simpleCase());

  writeCaseExpected(file, addAuthor, { addOnly: true });

  const written = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  expect(Object.keys(written.expected as Record<string, unknown>)).toEqual(["note", "author"]);
});

test("add-only refuses an edit that would change an existing entry, and the file is untouched", () => {
  const file = writeCaseFile(tempDir("ribo-case-write-"), simpleCase());
  const before = readFileSync(file, "utf8");

  expect(() =>
    writeCaseExpected(
      file,
      (expected) => ({ ...expected, note: { status: "asserted", value: "something else" } }),
      { addOnly: true },
    ),
  ).toThrow(CorpusError);

  expect(readFileSync(file, "utf8")).toBe(before);
});

test("add-only refuses an edit that would drop an existing entry", () => {
  const file = writeCaseFile(tempDir("ribo-case-write-"), simpleCase());
  const before = readFileSync(file, "utf8");

  expect(() =>
    writeCaseExpected(file, () => ({ author: { status: "asserted", value: "Robin" } }), {
      addOnly: true,
    }),
  ).toThrow(CorpusError);

  expect(readFileSync(file, "utf8")).toBe(before);
});

// ---------------------------------------------------------------------------
// Everything outside `expected` survives
// ---------------------------------------------------------------------------

test("inputs, capture blocks and defaults survive with their values and key order", () => {
  const document: Record<string, unknown> = {
    id: "sheet-case",
    inputs: [
      {
        file: "input.pdf",
        kind: "document",
        capture: { capturedAt: "2026-02-11T08:15:00Z", pageCount: 1 },
      },
      { file: "notes.txt", kind: "text" },
    ],
    expected: {
      "service.notes": { status: "asserted", value: "chain replaced" },
    },
    defaults: [{ scope: "frame", status: "declared-absent" }],
  };
  const file = writeCaseFile(tempDir("ribo-case-write-"), document);

  writeCaseExpected(
    file,
    (expected) => ({ ...expected, "service.date": { status: "asserted", value: "2026-02-11" } }),
    { addOnly: true },
  );

  const written = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  expect(Object.keys(written)).toEqual(Object.keys(document));
  expect(written.id).toBe(document.id);
  expect(written.inputs).toEqual(document.inputs);
  expect(written.defaults).toEqual(document.defaults);
});

test("a case file already in the scaffold's format is byte-identical outside expected", () => {
  const file = writeCaseFile(tempDir("ribo-case-write-"), simpleCase());
  const before = readFileSync(file, "utf8");
  // The precondition the byte comparison rests on: the file is already in the
  // serialisation the writer uses, so a parse-and-rewrite is the identity.
  expect(canonical(JSON.parse(before))).toBe(before);

  writeCaseExpected(file, addAuthor, { addOnly: true });

  const after = readFileSync(file, "utf8");
  const withoutExpected = (text: string): string => {
    const document = JSON.parse(text) as Record<string, unknown>;
    delete document.expected;
    return canonical(document);
  };
  expect(withoutExpected(after)).toBe(withoutExpected(before));
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

test("an edit producing an invalid case is refused with the file untouched and no temp file", () => {
  const dir = tempDir("ribo-case-write-");
  const file = writeCaseFile(dir, simpleCase());
  const before = readFileSync(file, "utf8");

  expect(() => writeCaseExpected(file, () => ({ note: { status: "perhaps" } }))).toThrow(
    CorpusError,
  );

  expect(readFileSync(file, "utf8")).toBe(before);
  expect(readdirSync(dir)).toEqual(["case.json"]);
});

test("an unreadable or non-object case file is refused by name", () => {
  const dir = tempDir("ribo-case-write-");
  const file = path.join(dir, "case.json");
  writeFileSync(file, "not json at all");
  expect(() => writeCaseExpected(file, addAuthor)).toThrow(CorpusError);
  writeFileSync(file, canonical(["a", "b"]));
  expect(() => writeCaseExpected(file, addAuthor)).toThrow(CorpusError);
});

// ---------------------------------------------------------------------------
// Faults
// ---------------------------------------------------------------------------

/** A fake fs that records its calls and can refuse a rename, for the fault test. */
class FaultFs implements CaseWriteFs {
  readonly files = new Map<string, string>();
  readonly unlinked: string[] = [];

  readFile(file: string): string {
    const contents = this.files.get(file);
    if (contents === undefined) throw new Error(`ENOENT: no such file, ${file}`);
    return contents;
  }

  writeFile(file: string, data: string): void {
    this.files.set(file, data);
  }

  rename(): void {
    throw new Error("EACCES: rename refused by the injected fault");
  }

  unlink(file: string): void {
    this.unlinked.push(file);
    this.files.delete(file);
  }
}

test("an injected rename fault leaves the original bytes and no stray file", () => {
  const fs = new FaultFs();
  const file = "/corpus/note-case/case.json";
  const before = canonical(simpleCase());
  fs.files.set(file, before);

  expect(() => writeCaseExpected(file, addAuthor, { fs })).toThrow(CorpusError);

  expect(fs.files.get(file)).toBe(before);
  expect([...fs.files.keys()].filter((name) => name.endsWith(".tmp"))).toEqual([]);
  expect(fs.unlinked).toEqual([`${file}.tmp`]);
});

// ---------------------------------------------------------------------------
// The written corpus loads
// ---------------------------------------------------------------------------

test("a corpus written this way loads through loadCorpus, with both entries", () => {
  const dir = tempDir("ribo-case-write-corpus-");
  cpSync(FIXTURE, dir, { recursive: true });
  const caseFile = path.join(dir, "service-sheet", "case.json");

  writeCaseExpected(
    caseFile,
    (expected) => ({ ...expected, "service.date": { status: "asserted", value: "2026-02-11" } }),
    { addOnly: true },
  );

  const corpus = loadCorpus(dir);
  const serviceSheet = corpus.cases.find((entry) => entry.id === "service-sheet");
  expect(serviceSheet).toBeDefined();
  expect(Object.keys(serviceSheet?.expected ?? {})).toEqual(["service.notes", "service.date"]);
  expect(nodeCaseWriteFs).toBeDefined();
});
