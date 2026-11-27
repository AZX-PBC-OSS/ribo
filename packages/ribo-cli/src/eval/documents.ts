/**
 * @file The document path: a corpus's document cases, transcribed to text
 * under Node.
 *
 * Spike 0013 (`docs/spikes/0013-pdfjs-under-node/`) answered the blocking
 * question: pdf.js runs under Node without a worker shim, through
 * pdfjs-dist's own legacy build (`legacy/build/pdf.mjs`), injected into the
 * real `PdfjsTranscriber` via its `loadPdfjs` option. The transcriber's
 * `capability()` gate — which reports `unsupported-platform` wherever no
 * `Worker` constructor exists — is not what decides here: the CLI drives
 * `transcribe()` directly, defines no `Worker` global and no polyfill, and
 * the transcriber package's browser behaviour is untouched.
 *
 * Both pdf.js files — the legacy build and its worker script — are resolved
 * from the INSTALLED `pdfjs-dist` (a runtime dependency of this package)
 * through `createRequire`, so the bytes are always local files, never a CDN
 * or a remote URL. The specifiers are computed at runtime rather than written
 * literally: the bin is a single-file bundle, and a literal `pdfjs-dist`
 * specifier in it is exactly what the pack-and-consume tier refuses.
 *
 * Transcription happens ONCE per run, before the spend estimate and before
 * any model call, and every arm shares the result: the bin transcribes, then
 * hands the one map to the guard and to every arm's run. A document that
 * cannot be transcribed — no text layer, or bytes pdf.js cannot open —
 * refuses the whole run, naming the case id and the reason: a partially-run
 * corpus measures nothing, and a skipped case is a silent one.
 */
// A namespace import, not `import { createRequire }`: rolldown's
// single-file runtime prelude declares that same named import, and the
// bundler's import hoisting re-declares an identical one at the top of the
// bin — one identifier, two declarations, a bin that does not parse.
import * as nodeModule from "node:module";
import { pathToFileURL } from "node:url";

import { UnsupportedItemError } from "@azx/ribo-core";
import type { DocumentCapture, Transcriber } from "@azx/ribo-core";
import { PdfjsTranscriber } from "@azx/ribo-transcriber-pdfjs";
import type { PdfjsModule } from "@azx/ribo-transcriber-pdfjs";

import type { LoadedCorpus } from "../corpus.js";
import { EvalError } from "./error.js";

/**
 * The transcribed text of a corpus's document inputs, keyed by case id AND
 * input file name — two documents in one case are different questions, so a
 * key of case id alone would let one overwrite the other. The separator is
 * safe because a case id is a directory name and an input file's name may not
 * carry a path separator (the loader refuses both), so neither half can
 * contain one.
 * @category Eval
 */
export type DocumentTexts = ReadonlyMap<string, string>;

/** The key a document input's transcription sits under in {@link DocumentTexts}. */
export const documentTextKey = (caseId: string, file: string): string => `${caseId}/${file}`;

/**
 * How {@link transcribeDocumentCases} transcribes.
 * @category Eval
 */
export interface DocumentTranscriptionOptions {
  /**
   * The transcriber — the injectable seam. Absent, the real
   * `PdfjsTranscriber` over pdf.js's legacy build, resolved from the
   * installed `pdfjs-dist`.
   */
  readonly transcriber?: Transcriber<DocumentCapture>;
}

/** One document at the shared eval/schema-init transcription boundary. */
export interface DocumentDescriptor {
  readonly caseId: string;
  readonly file: string;
  readonly capture: DocumentCapture;
  readonly bytes: Uint8Array;
}

/** A document beside the actual text its one transcription returned. */
export interface TranscribedDocument {
  readonly document: DocumentDescriptor;
  readonly text: string;
}

/** Internal construction seam; the public corpus API retains its original options. */
export interface DocumentBatchOptions extends DocumentTranscriptionOptions {
  readonly createTranscriber?: () => Transcriber<DocumentCapture>;
  /** Words the refusal for a document that cannot be transcribed; eval's wording by default. */
  readonly refuse?: (document: DocumentDescriptor, detail: string) => Error;
}

