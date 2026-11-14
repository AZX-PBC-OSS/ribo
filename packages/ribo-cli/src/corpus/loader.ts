/**
 * @file The corpus loader: a corpus directory in, a validated corpus out.
 *
 * The loader is the only way a corpus enters this package. It reads the
 * manifest, converts the corpus's schema document through the SAME loader the
 * `ribo schema inspect` command uses (`convertDocument`, per ADR 0038), takes
 * the leaf paths from the ONE field walk the report uses
 * (`walkFieldInventory`), takes the group keys from core's own classifier
 * (`topLevelKeyKinds`), and validates every case against those.
 *
 * Nothing here is derived twice: the leaf vocabulary the loader refuses
 * against is the inventory's, and the refusal's message lists exactly the
 * inventory's paths.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { baseDocumentCaptureSchema, topLevelKeyKinds } from "@azx/ribo-core";
import type { DocumentCapture, LeafInventoryEntry } from "@azx/ribo-core";
import type { z } from "zod";

import { convertDocument } from "../inspect/convert.js";
import { walkFieldInventory } from "../inspect/field-inventory.js";
import { CorpusCaseSchema } from "./case.js";
import type { CorpusCase, CorpusCaseKind } from "./case.js";
import { CorpusError } from "./error.js";
import { scopeCovers } from "./expectations.js";
import { describeIssues } from "./issues.js";
import { CorpusManifestSchema } from "./manifest.js";
import type { CorpusManifest } from "./manifest.js";

/**
 * A loaded corpus: the manifest, the schema it names, the leaf paths and
 * group keys that schema declares, and the cases.
 * @category Eval
 */
export interface LoadedCorpus {
  /** The corpus root's absolute path. */
  readonly root: string;
  /** The parsed manifest. */
  readonly manifest: CorpusManifest;
  /** The schema document as it was loaded — the run fingerprint hashes this. */
  readonly schemaDocument: unknown;
  /** The converted schema. */
  readonly schema: z.ZodObject;
  /** The schema's leaves, as the one field inventory reports them. */
  readonly leafInventory: readonly LeafInventoryEntry[];
  /** The schema's group keys, as core's own classifier reports them. */
  readonly groupKeys: readonly string[];
  /** The cases, sorted by case id. */
  readonly cases: readonly LoadedCase[];
}

/**
 * A loaded case: its id, its kind, its input and its expectations.
 * @category Eval
 */
export interface LoadedCase {
  /** The case's id — the directory's name. */
  readonly id: string;
  /** The case's input kind. */
  readonly kind: CorpusCaseKind;
  /** The case directory's absolute path. */
  readonly dir: string;
  /** The case file's absolute path. */
  readonly caseFile: string;
  /** The case's input, loaded. */
  readonly input: LoadedCaseInput;
  /** The expected answer, as the case file declares it. */
  readonly expected: CorpusCase["expected"];
  /** The scoped defaults, with their scopes normalized to read-only arrays. */
  readonly defaults: CorpusCase["defaults"];
}

/**
 * A loaded case's input: the text of a transcript or text case, or a
 * document's capture record beside its bytes.
 *
 * The bytes travel separately from the record, the way core's
 * `Transcriber.transcribe(item, bytes)` seam takes them.
 * @category Eval
 */
export type LoadedCaseInput =
  | {
      readonly kind: "transcript" | "text";
      /** The input file's exact utf8 contents, verbatim. */
      readonly text: string;
    }
  | {
      readonly kind: "document";
      /** The capture record the case declares, assembled and parsed. */
      readonly capture: DocumentCapture;
      /** The input file's bytes. */
      readonly bytes: Uint8Array;
    };

/** The input file each kind names — the kind is stated once, in the case file. */
const INPUT_FILE_NAMES: Record<CorpusCaseKind, string> = {
  transcript: "input.txt",
  text: "input.txt",
  document: "input.pdf",
};

