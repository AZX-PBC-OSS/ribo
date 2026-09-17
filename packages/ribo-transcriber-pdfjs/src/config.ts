/**
 * @file Configuration for the pdf.js document transcriber.
 *
 * The engine id and the options interface live here so `index.ts` can
 * stay focused on the class. The engine id is a published constant — it rides
 * into every `Transcript.engine` this package produces and into the storage
 * document, so a rename is a migration, not a refactor (see `transcript.ts`).
 */

/**
 * `Transcriber.engine` this implementation stamps onto every `Transcript` it
 * produces. Short and stable across versions — it is persisted data, readable
 * straight off `storage.captures.list()`. See D8 in the document-transcription plan.
 */
export const PDFJS_ENGINE = "pdfjs";

/**
 * The handle `pdfjs.getDocument(params)` returns — pdf.js's `PDFDocumentLoadingTask`,
 * narrowed to the members this package uses.
 *
 * `destroy` is the transport's cancellation lever (the widen-transcriber-contract
 * plan, Task 4): it terminates pdf.js's worker and rejects the pending `promise`
 * and any in-flight page reads. It was previously absent from this shim — the real
 * module has always had it — which is why cancellation could not be wired here
 * before. Real pdf.js's task carries many more members; anything else stays
 * undeclared.
 */
export interface PdfLoadingTask {
  /** Resolves to the document proxy, or rejects when destroyed or invalid. */
  promise: Promise<PdfDocumentProxy>;
  /** Terminate the worker and reject pending work. Idempotent in real pdf.js. */
  destroy: () => Promise<void>;
}

/**
 * The subset of the `pdfjs-dist` module API this package consumes.
 *
 * Defined here rather than imported from `pdfjs-dist` types so the lazy
 * `import()` in Task 6 can be typed without pulling the full type tree into
 * the options interface. The real module has many more exports; we use only
 * `getDocument` and `GlobalWorkerOptions`.
 */
export interface PdfjsModule {
  getDocument: (params: Record<string, unknown>) => PdfLoadingTask;
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
  getTextContent: () => Promise<{ items: readonly PdfContentItem[] }>;
}

/**
 * A PDF text-space transformation matrix, exactly six numbers.
 *
 * The PDF and canvas specs call these `[a, b, c, d, e, f]`, which is what you
 * will see in pdf.js's own source and in the spec — but those names say nothing
 * at a call site, so the tuple labels them by what they do. The mapping, for
 * anyone cross-referencing:
 *
 * ```
 * a = scaleX   b = skewY    ⎡ a  b  0 ⎤     x′ = a·x + c·y + e
 * c = skewX    d = scaleY   ⎢ c  d  0 ⎥     y′ = b·x + d·y + f
 * e = translateX  f = translateY  ⎣ e  f  1 ⎦
 * ```
 *
 * `page-layout.ts` reads only the translation — the item's origin, `[4]`
 * horizontally and `[5]` on the baseline — which now reads as `translateX` and
 * `translateY` in a tooltip rather than as two anonymous numbers.
 *
 * A **labelled tuple** rather than `number[]`, for a reason that bites under
 * this repo's `noUncheckedIndexedAccess`: indexing an array yields
 * `number | undefined`, so every read needs a defensive `?? 0` that can never
 * fire. A fixed-length tuple has known indices, so `transform[4]` is plainly
 * `number`, and passing five numbers is a compile error. Both verified against
 * TypeScript 6.0.3 with this repo's flags.
 */
export type PdfTransformMatrix = readonly [
  scaleX: number,
  skewY: number,
  skewX: number,
  scaleY: number,
  translateX: number,
  translateY: number,
];

/**
 * A run of text with its placement.
 *
 * **The geometry is the important part.** pdf.js emits items in content-stream
 * order, which is not visual order, so `str` alone is not enough to reconstruct
 * a page — `transform`'s translation plus `width` are what let baseline
 * clustering rebuild rows. See `page-layout.ts` for the measurement.
 *
 * Every field is **required**: pdf.js supplies all of them on a text item, and
 * an optional one here would only be modelling the *other* branch of
 * {@link PdfContentItem}, which is what {@link isPdfTextItem} is for.
 *
 * `hasEOL` signals a line break in the **drawing** order. It is no longer read —
 * geometry supersedes it, and on a real invoice it was actively misleading — but
 * it stays on the interface because pdf.js returns it, and omitting a field the
 * runtime provides would make this a lie about the shape rather than a subset
 * of it.
 */
export interface PdfTextItem {
  str: string;
  hasEOL: boolean;
  transform: PdfTransformMatrix;
  width: number;
  height: number;
}

/**
 * The other thing `getTextContent().items` yields: a structure-tag boundary,
 * carrying no text and no geometry.
 */
export interface PdfMarkedContentItem {
  type: string;
  id?: string | null;
}

/**
 * One entry from `getTextContent().items` — **a union, because pdf.js returns
 * two different shapes.**
 *
 * Modelling this as a single interface with optional geometry was the
 * expedient thing and it was wrong: it pushed a `?? 0` onto every read, and a
 * marked-content boundary then mapped to `{ str: "", x: 0, y: 0 }` — a
 * fabricated item at the page origin that survived only because a later
 * whitespace filter happened to drop it. Discriminating instead means the
 * defaults disappear and nothing invents coordinates it does not have.
 */
export type PdfContentItem = PdfTextItem | PdfMarkedContentItem;

/**
 * Narrow a content item to a text run.
 *
 * Discriminates on `str` rather than on `type`, because `type` is present only
 * on the marked-content branch — testing for its **absence** would make every
 * future pdf.js item shape default to "this is text", which is the failure
 * direction that hurts.
 */
export function isPdfTextItem(item: PdfContentItem): item is PdfTextItem {
  return typeof (item as PdfTextItem).str === "string";
}

/**
 * One page of a document sweep, as reported to the `onPage` hooks.
 *
 * `chars` counts the laid-out page text with whitespace stripped, **excluding
 * the page marker** this library prepends. The marker is ours: counting it
 * would floor every page at a non-zero number and destroy the exact signal the
 * field exists for — a scanned insert in an otherwise text-layer PDF shows up
 * as a run of **zero**-character pages, worth surfacing before the
 * whole-document `no-text-layer` threshold decides.
 */
export interface PageRead {
  /** The 1-based page number just read. */
  readonly page: number;
  /** Total pages in the document — free once open, known before the sweep starts. */
  readonly of: number;
  /** Non-whitespace characters this page yielded, excluding the page marker. */
  readonly chars: number;
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
   * Called after each page is read. Must not throw.
   *
   * `@azx/ribo-transcriber-managed-docs` deliberately has no parallel hook: it
   * is one HTTP call returning every page at once, so it has no per-page loop
   * to observe.
   */
  readonly onPage?: (event: PageRead) => void;

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
