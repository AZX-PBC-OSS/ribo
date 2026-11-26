/**
 * @file Schema init's standalone inputs: direct text or one existing corpus
 * case folder, with documents transcribed through eval's shared adapter.
 */
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import { baseDocumentCaptureSchema } from "@azx/ribo-core";
import type { DocumentCapture } from "@azx/ribo-core";

import { CorpusCaseSchema } from "../corpus/case.js";
import type { CorpusCase, CorpusCaseInput, CorpusInputKind } from "../corpus/case.js";
import { describeIssues } from "../corpus/issues.js";
import { transcribeDocuments } from "../eval/documents.js";
import type { DocumentBatchOptions, DocumentDescriptor } from "../eval/documents.js";
import { OperatorError } from "../operator/error.js";

/** The original input bytes and declared capture, retained for later scaffolding. */
export interface SchemaInitSampleSource {
  readonly path: string;
  readonly file: string;
  readonly bytes: Uint8Array;
  readonly capture?: DocumentCapture;
}

/** One named source and the exact text later prompts and estimates consume. */
export interface SchemaInitSample {
  readonly name: string;
  readonly kind: CorpusInputKind;
  readonly text: string;
  readonly source: SchemaInitSampleSource;
}

interface LoadedSample {
  readonly name: string;
  readonly kind: CorpusInputKind;
  readonly source: SchemaInitSampleSource;
  readonly text?: string;
  readonly document?: DocumentDescriptor;
}

const faultMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const readBytes = (file: string): Buffer => {
  try {
    return readFileSync(file);
  } catch (error) {
    throw new OperatorError(
      `the schema-init sample input "${file}" could not be read: ${faultMessage(error)} ` +
        "(fix: pass a readable input file)",
    );
  }
};

const refuseEmptyText = (source: string, text: string): void => {
  if (text.trim().length > 0) return;
  throw new OperatorError(
    `the schema-init sample input "${source}" is empty (fix: supply text to draft from)`,
  );
};

const loadDirectText = (source: string): LoadedSample => {
  if (path.extname(source).toLowerCase() === ".pdf") {
    throw new OperatorError(
      `the direct PDF "${source}" has no declared capture metadata (capturedAt, pageCount) — ` +
        "schema init never guesses document metadata (fix: pass an existing document case " +
        "folder whose case.json declares the capture block)",
    );
  }
  const bytes = readBytes(source);
  const text = bytes.toString("utf8");
  refuseEmptyText(source, text);
  const file = path.basename(source);
  return {
    name: path.basename(source, path.extname(source)),
    kind: "text",
    text,
    source: { path: source, file, bytes: new Uint8Array(bytes) },
  };
};

const parseCase = (caseFilePath: string): CorpusCase => {
  const bytes = readBytes(caseFilePath);
  let document: unknown;
  try {
    document = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new OperatorError(
      `the schema-init case file "${caseFilePath}" is not valid JSON: ${faultMessage(error)} ` +
        "(fix: repair the case file)",
    );
  }
  const parsed = CorpusCaseSchema.safeParse(document);
  if (!parsed.success) {
    throw new OperatorError(
      `the schema-init case file "${caseFilePath}" is invalid: ` +
        `${describeIssues(parsed.error.issues, document)} (fix: repair the declared input)`,
    );
  }
  return parsed.data;
};

const refuseUnsafeFileName = (caseId: string, file: string): void => {
  if (
    file.includes("/") ||
    file.includes("\\") ||
    path.isAbsolute(file) ||
    file === "." ||
    file === ".."
  ) {
    throw new OperatorError(
      `the schema-init case "${caseId}" declares the unsafe input path "${file}" — an input ` +
        "file must be named directly inside the case folder (fix: use a file name without " +
        "path separators or parent components)",
    );
  }
};

const inputFile = (caseDir: string, caseId: string, entry: CorpusCaseInput): string => {
  refuseUnsafeFileName(caseId, entry.file);
  const file = path.join(caseDir, entry.file);
  try {
    if (statSync(file).isFile()) return file;
  } catch {
    // The refusal below covers both a missing path and one that is not a file.
  }
  throw new OperatorError(
    `the schema-init case "${caseId}" declares the input file "${entry.file}" (at "${file}"), ` +
      "which is not a readable file (fix: create the declared file or correct the case input)",
  );
};

