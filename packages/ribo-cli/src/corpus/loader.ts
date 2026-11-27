/**
 * @file The corpus loader: a corpus directory in, a validated corpus out.
 *
 * The loader is the only way a corpus enters this package. It reads the
 * manifest, converts the corpus's schema document through the SAME loader the
 * `ribo schema inspect` command uses (`convertDocument`, per ADR 0038), takes
 * unwraps recognised envelopes through the SAME field-level walk the report
 * uses (`unwrapFieldEnvelopes`), takes the leaf paths from its ONE field walk
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
import { unwrapFieldEnvelopes, walkFieldInventory } from "../inspect/field-inventory.js";
import { CorpusCaseSchema } from "./case.js";
import type { CorpusCase, CorpusCaseInput, ProposalEvidence } from "./case.js";
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
  /** The converted field-level schema, with any loaded envelopes unwrapped once. */
  readonly schema: z.ZodObject;
  /** The schema's leaves, as the one field inventory reports them. */
  readonly leafInventory: readonly LeafInventoryEntry[];
  /** The schema's group keys, as core's own classifier reports them. */
  readonly groupKeys: readonly string[];
  /** The cases, sorted by case id. */
  readonly cases: readonly LoadedCase[];
}

/**
 * A loaded case: its id, its ordered loaded inputs and its expectations.
 * @category Eval
 */
export interface LoadedCase {
  /** The case's id — the directory's name. */
  readonly id: string;
  /** The case directory's absolute path. */
  readonly dir: string;
  /** The case file's absolute path. */
  readonly caseFile: string;
  /** The case's inputs, loaded, in the order the case file declares them. */
  readonly inputs: readonly LoadedCaseInput[];
  /** The expected answer, as the case file declares it. */
  readonly expected: CorpusCase["expected"];
  /** The scoped defaults, with their scopes normalized to read-only arrays. */
  readonly defaults: CorpusCase["defaults"];
}

/**
 * One loaded input: the text of a transcript or text entry, or a document's
 * capture record beside its bytes.
 *
 * The bytes travel separately from the record, the way core's
 * `Transcriber.transcribe(item, bytes)` seam takes them.
 * @category Eval
 */
