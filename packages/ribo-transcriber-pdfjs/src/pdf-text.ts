import { TerminalError, UnsupportedItemError } from "@azx/ribo-core";

import { layoutPageText, type PageLayoutOptions } from "./page-layout.js";

import { isPdfTextItem } from "./config.js";
import type { PageRead, PdfDocumentProxy, PdfjsModule } from "./config.js";

/**
 * @file pdf.js text extraction: the lazy import, the page-marker format, the
 * open-handle shape, and the exception mapping.
 *
 * The reference implementation is `pdfToText` in the abode spike
 * (`~/projects/clients/abode/spike/app/app.js`), already run against 15 real
 * PDFs. This module is that plus the contract wrapper and the
 * {@link DEFAULT_NO_TEXT_LAYER_THRESHOLD | no-text-layer} guard.
 */

/**
 * The page-marker prefix. The full marker for page `n` is
 * `` `${PAGE_MARKER}${n} =====\n` ``, numbered from **1**. The markers exist so
 * a value can be attributed to the page it came from — one real report
 * specifies equipment on its Manual S pages and again, differently, on page 24.
 *
 * A downstream prompt is written against this exact form. Do not change it
 * without updating every consumer.
 */
export const PAGE_MARKER = "\n===== PAGE ";

// ---------------------------------------------------------------------------
// Memoized lazy import
// ---------------------------------------------------------------------------

/**
 * The memoized pdf.js module promise. `undefined` until the first call, then a
 * single promise reused across all subsequent calls. The memoization is the
 * whole reason for the dynamic import — pdf.js is ~89 KB gzipped plus a ~387 KB
 * worker, and neither may load for a consumer that never transcribes a document.
 */
let pdfjsPromise: Promise<PdfjsModule> | undefined;

/**
 * Loads pdf.js via a memoized dynamic `import()`, setting the worker URL on
 * first load. The `loadFn` parameter is the injection point for tests; the
 * default lazy-imports `pdfjs-dist`.
 *
 * The worker URL is set once on the first load and reused. In practice there is
 * one worker URL per app (the host serves one worker file), so this is correct.
 */
function loadPdfjs(workerSrc: string, loadFn: () => Promise<PdfjsModule>): Promise<PdfjsModule> {
  pdfjsPromise ??= loadFn().then((m) => {
    m.GlobalWorkerOptions.workerSrc = workerSrc;
    return m;
  });
  return pdfjsPromise;
}

/**
 * Resets the memoized pdf.js promise. Exposed so tests can verify the
 * memoization: call `resetPdfjsCache()` between assertions to force the next
 * load to re-invoke the loader.
 *
 * @internal Not part of the stable public API.
 */
export function resetPdfjsCache(): void {
  pdfjsPromise = undefined;
}

// ---------------------------------------------------------------------------
// Exception mapping
// ---------------------------------------------------------------------------

/**
 * Maps pdf.js's own password / invalid-PDF exceptions to
 * {@link UnsupportedItemError}. **Anything else rethrows unchanged** — that is
 * an attempt failure and the queue owns it. Getting this mapping too greedy is
 * how a transient failure becomes a permanent `dead`.
 *
 * Identification is by `name` rather than `instanceof`: the exceptions come
 * from the dynamically imported module, and the class identities in that
 * module are not the same as any statically imported ones.
 */
function mapPdfException(e: unknown, engine: string): never {
  const name = (e as { name?: string } | null)?.name;
  if (name === "PasswordException") {
    throw new UnsupportedItemError({
      engine,
      reason: "encrypted",
      detail: "The document is password-protected and no password was supplied.",
      cause: e,
    });
  }
  if (name === "InvalidPDFException") {
    throw new UnsupportedItemError({
      engine,
      reason: "unsupported-format",
      detail: "The bytes are not a valid or readable PDF document.",
      cause: e,
    });
  }
  throw e;
}

// ---------------------------------------------------------------------------
// Cancellation (the widen-transcriber-contract plan, Task 4)
// ---------------------------------------------------------------------------

/**
 * The error a cancelled transcription throws. Terminal on purpose: a
 * cancellation is not a failure of the transport, the engine or the item, and
 * retrying it would restart work the caller explicitly withdrew. The same
 * classification the fetch transports and the on-device transcriber use.
 */
function cancellationError(engine: string, when: string, cause?: unknown): TerminalError {
  return new TerminalError(
    `${engine}: document transcription was cancelled ${when} — the caller's AbortSignal ` +
      `fired. A cancelled transcription is never retried.`,
    { cause },
  );
}

/**
 * Await `work`, rejecting with an abort-shaped error the moment `signal` fires
 * (or has already fired), calling `onAbort` synchronously at that moment.
 *
 * The whole point is ordering: pdf.js observes an abort through
 * `destroy()` — which tears down the worker and rejects pending page reads —
 * so `onAbort` (the destroy) must run at abort time, not when some pdf.js
 * promise happens to reject. Without the race, a page read that never settles
 * would hold the sweep forever even though pdf.js was told to stop.
 */