/** The message out of a thrown fault — a non-Error sentinel must not read "undefined". */
const faultMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Is this path a file? A missing path and an unreadable one both answer false. */
const isFile = (file: string): boolean => {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
};

/** Does this path exist at all — as a file, a directory or anything else? */
const exists = (target: string): boolean => {
  try {
    statSync(target);
    return true;
  } catch {
    return false;
  }
};

/** Is this path a directory? A missing path and an unreadable one both answer false. */
const isDirectory = (dir: string): boolean => {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
};

/** Read a file's bytes, refusing an unreadable one by name. */
const readBytes = (file: string, what: string): Buffer => {
  try {
    return readFileSync(file);
  } catch (error) {
    throw new CorpusError(`${what} could not be read: ${faultMessage(error)}`);
  }
};

/** Read and parse a JSON file, refusing a malformed one by name. */
const readJson = (file: string, what: string): unknown => {
  const bytes = readBytes(file, what);
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new CorpusError(`${what} is not valid JSON: ${faultMessage(error)}`);
  }
};

/** Parse a document against a zod schema, refusing a malformed one by name. */
const parseWith = <T>(schema: z.ZodType<T>, document: unknown, what: string): T => {
  const result = schema.safeParse(document);
  if (!result.success) {
    throw new CorpusError(`${what} is invalid: ${describeIssues(result.error.issues)}`);
  }
  return result.data;
};

/** The leaf paths of a schema, as the one field inventory reports them. */
const leafPathsOf = (inventory: readonly LeafInventoryEntry[]): Set<string> =>
  new Set(inventory.map((entry) => entry.path));

/** The group keys of a schema, as core's own classifier reports them. */
const groupKeysOf = (schema: z.ZodObject): string[] => {
  const kinds = topLevelKeyKinds(schema);
  if (kinds.form !== "keys") return [];
  return kinds.keys.filter((key) => key.kind === "group").map((key) => key.key);
};

/** Resolve the manifest's schema reference against the corpus root. */
const resolveSchemaPath = (root: string, reference: string): string => {
  if (path.isAbsolute(reference)) {
    throw new CorpusError(
      `the corpus manifest's schema reference "${reference}" is an absolute path — the schema ` +
        `reference is relative to the corpus root (fix: write it as a path relative to the corpus root)`,
    );
  }
  return path.resolve(root, reference);
};

/** Read the corpus's schema document and convert it, refusing either failure. */
const loadSchema = (
  root: string,
  reference: string,
): { readonly document: unknown; readonly schema: z.ZodObject } => {
  const schemaPath = resolveSchemaPath(root, reference);
  let stats;
  try {
    stats = statSync(schemaPath);
  } catch {
    throw new CorpusError(
      `the corpus manifest's schema reference "${reference}" does not resolve to a file — the ` +
        `resolved path "${schemaPath}" does not exist (fix: point "schema" at a JSON Schema ` +
        `document in OpenAPI 3.0 form, relative to the corpus root)`,
    );
  }
  if (!stats.isFile()) {
    throw new CorpusError(
      `the corpus manifest's schema reference "${reference}" does not resolve to a file — the ` +
        `resolved path "${schemaPath}" is not a file (fix: point "schema" at a JSON Schema ` +
        `document in OpenAPI 3.0 form, relative to the corpus root)`,
    );
  }
  const document = readJson(
    schemaPath,
    `the corpus's schema document "${reference}" (at "${schemaPath}")`,
  );
  try {
    return { document, schema: convertDocument(document) };
  } catch (error) {
    throw new CorpusError(
      `the corpus's schema document "${reference}" was refused: ${faultMessage(error)}`,
    );
  }
};

/** Refuse a `groupInstructions` key that names no group of the corpus's schema. */
const checkGroupInstructions = (manifest: CorpusManifest, groupKeys: readonly string[]): void => {
  const declared = Object.keys(manifest.prompt.groupInstructions ?? {});
  const unknown = declared.filter((key) => !groupKeys.includes(key));
  if (unknown.length === 0) return;
  const valid = groupKeys.length === 0 ? "none" : groupKeys.join(", ");
  throw new CorpusError(
    `the corpus manifest's groupInstructions names "${unknown.join('", "')}", which names no ` +
      `group of the corpus's schema — the valid group keys are: ${valid} (fix: name a group of ` +
      `the schema, or drop the entry)`,
  );
};