export type LoadedCaseInput =
  | {
      readonly kind: "transcript" | "text";
      /** The input file's name, as the case file declares it. */
      readonly file: string;
      /** The input file's exact utf8 contents, verbatim. */
      readonly text: string;
    }
  | {
      readonly kind: "document";
      /** The input file's name, as the case file declares it. */
      readonly file: string;
      /** The capture record the case declares, assembled and parsed. */
      readonly capture: DocumentCapture;
      /** The input file's bytes. */
      readonly bytes: Uint8Array;
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

/**
 * Parse a document against a zod schema, refusing a malformed one by name.
 * The raw document rides into the issue rendering so an enum refusal can
 * name the value the file carried, not only the allowed set.
 */
const parseWith = <T>(schema: z.ZodType<T>, document: unknown, what: string): T => {
  const result = schema.safeParse(document);
  if (!result.success) {
    throw new CorpusError(`${what} is invalid: ${describeIssues(result.error.issues, document)}`);
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

/** Read and convert the corpus's schema, then unwrap any loaded field envelopes. */
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
    return { document, schema: unwrapFieldEnvelopes(convertDocument(document)) };
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

/** Is this evidence set the scalar shape — one quote-plus-input, not a map? */
const isScalarEvidence = (evidence: unknown): evidence is ProposalEvidence =>
  typeof evidence === "object" &&
  evidence !== null &&
  typeof (evidence as { quote?: unknown }).quote === "string";

/** Is every key of this evidence map a canonical ordinal string — "0", "1", not "00" or "-1"? */
const isOrdinalKeyed = (evidence: Record<string, ProposalEvidence>): boolean =>
  Object.keys(evidence).every((key) => /^(?:0|[1-9]\d*)$/u.test(key));

/** Refuse a proposal's evidence that is malformed for its leaf, or names an undeclared input. */
const checkProposalEvidence = (
  caseFile: CorpusCase,
  caseFilePath: string,
  inventory: readonly LeafInventoryEntry[],
): void => {
  const declaredInputs = new Set(caseFile.inputs.map((entry) => entry.file));
  for (const [leafPath, entry] of Object.entries(caseFile.expected)) {
    const { proposal } = entry;
    if (proposal?.status !== "asserted") continue;
    const leaf = inventory.find((candidate) => candidate.path === leafPath);
    if (leaf === undefined) continue; // checkExpectedLeaves refuses an unknown leaf first.
    const { evidence } = proposal;
    if (leaf.inArray) {
      if (isScalarEvidence(evidence) || !isOrdinalKeyed(evidence)) {
        throw new CorpusError(
          `the corpus case file "${caseFilePath}" proposes a value for the collection leaf ` +
            `"${leafPath}", but its evidence is not ordinal-keyed — a collection leaf's evidence ` +
            `is one quote-plus-input per instance, keyed by the instance's ordinal — ` +
            `e.g. { "0": { "quote": "…", "input": "input.txt" } } (fix: key the evidence by ` +
            `instance ordinal)`,
        );
      }
    } else if (!isScalarEvidence(evidence)) {
      throw new CorpusError(
        `the corpus case file "${caseFilePath}" proposes a value for the scalar leaf ` +
          `"${leafPath}", but its evidence is ordinal-keyed — a scalar leaf's evidence is one ` +
          `quote-plus-input (fix: replace the map with { "quote", "input" })`,
      );
    }
    const links: readonly ProposalEvidence[] = isScalarEvidence(evidence)
      ? [evidence]
      : Object.values(evidence);
    for (const { input } of links) {
      if (declaredInputs.has(input)) continue;
      throw new CorpusError(
        `the corpus case file "${caseFilePath}" proposes a value for the leaf "${leafPath}" with ` +
          `evidence naming the input "${input}", which the case does not declare — a proposal's ` +
          `evidence quotes one of the case's declared inputs (fix: name one of ` +
          `${[...declaredInputs].join(", ")} in the evidence, or declare the input)`,
      );
    }
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

/**
 * One retired-shape refusal, stated once: the case-level `kind` / top-level
 * `capture` shape with an implied single input file is retired, not kept
 * alongside `inputs` — so it is refused with one line that names the field to
 * declare, never normalized and never accepted.
 */
const refuseRetiredCaseShape = (caseFilePath: string, document: unknown): void => {
  if (typeof document !== "object" || document === null) return;
  const doc = document as Record<string, unknown>;
  if (!("kind" in doc) || "inputs" in doc) return;
  const id = typeof doc.id === "string" ? doc.id : "";
  throw new CorpusError(
    `the corpus case file "${caseFilePath}"${id === "" ? "" : ` (case "${id}")`} uses the ` +
      `retired single-input shape (a case-level "kind" naming one implied input file) — declare ` +
      `"inputs" instead: a non-empty ordered list of entries, each { "file", "kind" } with a ` +
      `"capture" block on a document entry (fix: rewrite the case file with "inputs")`,
  );
};

/** Refuse an input file name that is not a direct child of the case directory. */
const refuseUnsafeFileName = (caseId: string, file: string): void => {
  if (file.includes("/") || file.includes("\\") || path.isAbsolute(file)) {
    throw new CorpusError(
      `the corpus case "${caseId}" declares the input file "${file}" — an input file is named ` +
        `directly inside the case folder, so its name may not carry a path separator or escape ` +
        `the directory (fix: name a file in the case folder, and put "../"-style paths out of ` +
        `your head)`,
    );
  }
  if (file === "." || file === "..") {
    throw new CorpusError(
      `the corpus case "${caseId}" declares the input file "${file}" — an input file's name ` +
        `may not be a path component like "${file}" (fix: name a file in the case folder)`,
    );
  }
};

/** Load the case's declared input files, in the order the case file lists them. */
const loadCaseInputs = (
  caseDir: string,
  caseId: string,
  entries: readonly CorpusCaseInput[],
): LoadedCaseInput[] => {
  const seen = new Set<string>();
  const loaded: LoadedCaseInput[] = [];
  for (const entry of entries) {
    const file = entry.file;
    if (seen.has(file)) {
      throw new CorpusError(
        `the corpus case "${caseId}" declares the input file "${file}" twice — each file may ` +
          `appear once in "inputs" (fix: drop the duplicate entry)`,
      );
    }
    seen.add(file);
    refuseUnsafeFileName(caseId, file);
    const inputPath = path.join(caseDir, file);
    if (!exists(inputPath)) {
      throw new CorpusError(
        `the corpus case "${caseId}" declares the input file "${file}" (at "${inputPath}") — ` +
          `that file does not exist (fix: create it, or drop the entry from "inputs")`,
      );
    }
    if (!isFile(inputPath)) {
      throw new CorpusError(
        `the corpus case "${caseId}" declares the input file "${file}" (at "${inputPath}") — ` +
          `that path is not a file (fix: make it a readable file, or drop the entry from "inputs")`,
      );
    }
    const bytes = readBytes(inputPath, `the corpus case "${caseId}"'s input file "${inputPath}"`);
    if (entry.kind !== "document") {
      loaded.push({ kind: entry.kind, file, text: bytes.toString("utf8") });
      continue;
    }
    const captureBlock = entry.capture;
    if (captureBlock === undefined) {
      throw new CorpusError(
        `the corpus case "${caseId}"'s document input "${file}" has no capture block — the ` +
          `corpus declares what was captured (fix: declare "capturedAt" and "pageCount" on the ` +
          `entry)`,
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
    loaded.push({ kind: "document", file, capture, bytes: new Uint8Array(bytes) });
  }
  return loaded;
};

/** Load one case directory. */
const loadCase = (
  root: string,
  dirName: string,
  leafPaths: ReadonlySet<string>,
  inventory: readonly LeafInventoryEntry[],
): LoadedCase => {
  const caseDir = path.join(root, dirName);
  const caseFilePath = path.join(caseDir, "case.json");
  if (!isFile(caseFilePath)) {
    throw new CorpusError(
      `the corpus subdirectory "${caseDir}" holds no case.json — every immediate subdirectory of ` +
        `the corpus root is a case (fix: add a case.json to it, or remove the directory)`,
    );
  }
  const document = readJson(caseFilePath, `the corpus case file "${caseFilePath}"`);
  refuseRetiredCaseShape(caseFilePath, document);
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
  checkProposalEvidence(caseFile, caseFilePath, inventory);
  const inputs = loadCaseInputs(caseDir, caseFile.id, caseFile.inputs);
  return {
    id: caseFile.id,
    dir: caseDir,
    caseFile: caseFilePath,
    inputs,
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
  const cases = dirNames.map((dirName) => loadCase(root, dirName, leafPaths, inventory));
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
