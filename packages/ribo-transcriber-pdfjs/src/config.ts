/**
 * @file Configuration for the pdf.js document transcriber.
 *
 * The engine id and the options interface live here so {@link ./index.ts} can
 * stay focused on the class. The engine id is a published constant — it rides
 * into every `Transcript.engine` this package produces and into the outbox
 * document, so a rename is a migration, not a refactor (see `transcript.ts`).
 */

/**
 * `Transcriber.engine` this implementation stamps onto every `Transcript` it
 * produces. Short and stable across versions — it is persisted data, readable
 * straight off `Outbox.list()`. See D8 in the document-transcription plan.
 */
export const PDFJS_ENGINE = "pdfjs";

/**
 * The subset of the `pdfjs-dist` module API this package consumes.
 *
 * Defined here rather than imported from `pdfjs-dist` types so the lazy
 * `import()` in Task 6 can be typed without pulling the full type tree into
 * the options interface. The real module has many more exports; we use only
 * `getDocument` and `GlobalWorkerOptions`.
 */
export interface PdfjsModule {
  getDocument: (params: Record<string, unknown>) => { promise: Promise<PdfDocumentProxy> };
  GlobalWorkerOptions: { workerSrc: string };
}

/**
 * The handle `pdfjs.getDocument().promise` resolves to. Only the two members
 * this package uses are declared; the real proxy has many more.
 */
export interface PdfDocumentProxy {
  numPages: number;
  getPage: (n: number) => Promise<PdfPageProxy>;
}

/**
 * The handle `doc.getPage(n)` resolves to. Only `getTextContent` is used.
 */
export interface PdfPageProxy {
  getTextContent: () => Promise<{ items: readonly PdfTextItem[] }>;
}

/**
 * One item from `getTextContent().items`.
 *
 * **The geometry is the important part.** pdf.js emits items in
 * content-stream order, which is not visual order, so `str` alone is not
 * enough to reconstruct a page — see `page-layout.ts`. `transform` is the
 * item's 6-element matrix `[a, b, c, d, e, f]` where `e`/`f` are the origin's
 * x/y in device space (PDF y grows **upward**), and `width`/`height` bound the
 * run. Together they are what lets baseline clustering rebuild rows.
 *
 * `hasEOL` signals a line break in the **drawing** order. It is no longer read:
 * geometry supersedes it, and on a real invoice it was actively misleading.
 * Kept on the interface because pdf.js returns it and removing it from the
 * structural type would be a lie about the shape.
 */
export interface PdfTextItem {
  str: string;
  hasEOL: boolean;
  /** `[a, b, c, d, e, f]` — `e` is x, `f` is the baseline y. */
  transform?: number[];
  width?: number;
  height?: number;
}

/**
 * Options for {@link PdfjsTranscriber}.
 *
 * **The worker URL is injected by the consumer.** The library never constructs
 * a `Worker` or reaches for a bundler-specific import (AGENTS.md §5.2). The
 * consumer serves the pdf.js worker as a static asset from their own origin —
 * `worker-src 'self' blob:` admits neither a CDN URL nor the `data:` URI a
 * bundler will inline (D8).
 *
 * `capability()` answers only from the environment — no pdf.js load — per the
 * contract's "called often and expected to be cheap" requirement.
 */
export interface PdfjsTranscriberOptions {
  /**
   * URL of the pdf.js worker script (`pdf.worker.min.mjs`). Injected by the
   * host — the library never constructs or discovers it. When absent,
   * {@link PdfjsTranscriber.capability} reports `not-configured`; the host may
   * supply one later, so the failure is **not** permanent.
   */
  readonly workerSrc?: string;

  /**
   * Minimum number of non-whitespace characters a document must yield to be
   * considered as having a text layer. Below this,
   * {@link PdfjsTranscriber.transcribe} throws `UnsupportedItemError` with
   * reason `"no-text-layer"`. See {@link DEFAULT_NO_TEXT_LAYER_THRESHOLD}.
   */
  readonly noTextLayerThreshold?: number;

  /**
   * Factory that lazy-loads the pdf.js module. Defaults to a memoized
   * `import("pdfjs-dist")`. Exposed so tests can assert that `capability()`
   * never calls it — the contract says capability is cheap and loads nothing.
   *
   * @internal Not part of the stable public API; the default dynamic import is
   * the supported path for consumers.
   */
  readonly loadPdfjs?: () => Promise<PdfjsModule>;
}

/**
 * Default minimum character count for the `no-text-layer` guard.
 *
 * **The value is provisional.** A scanned PDF often yields a handful of stray
 * characters from a header stamp or OCR artefact, so zero is the wrong bar.
 * The specific number is a guess until it has met real scans — what would
 * refine it is a corpus of scanned and text-layer PDFs with known extraction
 * outcomes. Exposed as a named constant and an option so the threshold can be
 * tuned without a code change, following the repo's precedent for shipping
 * provisional defaults with knobs.
 */
export const DEFAULT_NO_TEXT_LAYER_THRESHOLD = 50;
