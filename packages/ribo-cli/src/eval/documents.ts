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
 * The transcribed text of a corpus's document cases, keyed by case id.
 *
 * One map is one run's worth of transcription: built once, shared by the
 * spend guard's estimate and by every arm's run.
 * @category Eval
 */
export type DocumentTexts = ReadonlyMap<string, string>;

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
    workerSrc: pdfjsFileUrl("legacy/build/pdf.worker.min.mjs"),
    loadPdfjs: async () =>
      errorsOnly((await import(pdfjsFileUrl("legacy/build/pdf.mjs"))) as PdfjsModule),
  });

/** The message of a thrown fault — a non-Error sentinel must not read "undefined". */
const faultMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Transcribe every document case of a loaded corpus to text, once.
 *
 * Cases are transcribed in corpus order, one at a time, through the same
 * `Transcriber<DocumentCapture>` seam core defines — the CLI drives
 * `transcribe()` directly and never consults `capability()` (under Node the
 * gate reports `unsupported-platform`, and spike 0013 showed the gate is not
 * the deciding layer). A corpus holding no document case returns an empty
 * map without touching pdf.js at all — a transcript corpus never resolves
 * `pdfjs-dist`.
 *
 * @param corpus - The loaded corpus, from `loadCorpus`.
 * @param options - The transcriber seam; absent, the real `PdfjsTranscriber`.
 * @returns The transcribed text of every document case, keyed by case id.
 * @throws {@link EvalError} when a document cannot be transcribed — the
 *   message names the case id and the reason, and the whole run is refused
 *   before any model call. A case is never skipped silently.
 * @category Eval
 */
export async function transcribeDocumentCases(
  corpus: LoadedCorpus,
  options?: DocumentTranscriptionOptions,
): Promise<DocumentTexts> {
  const texts = new Map<string, string>();
  const documents = corpus.cases.filter((entry) => entry.input.kind === "document");
  if (documents.length === 0) return texts;
  const transcriber = options?.transcriber ?? defaultDocumentTranscriber();
  for (const entry of documents) {
    if (entry.input.kind !== "document") continue;
    let text: string;
    try {
      const transcript = await transcriber.transcribe(
        entry.input.capture,
        new Blob([entry.input.bytes as BlobPart]),
      );
      text = transcript.text;
    } catch (error) {
      const reason = error instanceof UnsupportedItemError ? ` (${error.reason})` : "";
      throw new EvalError(
        `eval: the corpus case "${entry.id}" is a "document" case, and its PDF could not be ` +
          `transcribed${reason}: ${faultMessage(error)} — the whole run is refused before any ` +
          `model call, because a partially-run corpus measures nothing (fix: remove the case, ` +
          `or replace its PDF with one that carries a text layer)`,
      );
    }
    texts.set(entry.id, text);
  }
  return texts;
}
