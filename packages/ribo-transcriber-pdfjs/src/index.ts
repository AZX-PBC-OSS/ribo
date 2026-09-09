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
import type {
  DocumentCapture,
  Transcript,
  Transcriber,
  TranscriberCapability,
} from "@azx/ribo-core";

import {
  DEFAULT_NO_TEXT_LAYER_THRESHOLD,
  PDFJS_ENGINE,
  type PdfjsModule,
  type PdfjsTranscriberOptions,
} from "./config.js";
import { readDocumentText } from "./pdf-text.js";

export { DEFAULT_NO_TEXT_LAYER_THRESHOLD, PDFJS_ENGINE } from "./config.js";
export type { PdfjsModule, PdfjsTranscriberOptions } from "./config.js";
export { openDocument, readDocumentText, PAGE_MARKER, resetPdfjsCache } from "./pdf-text.js";
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
  readonly #loadPdfjs: () => Promise<PdfjsModule>;

  constructor(options: PdfjsTranscriberOptions = {}) {
    this.#workerSrc = options.workerSrc;
    this.#noTextLayerThreshold = options.noTextLayerThreshold ?? DEFAULT_NO_TEXT_LAYER_THRESHOLD;
    this.#loadPdfjs =
      options.loadPdfjs ?? (async () => (await import("pdfjs-dist")) as unknown as PdfjsModule);
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

  transcribe: (item: DocumentCapture, bytes: Blob) => Promise<Transcript> = async (item, bytes) => {
    const { text } = await readDocumentText(bytes, {
      workerSrc: this.#workerSrc!,
      loadPdfjs: this.#loadPdfjs,
      noTextLayerThreshold: this.#noTextLayerThreshold,
      engine: this.engine,
    });

    return {
      recordingId: item.id,
      text,
      engine: this.engine,
    };
  };
}