const require = nodeModule.createRequire(import.meta.url);

/**
 * Resolve one of pdfjs-dist's own shipped files to a local `file:` URL.
 *
 * `createRequire` walks this package's own dependency tree, so the file is
 * the installed `pdfjs-dist`'s — in the workspace, in an installed app, and
 * in the packed bin's `node_modules` alike — and the `file:` URL form is what
 * a dynamic `import()` of an absolute path needs on every platform.
 */
const pdfjsFileUrl = (subpath: string): string =>
  pathToFileURL(require.resolve(`pdfjs-dist/${subpath}`)).href;

/** The installed pdf.js legacy worker script, as a local `file:` URL. */
const legacyPdfjsWorkerUrl = (): string => pdfjsFileUrl("legacy/build/pdf.worker.min.mjs");

/** The installed pdf.js legacy build, wrapped at errors-only verbosity. */
const loadLegacyPdfjs = async (): Promise<PdfjsModule> =>
  errorsOnly((await import(pdfjsFileUrl("legacy/build/pdf.mjs"))) as PdfjsModule);

/**
 * pdf.js wrapped at errors-only verbosity. Its per-document `Warning: …`
 * lines (the `TT: undefined function` / `standardFontDataUrl` reminders) are
 * noise on this command's stderr — stderr is where the CLI's own diagnostics
 * live — so `getDocument` opens every document with `verbosity: 0`, pdf.js's
 * ERRORS level. A genuine failure still rejects, and `transcribeDocumentCases`
 * refuses the run naming the case. The wiring lives HERE, in the CLI's own
 * loader wrap: the transcriber package stays browser-safe and untouched.
 */
const errorsOnly = (pdfjs: PdfjsModule): PdfjsModule => ({
  ...pdfjs,
  getDocument: (params) => pdfjs.getDocument({ ...params, verbosity: 0 }),
});

/**
 * The default transcriber: the real `PdfjsTranscriber`, constructed with the
 * legacy build through `loadPdfjs` — wrapped errors-only, above — and the
 * legacy worker script's local path as `workerSrc` (spike 0013's A5
 * configuration, plus the verbosity wrap).
 */
const defaultDocumentTranscriber = (): Transcriber<DocumentCapture> =>
  new PdfjsTranscriber({
    workerSrc: legacyPdfjsWorkerUrl(),
    loadPdfjs: loadLegacyPdfjs,
  });

/**
 * Options for {@link measureDocumentPages}.
 * @category Eval
 */
export interface PageCountMeasurementOptions {
  /**
   * The pdf.js loader — the injectable seam. Absent, the same resolved legacy
   * build and worker path the default transcriber uses.
   */
  readonly loadPdfjs?: () => Promise<PdfjsModule>;
  /** Words the refusal for bytes pdf.js cannot open; eval's wording by default. */
  readonly refuse?: (file: string, detail: string) => Error;
}

/**
 * Measure a PDF's page count by opening it through the same resolved pdf.js
 * legacy build and worker path the default transcriber uses, at errors-only
 * verbosity. This is what fills a bare PDF's capture block at schema init: a
 * `DocumentCapture` requires `pageCount`, and counting pages needs a PDF
 * parser, so init measures the file rather than guessing. The measurement
 * runs before the spend estimate and before any model call, and reads no
 * file timestamp and no PDF metadata date.
 *
 * @param bytes - The PDF's exact bytes.
 * @param file - The file's name, for the refusal message.
 * @param options - The loader and refusal seams.
 * @returns The document's page count, from pdf.js's `numPages`.
 * @throws An {@link EvalError} — or the injected `refuse` error — naming the
 *   file when pdf.js cannot open the bytes (encrypted, unreadable, or not a
 *   PDF at all).
 * @category Eval
 */
