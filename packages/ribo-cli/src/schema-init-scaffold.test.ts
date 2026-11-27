/**
 * @file Schema-init corpus scaffolds: exact source bytes and metadata, with
 * all-or-nothing publication through the shared operator output port.
 */
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, test } from "vitest";

import { loadCorpus } from "./corpus.js";
import { caseTextOf, joinCaseInputTexts } from "./eval/case-text.js";
import { documentTextKey } from "./eval/documents.js";
import { OperatorError } from "./operator/error.js";
import type { OperatorDirectoryFileSystem } from "./operator/output.js";
import { defaultOperatorDirectoryFileSystem } from "./operator/output.js";
import { serializeSchemaInitDocument, writeSchemaInitCorpus } from "./schema-init/scaffold.js";
import type { SchemaInitSample, SchemaInitSampleInput } from "./schema-init/samples.js";

const document = {
  type: "object" as const,
  description: "A drafted audit.",
  properties: {
    address: { type: "string" as const, description: "The street address." },
  },
  required: ["address"],
  additionalProperties: false as const,
};

const textBytes = new TextEncoder().encode("Address: 1 Main Street\n");
const pdfBytes = new Uint8Array([37, 80, 68, 70, 45, 1, 7, 10, 0, 255]);
const capture = {
  id: "service-sheet",
  kind: "document" as const,
  mimeType: "application/pdf",
  ctx: {},
  capturedAt: "2026-02-11T08:15:00Z",
  pageCount: 7,
};
const input = (
  name: string,
  file: string,
  kind: SchemaInitSampleInput["kind"],
  text: string,
  bytes: Uint8Array,
  withCapture?: typeof capture,
) => ({
  path: `/inputs/${name}/${file}`,
  file,
  kind,
  text,
  bytes,
  ...(withCapture === undefined ? {} : { capture: withCapture }),
});
const samples: readonly SchemaInitSample[] = [
  {
    name: "field-notes",
    inputs: [
      input(
        "field-notes",
        "field-notes.txt",
        "text",
        new TextDecoder().decode(textBytes),
        textBytes,
      ),
    ],
    text: "",
  },
  {
    name: "service-sheet",
    inputs: [input("service-sheet", "input.pdf", "document", "Chain replaced", pdfBytes, capture)],
    text: "",
  },
].map((sample) => ({ ...sample, text: joinCaseInputTexts(sample.inputs) }));

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "ribo-schema-init-scaffold-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const corpusPath = (): string => join(directory, "draft-corpus");

async function assertNoStaging(): Promise<void> {
  expect((await readdir(directory)).filter((name) => name.includes(".ribo-"))).toEqual([]);
}

test("a scaffold is loadCorpus-compatible and preserves the exact schema, inputs and capture metadata", async () => {
  const artifact = serializeSchemaInitDocument(document);
  const destination = corpusPath();

  const result = await writeSchemaInitCorpus(destination, artifact, samples, {
    name: "Operator named corpus",
    provenance: "real",
  });

  expect(result).toEqual({ destination: "directory", path: destination });
  expect(await readFile(join(destination, "schema.json"), "utf8")).toBe(artifact);
  expect(Buffer.from(await readFile(join(destination, "field-notes", "field-notes.txt")))).toEqual(
    Buffer.from(textBytes),
  );
  expect(Buffer.from(await readFile(join(destination, "service-sheet", "input.pdf")))).toEqual(
    Buffer.from(pdfBytes),
  );
  expect(JSON.parse(await readFile(join(destination, "manifest.json"), "utf8"))).toEqual({
    name: "Operator named corpus",
    schema: "schema.json",
    provenance: "real",
    prompt: { instructions: "" },
  });
  expect(
    JSON.parse(await readFile(join(destination, "service-sheet", "case.json"), "utf8")),
  ).toEqual({
    id: "service-sheet",
    inputs: [
      {
        file: "input.pdf",
        kind: "document",
        capture: { capturedAt: "2026-02-11T08:15:00Z", pageCount: 7 },
      },
    ],
    expected: {},
  });

  const loaded = loadCorpus(destination);
  expect(loaded.manifest.name).toBe("Operator named corpus");
  expect(loaded.manifest.provenance).toBe("real");
  expect(loaded.manifest.prompt).toEqual({ instructions: "" });
  expect(loaded.cases.map((entry) => entry.id)).toEqual(["field-notes", "service-sheet"]);
  expect(loaded.cases.every((entry) => Object.keys(entry.expected).length === 0)).toBe(true);
  expect(loaded.cases.every((entry) => entry.defaults === undefined)).toBe(true);
  expect(loaded.cases[0]?.inputs).toEqual([
    { kind: "text", file: "field-notes.txt", text: samples[0]?.inputs[0]?.text },
  ]);
  expect(loaded.cases[1]?.inputs[0]).toMatchObject({
    kind: "document",
    file: "input.pdf",
    capture: { capturedAt: "2026-02-11T08:15:00Z", pageCount: 7 },
  });
});

