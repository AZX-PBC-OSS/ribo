/**
 * @file Schema init's standalone inputs: direct text files or existing corpus
 * case folders — any number of declared inputs per case, loaded in declared
 * order — with documents transcribed through eval's shared adapter. A
 * sample's text is the one marked join `eval/case-text.ts` owns, so init
 * cannot draft from a text eval would not run.
 */
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import { baseDocumentCaptureSchema } from "@azx/ribo-core";
import type { DocumentCapture } from "@azx/ribo-core";

import { CorpusCaseSchema } from "../corpus/case.js";
import type { CorpusCase, CorpusCaseInput, CorpusInputKind } from "../corpus/case.js";
import { describeIssues } from "../corpus/issues.js";
import { joinCaseInputTexts } from "../eval/case-text.js";
import { transcribeDocuments } from "../eval/documents.js";
import type { DocumentBatchOptions, DocumentDescriptor } from "../eval/documents.js";
import { OperatorError } from "../operator/error.js";

/**
 * One declared input of a loaded sample: its original bytes, its exact text
 * (verbatim for text and transcript inputs, the transcription for a
 * document) and the declared capture a document carries.
 */
export interface SchemaInitSampleInput {
  readonly path: string;
  readonly file: string;
  readonly kind: CorpusInputKind;
  readonly text: string;
  readonly bytes: Uint8Array;
  readonly capture?: DocumentCapture;
}

/**
 * One named sample and the exact text later prompts, estimates and evidence
 * validation consume: its declared inputs, in order, joined by the one
 * marked join eval's `caseTextOf` also uses.
 */
export interface SchemaInitSample {
  readonly name: string;
  readonly inputs: readonly SchemaInitSampleInput[];
  readonly text: string;
}

interface LoadedInput {
  readonly path: string;
  readonly file: string;
  readonly kind: CorpusInputKind;
  readonly bytes: Uint8Array;
  readonly text?: string;
  readonly document?: DocumentDescriptor;
  readonly capture?: DocumentCapture;
}

interface LoadedSample {
  readonly name: string;
  readonly inputs: readonly LoadedInput[];
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
  return {
    name: path.basename(source, path.extname(source)),
    inputs: [
      {
        path: source,
        file: path.basename(source),
        kind: "text",
        text,
        bytes: new Uint8Array(bytes),
      },
    ],
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

const loadCaseInput = (caseDir: string, caseId: string, entry: CorpusCaseInput): LoadedInput => {
  const sourcePath = inputFile(caseDir, caseId, entry);
  const buffer = readBytes(sourcePath);
  const bytes = new Uint8Array(buffer);
  if (entry.kind !== "document") {
    const text = buffer.toString("utf8");
    refuseEmptyText(sourcePath, text);
    return { path: sourcePath, file: entry.file, kind: entry.kind, text, bytes };
  }
  if (entry.capture === undefined) {
    throw new OperatorError(
      `the schema-init case "${caseId}"'s document input "${entry.file}" has no capture ` +
        "block (fix: declare capturedAt and pageCount)",
    );
  }
  const capture = baseDocumentCaptureSchema.parse({
    id: caseId,
    kind: "document",
    mimeType: "application/pdf",
    ctx: {},
    capturedAt: entry.capture.capturedAt,
    pageCount: entry.capture.pageCount,
  });
  return {
    path: sourcePath,
    file: entry.file,
    kind: entry.kind,
    bytes,
    capture,
    document: { caseId, file: entry.file, capture, bytes },
  };
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
  // Every declared input is loaded, in declared order; a duplicate file is
  // refused exactly where the corpus loader refuses one — before any
  // transcription, so a malformed case never spends.
  const seen = new Set<string>();
  for (const entry of caseFile.inputs) {
    if (seen.has(entry.file)) {
      throw new OperatorError(
        `the schema-init case "${caseFile.id}" declares the input file "${entry.file}" twice — ` +
          'each file may appear once in "inputs" (fix: drop the duplicate entry)',
      );
    }
    seen.add(entry.file);
  }
  return {
    name: caseFile.id,
    inputs: caseFile.inputs.map((entry) => loadCaseInput(caseDir, caseFile.id, entry)),
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
 * them — every sample's documents in sample order, then input order, each
 * transcribed once. Validation finishes before the lazy default transcriber
 * is built.
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
    sample.inputs.flatMap((input) => (input.document === undefined ? [] : [input.document])),
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
    const inputs = sample.inputs.map((input): SchemaInitSampleInput => {
      const text = input.document === undefined ? input.text : documentTexts.get(input.document);
      if (text === undefined) {
        throw new OperatorError(
          `the schema-init sample "${sample.name}"'s input "${input.file}" has no text after ` +
            "transcription (fix: retry the complete sample load)",
        );
      }
      return {
        path: input.path,
        file: input.file,
        kind: input.kind,
        text,
        bytes: input.bytes,
        ...(input.capture === undefined ? {} : { capture: input.capture }),
      };
    });
    return { name: sample.name, inputs, text: joinCaseInputTexts(inputs) };
  });
}