export async function measureDocumentPages(
  bytes: Uint8Array,
  file: string,
  options?: PageCountMeasurementOptions,
): Promise<number> {
  const fail = (detail: string): Error => {
    if (options?.refuse !== undefined) return options.refuse(file, detail);
    return new EvalError(
      `eval: the document "${file}" could not be measured for its page count: ${detail} — ` +
        "the page count is measured before the estimate and before any model call (fix: replace " +
        "the file with a readable PDF)",
    );
  };
  let loadingTask: ReturnType<PdfjsModule["getDocument"]> | undefined;
  try {
    const pdfjs = await (options?.loadPdfjs ?? loadLegacyPdfjs)();
    // The same legacy worker path the default transcriber is constructed with.
    pdfjs.GlobalWorkerOptions.workerSrc = legacyPdfjsWorkerUrl();
    // pdf.js may detach the buffer it is handed; a copy keeps the caller's
    // exact bytes intact for the transcription that follows.
    loadingTask = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 });
    const document = await loadingTask.promise;
    return document.numPages;
  } catch (error) {
    throw fail(faultMessage(error));
  } finally {
    // Destroy on every path: an opened document's worker must not outlive the
    // measurement, and a failed open's loading task must not dangle.
    void loadingTask?.destroy().catch(() => undefined);
  }
}

/** The message of a thrown fault — a non-Error sentinel must not read "undefined". */
const faultMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Transcribe descriptors sequentially, once each, through the one default
 * pdf.js path. Empty batches do not construct a transcriber.
 */
export async function transcribeDocuments(
  documents: readonly DocumentDescriptor[],
  options?: DocumentBatchOptions,
): Promise<readonly TranscribedDocument[]> {
  if (documents.length === 0) return [];
  const transcriber =
    options?.transcriber ?? options?.createTranscriber?.() ?? defaultDocumentTranscriber();
  const texts: TranscribedDocument[] = [];
  for (const document of documents) {
    let text: string;
    try {
      const transcript = await transcriber.transcribe(
        document.capture,
        new Blob([document.bytes as BlobPart]),
      );
      text = transcript.text;
    } catch (error) {
      const reason = error instanceof UnsupportedItemError ? ` (${error.reason})` : "";
      const detail = `could not be transcribed${reason}: ${faultMessage(error)}`;
      if (options?.refuse !== undefined) throw options.refuse(document, detail);
      throw new EvalError(
        `eval: the corpus case "${document.caseId}"'s document input "${document.file}" ${detail} ` +
          `— the whole run is refused before any model call, because a partially-run corpus ` +
          `measures nothing (fix: remove the input, or replace its PDF with one that carries a ` +
          `text layer)`,
      );
    }
    texts.push({ document, text });
  }
  return texts;
}

/**
 * Transcribe every document input of a loaded corpus to text, once.
 *
 * The corpus's cases are walked in corpus order and each case's inputs in
 * declared order, and every document input is transcribed exactly once
 * through the same `Transcriber<DocumentCapture>` seam core defines — the CLI
 * drives `transcribe()` directly and never consults `capability()` (under
 * Node the gate reports `unsupported-platform`, and spike 0013 showed the
 * gate is not the deciding layer). A corpus holding no document input returns
 * an empty map without constructing a transcriber at all — a transcript
 * corpus never resolves `pdfjs-dist`.
 *
 * @param corpus - The loaded corpus, from `loadCorpus`.
 * @param options - The transcriber seam; absent, the real `PdfjsTranscriber`.
 * @returns The transcribed text of every document input, keyed by
 *   `documentTextKey` — case id and input file name together.
 * @throws {@link EvalError} when a document cannot be transcribed — the
 *   message names the case id, the input file and the reason, and the whole
 *   run is refused before any model call. A case is never skipped silently.
 * @category Eval
 */
export async function transcribeDocumentCases(
  corpus: LoadedCorpus,
  options?: DocumentTranscriptionOptions,
): Promise<DocumentTexts> {
  const documents = corpus.cases.flatMap((entry) =>
    entry.inputs.flatMap((input) =>
      input.kind === "document"
        ? [
            {
              caseId: entry.id,
              file: input.file,
              capture: input.capture,
              bytes: input.bytes,
            },
          ]
        : [],
    ),
  );
  const transcribed = await transcribeDocuments(documents, options);
  return new Map(
    transcribed.map(({ document, text }) => [
      documentTextKey(document.caseId, document.file),
      text,
    ]),
  );
}