test("an existing file or directory is refused unchanged and leaves no staging directory", async () => {
  const artifact = serializeSchemaInitDocument(document);
  const existingFile = join(directory, "existing-file");
  await writeFile(existingFile, "keep me");
  await expect(
    writeSchemaInitCorpus(existingFile, artifact, samples, {
      name: "refused",
      provenance: "synthetic",
    }),
  ).rejects.toThrow(/already exists/u);
  expect(await readFile(existingFile, "utf8")).toBe("keep me");

  const existingDirectory = join(directory, "existing-directory");
  await defaultOperatorDirectoryFileSystem.mkdir(existingDirectory);
  await writeFile(join(existingDirectory, "keep.txt"), "also keep me");
  await expect(
    writeSchemaInitCorpus(existingDirectory, artifact, samples, {
      name: "refused",
      provenance: "synthetic",
    }),
  ).rejects.toBeInstanceOf(OperatorError);
  expect(await readFile(join(existingDirectory, "keep.txt"), "utf8")).toBe("also keep me");
  await assertNoStaging();
});

test("a non-empty destination created at rename wins the race and the staged scaffold is removed", async () => {
  const artifact = serializeSchemaInitDocument(document);
  const destination = corpusPath();
  const fs: OperatorDirectoryFileSystem = {
    ...defaultOperatorDirectoryFileSystem,
    rename: async (source, target) => {
      await defaultOperatorDirectoryFileSystem.mkdir(target);
      await writeFile(join(target, "raced.txt"), "another writer owns this");
      await rename(source, target);
    },
  };

  await expect(
    writeSchemaInitCorpus(
      destination,
      artifact,
      samples,
      { name: "raced", provenance: "synthetic" },
      { fs },
    ),
  ).rejects.toThrow(/already exists|not empty/u);
  expect(await readFile(join(destination, "raced.txt"), "utf8")).toBe("another writer owns this");
  expect(await readdir(destination)).toEqual(["raced.txt"]);
  await assertNoStaging();
});

test("a write fault midway through the scaffold leaves no destination or staging survivor", async () => {
  const artifact = serializeSchemaInitDocument(document);
  const destination = corpusPath();
  const fs: OperatorDirectoryFileSystem = {
    ...defaultOperatorDirectoryFileSystem,
    writeFile: async (path, contents) => {
      await defaultOperatorDirectoryFileSystem.writeFile(path, contents);
      if (path.endsWith("input.pdf")) throw new Error("injected mid-scaffold write failure");
    },
  };

  await expect(
    writeSchemaInitCorpus(
      destination,
      artifact,
      samples,
      { name: "failed", provenance: "synthetic" },
      { fs },
    ),
  ).rejects.toThrow("injected mid-scaffold write failure");
  await expect(readFile(destination)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readdir(directory)).toEqual([]);
});

test("a collision while staging is not reported as an existing destination", async () => {
  const artifact = serializeSchemaInitDocument(document);
  const destination = corpusPath();
  const fs: OperatorDirectoryFileSystem = {
    ...defaultOperatorDirectoryFileSystem,
    writeFile: async (path, contents) => {
      if (path.endsWith("case.json")) {
        throw Object.assign(new Error("EEXIST: file already exists"), { code: "EEXIST" });
      }
      await defaultOperatorDirectoryFileSystem.writeFile(path, contents);
    },
  };

  const failure = await writeSchemaInitCorpus(
    destination,
    artifact,
    samples,
    { name: "collided", provenance: "synthetic" },
    { fs },
  ).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain("could not write the directory artifact");
  expect((failure as Error).message).not.toContain("already exists — refusing to overwrite");
  await expect(readFile(destination)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readdir(directory)).toEqual([]);
});

test("a multi-input scaffold round-trips through loadCorpus with caseTextOf equal to the sample text", async () => {
  const transcriptBytes = new TextEncoder().encode("The boiler chain was replaced.\n");
  const noteBytes = new TextEncoder().encode("No additional observations.\n");
  const documentText = "Chain replaced";
  const multiInputs = [
    input("spoken-case", "input.pdf", "document", documentText, pdfBytes, capture),
    input(
      "spoken-case",
      "spoken.txt",
      "transcript",
      new TextDecoder().decode(transcriptBytes),
      transcriptBytes,
    ),
    input("spoken-case", "note.txt", "text", new TextDecoder().decode(noteBytes), noteBytes),
  ];
  const multi: SchemaInitSample = {
    name: "spoken-case",
    inputs: multiInputs,
    text: joinCaseInputTexts(multiInputs),
  };
  const destination = join(directory, "multi-corpus");

  const result = await writeSchemaInitCorpus(
    destination,
    serializeSchemaInitDocument(document),
    [multi],
    {
      name: "Multi corpus",
      provenance: "real",
    },
  );

  expect(result).toEqual({ destination: "directory", path: destination });
  const loaded = loadCorpus(destination);
  const entry = loaded.cases.find((candidate) => candidate.id === "spoken-case");
  expect(entry).toBeDefined();
  // Every input is written in declared order, each document with its own
  // capture block.
  expect(
    entry?.inputs.map((candidate) => ({ file: candidate.file, kind: candidate.kind })),
  ).toEqual([
    { file: "input.pdf", kind: "document" },
    { file: "spoken.txt", kind: "transcript" },
    { file: "note.txt", kind: "text" },
  ]);
  expect(
    Buffer.from(await readFile(join(destination, "spoken-case", "spoken.txt"))).equals(
      transcriptBytes,
    ),
  ).toBe(true);
  if (entry === undefined) return;
  // The case's eval text is byte-identical to the sample text the draft read:
  // the one join implementation, markers on, declared order.
  const documents = new Map(
    multi.inputs
      .filter((candidate) => candidate.kind === "document")
      .map((candidate) => [documentTextKey(multi.name, candidate.file), candidate.text] as const),
  );
  expect(caseTextOf(loaded, entry, documents)).toBe(multi.text);
});
