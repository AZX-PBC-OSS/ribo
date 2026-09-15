/**
 * @file The public surface of `@azx/ribo-transcriber-pdfjs`.
 *
 * PDF document transcription via pdf.js, implementing `@azx/ribo-core`'s
 * `Transcriber<DocumentCapture>` seam with engine id `"pdfjs"`. A
 * `DocumentCapture` (a PDF enqueued for transcription) flows through the same
 * `transcribe → extract → review` pipeline as a voice recording, with pdf.js
 * producing the text instead of Whisper.
 *
 * **`capability()` does not load pdf.js.** The contract says it is called often
 * and expected to be cheap (D8). It answers only "can pdf.js run in this
 * environment": no `Worker` constructor → `unsupported-platform` (permanent);
 * no configured worker URL → `not-configured` (not permanent — a host may
 * supply one later); otherwise `ready`.
 *
 * **`transcribe()` lazy-loads pdf.js via a memoized dynamic `import()`.**
 * pdf.js is ~89 KB gzipped plus a ~387 KB worker, and neither may load for a
 * consumer that never transcribes a document. The worker URL is injected by
 * the consumer (AGENTS.md §5.2) — the library never constructs a `Worker`.
 */
import { decodeEntities } from "@azx/ribo-core";
import type {
  DocumentCapture,
  Transcript,
  Transcriber,
  TranscriberCapability,
  TranscribeOptions,
} from "@azx/ribo-core";

import {
  DEFAULT_NO_TEXT_LAYER_THRESHOLD,
  PDFJS_ENGINE,
  type PageRead,
  type PdfjsModule,
  type PdfjsTranscriberOptions,
} from "./config.js";
import { readDocumentText } from "./pdf-text.js";

export { DEFAULT_NO_TEXT_LAYER_THRESHOLD, PDFJS_ENGINE } from "./config.js";
export { isPdfTextItem } from "./config.js";
export type {
  PdfContentItem,
  PdfjsModule,
  PdfjsTranscriberOptions,
  PdfMarkedContentItem,
  PdfTextItem,
  PdfTransformMatrix,
} from "./config.js";
// The per-page progress event the `onPage` hooks carry. Public because a host
// writing a progress handler must be able to name the event's type; it lives
// in `config.ts` beside the options interfaces that declare those hooks.
export type { PageRead } from "./config.js";
export { openDocument, readDocumentText, PAGE_MARKER, resetPdfjsCache } from "./pdf-text.js";
export {
  COLUMN_SEPARATOR,
  DEFAULT_COLUMN_GAP_PT,
  DEFAULT_ROW_TOLERANCE_PT,
  DEFAULT_WORD_GAP_PT,
  layoutPageText,
} from "./page-layout.js";
export type { PageLayoutOptions, PositionedTextItem } from "./page-layout.js";
export type {
  OpenDocumentHandle,
  OpenDocumentOptions,
  ReadDocumentTextOptions,
} from "./pdf-text.js";

/**
 * pdf.js document transcription, implementing `Transcriber<DocumentCapture>`.
 *
 * ## Capability
 *
 * Answers only from the environment — no pdf.js load:
 *
 * - No `Worker` global → `unsupported-platform` (permanent — the platform
 *   cannot run pdf.js at all).
 * - No configured `workerSrc` → `not-configured` (not permanent — a host may
 *   supply one later).
 * - Otherwise `ready`.
 *
 * ## Transcription
 *
 * {@link transcribe} lazy-loads pdf.js via a memoized dynamic `import()`, opens
 * the document, reads each page's `getTextContent()`, and joins them with page
 * markers (`\n===== PAGE n =====\n`, numbered from 1). A document yielding
 * fewer than `noTextLayerThreshold` non-whitespace characters throws
 * `UnsupportedItemError` with reason `"no-text-layer"` — a scanned PDF often
 * yields a few stray characters from a header stamp, so zero is the wrong bar.
 *
 * pdf.js's own password / invalid-PDF exceptions are mapped to
 * `UnsupportedItemError` (`encrypted` / `unsupported-format`); anything else
 * rethrows unchanged, because it is an attempt failure and the queue owns it.
 */
export class PdfjsTranscriber implements Transcriber<DocumentCapture> {
  readonly engine = PDFJS_ENGINE;

  readonly #workerSrc?: string;
  readonly #noTextLayerThreshold: number;
  readonly #onPage?: (event: PageRead) => void;
  readonly #loadPdfjs: () => Promise<PdfjsModule>;

  constructor(options: PdfjsTranscriberOptions = {}) {
    this.#workerSrc = options.workerSrc;
    this.#noTextLayerThreshold = options.noTextLayerThreshold ?? DEFAULT_NO_TEXT_LAYER_THRESHOLD;
    this.#onPage = options.onPage;
    this.#loadPdfjs = options.loadPdfjs ?? (async () => await import("pdfjs-dist"));
  }

  async capability(): Promise<TranscriberCapability> {
    // No Worker constructor → pdf.js cannot run at all. This is permanent: the
    // platform itself is wrong, and no configuration change fixes it.
    if (typeof Worker === "undefined") {
      return {
        status: "unavailable",
        reason: "unsupported-platform",
        detail: "This environment has no Worker constructor; pdf.js cannot run.",
      };
    }

    // No worker URL → pdf.js could run but is not configured. Not permanent: a
    // host may supply workerSrc later, so capability should be re-probed.
    if (!this.#workerSrc) {
      return {
        status: "unavailable",
        reason: "not-configured",
        detail:
          "No pdf.js worker URL is configured. Supply workerSrc to enable document transcription.",
      };
    }

    return { status: "ready" };
  }

  // The signal is accepted per the widened contract but not honoured yet —
  // pdf.js offers cancellation via `loadingTask.destroy()` and wiring it up is
  // this transport's own follow-up, alongside a possible between-pages check.
  transcribe: (
    item: DocumentCapture,
    bytes: Blob,
    _options?: TranscribeOptions,
  ) => Promise<Transcript> = async (item, bytes) => {
    const { text } = await readDocumentText(bytes, {
      workerSrc: this.#workerSrc!,
      loadPdfjs: this.#loadPdfjs,
      noTextLayerThreshold: this.#noTextLayerThreshold,
      engine: this.engine,
      onPage: this.#onPage,
    });

    return {
      recordingId: item.id,
      text: decodeEntities(text),
      engine: this.engine,
    };
  };
}