const loadCaseSample = (caseDir: string): LoadedSample => {
  const caseFilePath = path.join(caseDir, "case.json");
  const caseFile = parseCase(caseFilePath);
  const directoryName = path.basename(caseDir);
  if (caseFile.id !== directoryName) {
    throw new OperatorError(
      `the schema-init case file "${caseFilePath}" declares id "${caseFile.id}", but its ` +
        `directory is named "${directoryName}" (fix: rename one to match the other)`,
    );
  }
  if (caseFile.inputs.length !== 1) {
    throw new OperatorError(
      `the schema-init case "${caseFile.id}" declares ${caseFile.inputs.length} inputs — schema ` +
        "init accepts one input per case folder and never merges them (fix: pass separate " +
        "single-input case folders)",
    );
  }
  const entry = caseFile.inputs[0]!;
  const sourcePath = inputFile(caseDir, caseFile.id, entry);
  const buffer = readBytes(sourcePath);
  const bytes = new Uint8Array(buffer);
  const source = { path: sourcePath, file: entry.file, bytes };
  if (entry.kind !== "document") {
    const text = buffer.toString("utf8");
    refuseEmptyText(sourcePath, text);
    return { name: caseFile.id, kind: entry.kind, text, source };
  }
  if (entry.capture === undefined) {
    throw new OperatorError(
      `the schema-init case "${caseFile.id}"'s document input "${entry.file}" has no capture ` +
        "block (fix: declare capturedAt and pageCount)",
    );
  }
  const capture = baseDocumentCaptureSchema.parse({
    id: caseFile.id,
    kind: "document",
    mimeType: "application/pdf",
    ctx: {},
    capturedAt: entry.capture.capturedAt,
    pageCount: entry.capture.pageCount,
  });
  return {
    name: caseFile.id,
    kind: "document",
    source: { ...source, capture },
    document: { caseId: caseFile.id, file: entry.file, capture, bytes },
  };
};

const loadSample = (source: string): LoadedSample => {
  const resolved = path.resolve(source);
  let stats;
  try {
    stats = statSync(resolved);
  } catch (error) {
    throw new OperatorError(
      `the schema-init sample "${resolved}" could not be read: ${faultMessage(error)} ` +
        "(fix: pass a direct text file or an existing case folder)",
    );
  }
  if (stats.isDirectory()) return loadCaseSample(resolved);
  if (stats.isFile()) return loadDirectText(resolved);
  throw new OperatorError(
    `the schema-init sample "${resolved}" is neither a file nor a case folder ` +
      "(fix: pass a direct text file or an existing case folder)",
  );
};

/**
 * Load and, where declared, transcribe all samples before returning any of
 * them. Validation finishes before the lazy default transcriber is built.
 */
export async function loadSchemaInitSamples(
  sources: readonly string[],
  options?: DocumentBatchOptions,
): Promise<readonly SchemaInitSample[]> {
  if (sources.length === 0) {
    throw new OperatorError(
      "schema init needs at least one sample (fix: pass a direct text file or a case folder)",
    );
  }
  const loaded = sources.map(loadSample);
  const documents = loaded.flatMap((sample) =>
    sample.document === undefined ? [] : [sample.document],
  );
  const transcribed = await transcribeDocuments(documents, {
    ...options,
    refuse: (document, detail) =>
      new OperatorError(
        `the schema-init case "${document.caseId}"'s document input "${document.file}" ${detail} ` +
          "— no draft is made from a partial sample set (fix: remove the sample, or replace its " +
          "PDF with one that carries a text layer)",
      ),
  });
  const documentTexts = new Map(transcribed.map(({ document, text }) => [document, text] as const));
  return loaded.map((sample) => {
    const text = sample.document === undefined ? sample.text : documentTexts.get(sample.document);
    if (text === undefined) {
      throw new OperatorError(
        `the schema-init sample "${sample.name}" has no text after transcription ` +
          "(fix: retry the complete sample load)",
      );
    }
    return { name: sample.name, kind: sample.kind, text, source: sample.source };
  });
}