/** Refuse an expected leaf path the schema does not declare. */
const checkExpectedLeaves = (
  caseFile: CorpusCase,
  caseFilePath: string,
  leafPaths: ReadonlySet<string>,
): void => {
  for (const leafPath of Object.keys(caseFile.expected)) {
    if (leafPaths.has(leafPath)) continue;
    throw new CorpusError(
      `the corpus case file "${caseFilePath}" expects leaf "${leafPath}", which is not a leaf of ` +
        `the corpus's schema — the valid leaf paths are: ${[...leafPaths].join(", ")} (fix: use ` +
        `one of those paths, or check the corpus's schema)`,
    );
  }
};

/** Refuse a default whose scope covers no leaf, or names the same scope twice. */
const checkDefaults = (
  caseFile: CorpusCase,
  caseFilePath: string,
  leafPaths: ReadonlySet<string>,
): void => {
  const seen = new Set<string>();
  for (const entry of caseFile.defaults ?? []) {
    for (const scope of entry.scope) {
      if (seen.has(scope)) {
        throw new CorpusError(
          `the corpus case file "${caseFilePath}" declares the scope "${scope}" in two defaults — ` +
            `each scope string may appear once per case (fix: merge the two defaults)`,
        );
      }
      seen.add(scope);
      const covered = [...leafPaths].some((leafPath) => scopeCovers(scope, leafPath));
      if (!covered) {
        throw new CorpusError(
          `the corpus case file "${caseFilePath}" declares a default scoped to "${scope}", which ` +
            `covers no leaf of the corpus's schema — the valid leaf paths are: ` +
            `${[...leafPaths].join(", ")} (fix: scope the default to a leaf path, or to a path ` +
            `prefix of one)`,
        );
      }
    }
  }
};

/** Load one case's input file, refusing a missing one and a stray one. */
const loadCaseInput = (
  caseDir: string,
  caseId: string,
  kind: CorpusCaseKind,
  captureBlock: CorpusCase["capture"],
): LoadedCaseInput => {
  const expectedName = INPUT_FILE_NAMES[kind];
  const strayName = kind === "document" ? "input.txt" : "input.pdf";
  const strayPath = path.join(caseDir, strayName);
  if (isFile(strayPath)) {
    throw new CorpusError(
      `the corpus case "${caseId}" declares kind "${kind}", so its input file is ${expectedName}, ` +
        `but the case directory also holds "${strayPath}" — exactly one input file per case, named ` +
        `after the kind (fix: remove the stray file)`,
    );
  }
  const inputPath = path.join(caseDir, expectedName);
  if (!exists(inputPath)) {
    throw new CorpusError(
      `the corpus case "${caseId}" declares kind "${kind}", so its input file is "${inputPath}" — ` +
        `that file does not exist (fix: create it)`,
    );
  }
  if (!isFile(inputPath)) {
    throw new CorpusError(
      `the corpus case "${caseId}" declares kind "${kind}", so its input file is "${inputPath}" — ` +
        `that path is not a file (fix: make it the case's input file)`,
    );
  }
  const bytes = readBytes(inputPath, `the corpus case "${caseId}"'s input file "${inputPath}"`);
  if (kind !== "document") {
    return { kind, text: bytes.toString("utf8") };
  }
  if (captureBlock === undefined) {
    throw new CorpusError(
      `the corpus case "${caseId}" declares kind "document" but no capture block — the corpus ` +
        `declares what was captured (fix: declare "capturedAt" and "pageCount" in the case file)`,
    );
  }
  const capture: DocumentCapture = baseDocumentCaptureSchema.parse({
    id: caseId,
    kind: "document",
    mimeType: "application/pdf",
    ctx: {},
    capturedAt: captureBlock.capturedAt,
    pageCount: captureBlock.pageCount,
  });
  return { kind: "document", capture, bytes: new Uint8Array(bytes) };
};

