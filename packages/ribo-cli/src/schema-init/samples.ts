/**
 * @file Schema init's standalone inputs: direct text files or existing corpus
 * case folders — any number of declared inputs per case, loaded in declared
 * order — with documents transcribed through eval's shared adapter. A
 * sample's text is the one marked join `eval/case-text.ts` owns, so init
 * cannot draft from a text eval would not run.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { baseDocumentCaptureSchema } from "@azx/ribo-core";
import type { DocumentCapture } from "@azx/ribo-core";

import { CorpusCaseSchema } from "../corpus/case.js";
import type { CorpusCase, CorpusCaseInput, CorpusInputKind } from "../corpus/case.js";
import { describeIssues } from "../corpus/issues.js";
import { joinCaseInputTexts } from "../eval/case-text.js";
import { measureDocumentPages, transcribeDocuments } from "../eval/documents.js";
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
  /**
   * True when the sample is a plain folder whose input order was inferred
   * from byte-wise file-name order — the order the command prints and the
   * scaffolded `case.json` records for the user to edit.
   */
  readonly orderInferred?: boolean;
}

/**
 * Options for {@link loadSchemaInitSamples}: the transcription seams it shares
 * with eval's document path, plus the capture-stamp sources for bare PDFs.
 */
export interface SchemaInitSampleOptions extends DocumentBatchOptions {
  /** Overrides the instant stamped onto bare PDFs' `capturedAt`. */
  readonly capturedAt?: string;
  /** The run clock; read at most once, and only when a bare PDF needs a stamp. */
  readonly clock?: () => Date;
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
  readonly orderInferred?: boolean;
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

const PDF_MAGIC = "%PDF-";

const hasPdfMagicBytes = (bytes: Buffer): boolean =>
  bytes.subarray(0, PDF_MAGIC.length).toString("latin1") === PDF_MAGIC;

const loadDirectText = (source: string): LoadedSample => {
  const bytes = readBytes(source);
  if (path.extname(source).toLowerCase() === ".pdf") {
    // A bare PDF is accepted: the capture block is measured (pageCount) and
    // stamped (capturedAt) by the loader, never read off the file.
    return {
      name: path.basename(source, path.extname(source)),
      inputs: [
        {
          path: source,
          file: path.basename(source),
          kind: "document",
          bytes: new Uint8Array(bytes),
        },
      ],
    };
  }
  if (hasPdfMagicBytes(bytes)) {
    throw new OperatorError(
      `the schema-init sample "${source}" starts with PDF magic bytes but lacks the .pdf ` +
        "extension — it would be read as text (fix: rename the file to *.pdf and pass it again)",
    );
  }
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

/**
 * The input kinds a plain folder accepts, keyed by lowercase extension. A
 * PDF is a document input and gets the bare-PDF capture rule; a text or
 * markdown file is a text input; anything else is refused by name.
 */
const PLAIN_FOLDER_KINDS: Readonly<Record<string, CorpusInputKind>> = {
  ".pdf": "document",
  ".txt": "text",
  ".md": "text",
};

/** UTF-8 byte-wise name order: independent of locale and listing order. */
const byteOrder = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

/**
 * A directory without `case.json` is one sample named after the directory:
 * its non-dotfile files, ordered byte-wise by name. The strict input rules
 * below all refuse before any transcription, so a malformed folder never
 * spends.
 */
const loadPlainFolder = (dir: string): LoadedSample => {
  if (existsSync(path.join(dir, "manifest.json"))) {
    throw new OperatorError(
      `the schema-init sample directory "${dir}" holds a manifest.json — it is a corpus root, ` +
        "not one sample (fix: pass its case folders, not the corpus directory)",
    );
  }
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    throw new OperatorError(
      `the schema-init plain folder "${dir}" could not be read: ${faultMessage(error)} ` +
        "(fix: pass a readable plain folder or case folder)",
    );
  }
  const files = entries.filter((entry) => !entry.name.startsWith("."));
  for (const entry of files) {
    if (entry.isDirectory()) {
      throw new OperatorError(
        `the schema-init plain folder "${dir}" holds the subdirectory "${entry.name}" — a plain ` +
          "folder's inputs are files directly inside it (fix: pass the subdirectory as its own " +
          "sample, or write a case.json declaring this folder's inputs)",
      );
    }
    if (!entry.isFile()) {
      // A symlink or special file could point outside the named folder.
      throw new OperatorError(
        `the schema-init plain folder "${dir}" holds "${entry.name}", which is not a regular ` +
          "file — links are not followed (fix: copy the file into the folder in place of the " +
          "link)",
      );
    }
  }
  const inputs = files
    .map((entry) => entry.name)
    .sort(byteOrder)
    .map((file): LoadedInput => {
      const kind = PLAIN_FOLDER_KINDS[path.extname(file).toLowerCase()];
      if (kind === undefined) {
        throw new OperatorError(
          `the schema-init plain folder "${dir}" holds the unsupported input file "${file}" — ` +
            "a plain folder's inputs are .pdf, .txt or .md files (fix: convert or remove the " +
            "file, or write a case.json declaring the folder's inputs)",
        );
      }
      const source = path.join(dir, file);
      const buffer = readBytes(source);
      const bytes = new Uint8Array(buffer);
      if (kind === "document") {
        // A plain folder's PDFs get the bare-PDF capture rule: measured and
        // stamped by the same pass that stamps direct bare PDFs.
        return { path: source, file, kind, bytes };
      }
      const text = buffer.toString("utf8");
      refuseEmptyText(source, text);
      return { path: source, file, kind, text, bytes };
    });
  if (inputs.length === 0) {
    throw new OperatorError(
      `the schema-init plain folder "${dir}" holds no input files — dotfiles are skipped and ` +
        "the inputs are .pdf, .txt or .md files (fix: add input files, or write a case.json " +
        "declaring the folder's inputs)",
    );
  }
  return { name: path.basename(dir), orderInferred: true, inputs };
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
  if (stats.isDirectory()) {
    return existsSync(path.join(resolved, "case.json"))
      ? loadCaseSample(resolved)
      : loadPlainFolder(resolved);
  }
  if (stats.isFile()) return loadDirectText(resolved);
  throw new OperatorError(
    `the schema-init sample "${resolved}" is neither a file nor a case folder ` +
      "(fix: pass a direct text file or an existing case folder)",
  );
};

/**
 * Measure a bare PDF's capture block — `pageCount` from the file through the
 * shared pdf.js path, `capturedAt` from the run instant — and attach the
 * document descriptor. A case folder's declared capture block is never
 * touched: only document-kind inputs still missing one pass through here.
 */
const stampBarePdfs = async (
  loaded: readonly LoadedSample[],
  instant: () => string,
): Promise<readonly LoadedSample[]> => {
  const stamped: LoadedSample[] = [];
  for (const sample of loaded) {
    const inputs: LoadedInput[] = [];
    for (const input of sample.inputs) {
      if (input.kind !== "document" || input.document !== undefined) {
        inputs.push(input);
        continue;
      }
      // One clock reading per run, however many bare PDFs a run stamps.
      const capturedAt = instant();
      const pageCount = await measureDocumentPages(input.bytes, input.path, {
        refuse: (file, detail) =>
          new OperatorError(
            `the schema-init bare PDF "${file}" could not be opened for its page count: ${detail} ` +
              "(fix: replace it with a readable PDF)",
          ),
      });
      const capture = baseDocumentCaptureSchema.parse({
        id: sample.name,
        kind: "document",
        mimeType: "application/pdf",
        ctx: {},
        capturedAt,
        pageCount,
      });
      inputs.push({
        ...input,
        capture,
        document: { caseId: sample.name, file: input.file, capture, bytes: input.bytes },
      });
    }
    stamped.push({ name: sample.name, orderInferred: sample.orderInferred, inputs });
  }
  return stamped;
};

/**
 * Load and, where declared, transcribe all samples before returning any of
 * them — every sample's documents in sample order, then input order, each
 * transcribed once. Bare PDFs are measured and stamped first, so a page-count
 * refusal lands before the estimate and before any transcription or model
 * call. Validation finishes before the lazy default transcriber
 * is built.
 */
export async function loadSchemaInitSamples(
  sources: readonly string[],
  options?: SchemaInitSampleOptions,
): Promise<readonly SchemaInitSample[]> {
  if (sources.length === 0) {
    throw new OperatorError(
      "schema init needs at least one sample (fix: pass a direct text file or a case folder)",
    );
  }
  // One instant per run: an explicit capturedAt wins, else the injected clock,
  // read at most once and only when a bare PDF actually needs a stamp.
  let instant: string | undefined;
  const stampInstant = (): string => {
    if (instant === undefined) {
      instant = options?.capturedAt ?? (options?.clock ?? (() => new Date()))().toISOString();
    }
    return instant;
  };
  const loaded = await stampBarePdfs(sources.map(loadSample), stampInstant);
  const documents = loaded.flatMap((sample) =>
    sample.inputs.flatMap((input) => (input.document === undefined ? [] : [input.document])),
  );
  const transcribed = await transcribeDocuments(documents, {
    ...(options === undefined ? {} : options),
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
    return {
      name: sample.name,
      orderInferred: sample.orderInferred,
      inputs,
      text: joinCaseInputTexts(inputs),
    };
  });
}