function withAbort<T>(
  signal: AbortSignal | undefined,
  work: Promise<T>,
  onAbort: () => void,
): Promise<T> {
  if (!signal) return work;
  // Abort-shaped for any reader of the reason; always caught by the caller,
  // which maps an aborted signal to `cancellationError` before it escapes.
  let rejectAbort!: (reason: Error) => void;
  const abortPromise = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const onAbortEvent = (): void => {
    onAbort();
    rejectAbort(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
  };
  if (signal.aborted) onAbortEvent();
  else signal.addEventListener("abort", onAbortEvent);
  return Promise.race([work, abortPromise]).finally(() => {
    signal.removeEventListener("abort", onAbortEvent);
  });
}

// ---------------------------------------------------------------------------
// Open-handle shape (D8)
// ---------------------------------------------------------------------------

/**
 * The handle returned by {@link openDocument}. Carries `pageCount` — free the
 * moment the document is open — plus a separate call that reads the marked-up
 * text.
 *
 * **Why this shape and not "return text and page count" (D8).** A
 * `DocumentCapture` requires `pageCount` at enqueue time, and counting pages
 * needs a PDF parser. Without this handle a host loads a second copy of pdf.js
 * to fill in one field, defeating the memoization. With it, a host calls
 * {@link openDocument} to get `pageCount` immediately (no per-page
 * `getTextContent()` sweep), and `transcribe()` calls both `openDocument` and
 * `readText`. That is a smaller API than the alternative, not a bigger one.
 *
 * What reads `pageCount`: a capture UI listing what is queued, the same way
 * `QueuePanel` reads `durationMs` today. It is required rather than optional
 * for the same reason — an absent count and a count of zero must stay
 * distinguishable.
 */
export interface OpenDocumentHandle {
  /** The number of pages in the document, from `doc.numPages`. Free once open. */
  readonly pageCount: number;
  /** Read the full document text with page markers. Does the per-page sweep. */
  readonly readText: () => Promise<string>;
}

export interface OpenDocumentOptions {
  /** The pdf.js worker URL — injected by the consumer (AGENTS.md §5.2). */
  readonly workerSrc: string;
  /** Injected loader for tests. Defaults to a memoized `import("pdfjs-dist")`. */
  readonly loadPdfjs?: () => Promise<PdfjsModule>;
  /** The engine id, stamped onto `UnsupportedItemError` for exception mapping. */
  readonly engine: string;
  /**
   * Thresholds for rebuilding visual reading order from item geometry. Every
   * field is optional and defaulted; see `page-layout.ts` for what each does
   * and why its default is provisional.
   */
  readonly layout?: PageLayoutOptions;
  /**
   * Called after each page is read. Must not throw.
   *
   * {@link readDocumentText} forwards this untouched, and the sweep completes
   * before its `no-text-layer` guard runs — so every page is reported even for
   * a document about to be rejected.
   */
  readonly onPage?: (event: PageRead) => void;
  /**
   * The caller's cancellation signal, from `TranscribeOptions.signal`. Honoured
   * at two points: the document open (an abort destroys the pdf.js loading
   * task) and the top of every page in the sweep (work already loaded stops at
   * the next page boundary). A cancellation rejects with `TerminalError`;
   * see {@link cancellationError}.
   */
  readonly signal?: AbortSignal;
}

/**
 * Opens a PDF over the memoized pdf.js import, yielding {@link OpenDocumentHandle.pageCount | pageCount}
 * immediately plus a {@link OpenDocumentHandle.readText | readText} handle for
 * the full text sweep.
 *
 * The encrypted / invalid-PDF exception mapping lives here so both the
 * capture-path (a host counting pages) and the transcribe-path inherit it — a
 * host enqueuing a document hits it first, and must get an
 * `UnsupportedItemError` rather than a raw pdf.js exception.
 *
 * The signal is honoured (Task 4): an abort calls `loadingTask.destroy()` —
 * pdf.js tears down its worker and rejects pending page reads — and the sweep
 * additionally checks the signal at the top of every page, so work already
 * loaded stops at the next page boundary. Destroy runs on cancellation only;
 * a successful sweep leaves the document open exactly as before, so a handle
 * whose `readText` is called twice keeps working.
 */
export async function openDocument(
  bytes: Blob,
  options: OpenDocumentOptions,
): Promise<OpenDocumentHandle> {
  const { engine, signal } = options;

  // The caller withdrew before the call — load nothing, parse nothing.
  if (signal?.aborted) {
    throw cancellationError(engine, "before the document was opened");
  }

  const pdfjs = await loadPdfjs(
    options.workerSrc,
    options.loadPdfjs ?? (async () => await import("pdfjs-dist")),
  );

  const buf = await bytes.arrayBuffer();
  const loadingTask = pdfjs.getDocument({ data: buf });
  // pdf.js observes the abort through destroy(): it terminates the worker and
  // rejects the pending open and any in-flight page reads. The destroy is
  // idempotent in real pdf.js, so open-phase and sweep-phase wiring can both
  // call it.
  const destroy = (): void => {
    void loadingTask.destroy().catch(() => undefined);
  };

  let doc: PdfDocumentProxy;
  try {
    doc = await withAbort(signal, loadingTask.promise, destroy);
  } catch (e) {
    if (signal?.aborted) {
      throw cancellationError(engine, "while the document was opening", e);
    }
    mapPdfException(e, options.engine);
  }

  return {
    pageCount: doc.numPages,
    readText: async () => {
      try {
        const pages: string[] = [];
        for (let i = 1; i <= doc.numPages; i++) {
          // Between-pages check: work already loaded stops here, before the
          // next page is requested.
          if (signal?.aborted) {
            destroy();
            throw cancellationError(engine, `before page ${i} was read`);
          }
          const page = await withAbort(signal, doc.getPage(i), destroy);
          const content = await withAbort(signal, page.getTextContent(), destroy);
          // Rebuild visual reading order from each item's geometry rather than
          // concatenating in content-stream order. `item.hasEOL` is deliberately
          // NOT used any more: it reports a line break in the drawing order,
          // which on a real invoice put `Subtotal` about a thousand characters
          // from `$70,903.33`. Baseline clustering derives line structure from
          // where the text actually sits, which is the thing hasEOL was standing
          // in for. See `page-layout.ts` for the measurement and the trade-offs.
          const laidOut = layoutPageText(
            // Marked-content boundaries carry no text and no geometry, so they
            // are filtered out rather than defaulted to the page origin.
            content.items.filter(isPdfTextItem).map((it) => ({
              str: it.str,
              x: it.transform[4],
              y: it.transform[5],
              width: it.width,
              height: it.height,
            })),
            options.layout ?? {},
          );
          pages.push(PAGE_MARKER + i + " =====\n" + laidOut + "\n");
          options.onPage?.({
            page: i,
            of: doc.numPages,
            // Counted from the laid-out text before the marker is prepended —
            // the marker is ours; see PageRead.chars for why it must stay out.
            chars: laidOut.replace(/\s/g, "").length,
          });
        }
        return pages.join("");
      } catch (e) {
        // Whatever rejected mid-sweep — a destroy-induced pdf.js rejection, an
        // abort-shaped withAbort rejection, or the between-pages check — if the
        // caller's signal has fired, the caller sees a cancellation, not a raw
        // pdf.js error that `isTransientFailure` would read as retryable.
        if (signal?.aborted) {
          throw cancellationError(engine, "during the page sweep", e);
        }
        throw e;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Full text read with no-text-layer guard
// ---------------------------------------------------------------------------

export interface ReadDocumentTextOptions extends OpenDocumentOptions {
  /** Minimum non-whitespace characters for the no-text-layer guard. */
  readonly noTextLayerThreshold: number;
}

/**
 * Opens a document and reads its full text with page markers, applying the
 * no-text-layer guard. This is the convenience function `transcribe()` uses;
 * a host enqueuing a document uses {@link openDocument} for `pageCount` only.
 *
 * An `onPage` hook is inherited from {@link OpenDocumentOptions} and forwarded
 * untouched, so every page is reported before the guard below can throw.
 *
 * The guard strips page markers and all whitespace, and if what remains is
 * under `noTextLayerThreshold`, throws `UnsupportedItemError` with reason
 * `"no-text-layer"`. A scanned PDF often yields a handful of stray characters
 * from a header stamp, so zero is the wrong bar and any specific number is a
 * guess until it has met real scans.
 */
export async function readDocumentText(
  bytes: Blob,
  options: ReadDocumentTextOptions,
): Promise<{ text: string; pageCount: number }> {
  const handle = await openDocument(bytes, options);
  const text = await handle.readText();

  // Strip page markers and whitespace; what remains is the real text content.
  const stripped = text.replace(/===== PAGE \d+ =====/g, "").replace(/\s/g, "");
  if (stripped.length < options.noTextLayerThreshold) {
    throw new UnsupportedItemError({
      engine: options.engine,
      reason: "no-text-layer",
      detail:
        `The document yielded only ${stripped.length} non-whitespace character` +
        `${stripped.length === 1 ? "" : "s"} ` +
        `(threshold: ${options.noTextLayerThreshold}). ` +
        "A scanned PDF with no OCR layer typically produces a few stray characters from a header stamp.",
    });
  }

  return { text, pageCount: handle.pageCount };
}