/** Load one case directory. */
const loadCase = (root: string, dirName: string, leafPaths: ReadonlySet<string>): LoadedCase => {
  const caseDir = path.join(root, dirName);
  const caseFilePath = path.join(caseDir, "case.json");
  if (!isFile(caseFilePath)) {
    throw new CorpusError(
      `the corpus subdirectory "${caseDir}" holds no case.json — every immediate subdirectory of ` +
        `the corpus root is a case (fix: add a case.json to it, or remove the directory)`,
    );
  }
  const document = readJson(caseFilePath, `the corpus case file "${caseFilePath}"`);
  const caseFile = parseWith(CorpusCaseSchema, document, `the corpus case file "${caseFilePath}"`);
  if (caseFile.id !== dirName) {
    throw new CorpusError(
      `the corpus case file "${caseFilePath}" declares id "${caseFile.id}", but its directory is ` +
        `named "${dirName}" — the case id must equal the directory name (fix: rename one to match ` +
        `the other)`,
    );
  }
  checkExpectedLeaves(caseFile, caseFilePath, leafPaths);
  checkDefaults(caseFile, caseFilePath, leafPaths);
  const input = loadCaseInput(caseDir, caseFile.id, caseFile.kind, caseFile.capture);
  return {
    id: caseFile.id,
    kind: caseFile.kind,
    dir: caseDir,
    caseFile: caseFilePath,
    input,
    expected: caseFile.expected,
    defaults: caseFile.defaults,
  };
};

/**
 * Load a corpus directory: read its manifest, convert its schema, and load
 * every case it holds.
 *
 * The corpus directory is an argument, never `process.cwd()` and never argv,
 * so a caller (the Snugg migration, the runner) can load any corpus from any
 * path.
 *
 * Every refusal raises `CorpusError` — the could-not-run class the bin maps to
 * exit 2 — and every message names the file, the offending item and the fix.
 * @param corpusDir - The corpus root directory.
 * @returns The loaded corpus, with its cases sorted by case id.
 * @throws {@link CorpusError} when the corpus cannot be loaded.
 * @category Eval
 */
export function loadCorpus(corpusDir: string): LoadedCorpus {
  const root = path.resolve(corpusDir);
  if (!isDirectory(root)) {
    throw new CorpusError(
      `the corpus root "${root}" is not a readable directory (fix: point the corpus loader at a ` +
        `corpus directory)`,
    );
  }
  const manifestPath = path.join(root, "manifest.json");
  const manifestDocument = readJson(manifestPath, `the corpus manifest "${manifestPath}"`);
  const manifest = parseWith(
    CorpusManifestSchema,
    manifestDocument,
    `the corpus manifest "${manifestPath}"`,
  );
  const { document, schema } = loadSchema(root, manifest.schema);
  let inventory: readonly LeafInventoryEntry[];
  try {
    inventory = walkFieldInventory(schema);
  } catch (error) {
    throw new CorpusError(
      `the corpus's schema document "${manifest.schema}" could not be walked: ${faultMessage(error)}`,
    );
  }
  const groupKeys = groupKeysOf(schema);
  checkGroupInstructions(manifest, groupKeys);
  const leafPaths = leafPathsOf(inventory);
  const entries = readdirSync(root, { withFileTypes: true });
  const dirNames = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
  if (dirNames.length === 0) {
    throw new CorpusError(
      `the corpus root "${root}" holds no case directories — a corpus is a directory of cases ` +
        `(fix: add at least one case directory, each holding a case.json and its input file)`,
    );
  }
  const cases = dirNames.map((dirName) => loadCase(root, dirName, leafPaths));
  cases.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return {
    root,
    manifest,
    schemaDocument: document,
    schema,
    leafInventory: inventory,
    groupKeys,
    cases,
  };
}
