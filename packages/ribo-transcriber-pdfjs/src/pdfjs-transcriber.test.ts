import { isPermanentlyUnavailable, isTransientFailure, TerminalError } from "@azx/ribo-core";
import type { DocumentCapture } from "@azx/ribo-core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { PdfjsTranscriber, resetPdfjsCache } from "./index.js";
import { PDFJS_ENGINE } from "./config.js";
import type { PdfDocumentProxy, PdfjsModule } from "./config.js";

/**
 * Capability tests for the pdf.js transcriber — the Task 5 must-fail tests from
 * `docs/roadmap/design/document-transcription-plan.md`.
 *
 * These run as unit (node) tests. `Worker` is not a global in Node, so the
 * tests that exercise the `not-configured` and `ready` paths stub it via
 * `vi.stubGlobal`. The `capability()` method itself only checks
 * `typeof Worker` — it never constructs one — so a class stub is sufficient.
 *
 * `capability()` must not load pdf.js. The contract says it is called often and
 * expected to be cheap, so a probe that quietly pulls in ~89 KB is the failure
 * the "does not load" test exists for. The transcriber accepts an internal
 * `loadPdfjs` injection point; the test injects a counting loader and asserts
 * the count stays at zero across many capability() calls.
 */

const FAKE_WORKER_SRC = "https://example.com/pdf.worker.min.mjs";

beforeEach(() => {
  // `Worker` exists in a browser but not in Node. Stub it so capability()'s
  // `typeof Worker` check passes, exercising the not-configured / ready paths.
  vi.stubGlobal("Worker", class MockWorker {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PdfjsTranscriber — capability", () => {
  test("a missing worker URL yields not-configured, and isPermanentlyUnavailable is false for it", async () => {
    const t = new PdfjsTranscriber({});
    const cap = await t.capability();

    expect(cap.status).toBe("unavailable");
    if (cap.status === "unavailable") {
      expect(cap.reason).toBe("not-configured");
    }
    // A missing worker URL is a situation, not a fact about the hardware — a
    // host may supply one later, so capability should be re-probed.
    expect(isPermanentlyUnavailable(cap)).toBe(false);
  });

  test("a configured worker URL yields ready", async () => {
    const t = new PdfjsTranscriber({ workerSrc: FAKE_WORKER_SRC });
    const cap = await t.capability();

    expect(cap.status).toBe("ready");
  });

  test("capability() does not load pdf.js", async () => {
    // The contract says capability() is called often and expected to be cheap.
    // A probe that quietly pulls in 89 KB is the failure this test exists for.
    // Inject a counting loader and assert the count stays at zero.
    let loadCount = 0;
    const fakeModule: PdfjsModule = {
      getDocument: () => ({
        promise: Promise.resolve({} as never),
        destroy: () => Promise.resolve(),
      }),
      GlobalWorkerOptions: { workerSrc: "" },
    };
    const t = new PdfjsTranscriber({
      workerSrc: FAKE_WORKER_SRC,
      loadPdfjs: () => {
        loadCount++;
        return Promise.resolve(fakeModule);
      },
    });

    // Call capability many times — it should be cheap and load nothing.
    for (let i = 0; i < 10; i++) {
      await t.capability();
    }
    expect(loadCount).toBe(0);
  });

  test("no Worker global yields unsupported-platform, which is permanent", async () => {
    vi.unstubAllGlobals();

    const t = new PdfjsTranscriber({ workerSrc: FAKE_WORKER_SRC });
    const cap = await t.capability();

    expect(cap.status).toBe("unavailable");
    if (cap.status === "unavailable") {
      expect(cap.reason).toBe("unsupported-platform");
    }
    // No Worker constructor is a permanent fact about the platform, not a
    // situation — correctly permanent.
    expect(isPermanentlyUnavailable(cap)).toBe(true);
  });

  test("the engine id is exactly pdfjs", () => {
    // The literal is asserted because it is persisted data — it rides into
    // every Transcript.engine this package produces and into the outbox
    // document. A rename is a migration, not a refactor.
    const t = new PdfjsTranscriber({});
    expect(t.engine).toBe("pdfjs");
    expect(PDFJS_ENGINE).toBe("pdfjs");
  });
});

describe("PdfjsTranscriber — entity decoding", () => {
  test("HTML entities in the PDF text layer are decoded to literal characters", async () => {
    // Transcript.text holds rendered text, not escaped markup. A PDF whose text
    // layer contains &amp; (common in PDFs generated from HTML) must arrive in
    // the outbox as & so a model quoting & does not fail the grounding check.
    const doc: PdfDocumentProxy = {
      numPages: 1,
      getPage: () =>
        Promise.resolve({
          getTextContent: () =>
            Promise.resolve({
              items: [
                {
                  str: "Tom &amp; Jerry Plumbing",
                  hasEOL: true,
                  transform: [1, 0, 0, 1, 0, 700],
                  width: 200,
                  height: 10,
                },
              ],
            }),
        }),
    } as unknown as PdfDocumentProxy;

    const fakeModule: PdfjsModule = {
      getDocument: () => ({ promise: Promise.resolve(doc), destroy: () => Promise.resolve() }),
      GlobalWorkerOptions: { workerSrc: "" },
    };

    const t = new PdfjsTranscriber({
      workerSrc: FAKE_WORKER_SRC,
      noTextLayerThreshold: 0,
      loadPdfjs: () => Promise.resolve(fakeModule),
    });

    const capture: DocumentCapture = {
      id: "doc-1",
      capturedAt: "2026-09-11T10:00:00.000Z",
      kind: "document",
      mimeType: "application/pdf",
      pageCount: 1,
      ctx: {},
    };

    const transcript = await t.transcribe(capture, new Blob([new Uint8Array(0)]));

    expect(transcript.text).toContain("Tom & Jerry Plumbing");
    expect(transcript.text).not.toContain("&amp;");
  });
});

// ── Cancellation (widen-transcriber-contract plan, Task 4) ────────────────────
//
// pdf.js offers a real cancellation lever — `loadingTask.destroy()` — so the
// shim now exposes it and the signal is wired to it. The assertions are on what
// pdf.js OBSERVED (which pages were requested, that destroy was called), not
// merely on the promise rejecting, and on the classification: a cancellation is
// terminal, so the queue does not burn its retry budget.
describe("PdfjsTranscriber — cancellation", () => {
  // The memoized pdf.js import is module-level: without this, these tests
  // would sweep the entity-decoding test's fake document, whose getPage
  // records nothing — and the assertions would pass or fail for the wrong
  // reason entirely.
  beforeEach(() => {
    resetPdfjsCache();
  });

  /** A deferred — a promise the test resolves on its own schedule. */
  function makeDeferred<T>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
  } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  interface Harness {
    readonly transcriber: PdfjsTranscriber;
    readonly pageCalls: number[];
    readonly destroyCalls: number;
    /** Release page 1's held read — with the real page proxy, not a bare stub. */
    readonly resolvePage1: () => void;
  }

  /** A 3-page fake document whose page-1 read is held on a deferred, with a recording
   * loading task. `getPage` and `destroy` record what pdf.js observed. `onAbortBetweenPages`
   * runs inside the `onPage(1)` hook — the exact synchronous gap between page 1 completing
   * and page 2 being requested. */
  function makeHarness(onAbortBetweenPages?: () => void): Harness {
    const pageCalls: number[] = [];
    let destroyCalls = 0;
    const pageProxy = {
      getTextContent: () =>
        Promise.resolve({
          items: [
            {
              str: "page text",
              hasEOL: false,
              transform: [1, 0, 0, 1, 0, 700],
              width: 200,
              height: 10,
            },
          ],
        }),
    };
    const page1 = makeDeferred<typeof pageProxy>();
    const doc: PdfDocumentProxy = {
      numPages: 3,
      getPage: (n: number) => {
        pageCalls.push(n);
        return n === 1 ? (page1.promise as Promise<never>) : Promise.resolve(pageProxy as never);
      },
    };
    const fakeModule: PdfjsModule = {
      getDocument: () => ({
        promise: Promise.resolve(doc),
        destroy: () => {
          destroyCalls++;
          return Promise.resolve();
        },
      }),
      GlobalWorkerOptions: { workerSrc: "" },
    };
    const transcriber = new PdfjsTranscriber({
      workerSrc: FAKE_WORKER_SRC,
      noTextLayerThreshold: 0,
      loadPdfjs: () => Promise.resolve(fakeModule),
      onPage: (event) => {
        if (event.page === 1) onAbortBetweenPages?.();
      },
    });
    return {
      transcriber,
      pageCalls,
      get destroyCalls(): number {
        return destroyCalls;
      },
      resolvePage1: () => page1.resolve(pageProxy),
    };
  }

  const capture: DocumentCapture = {
    id: "doc-cancel",
    capturedAt: "2026-09-15T10:00:00.000Z",
    kind: "document",
    mimeType: "application/pdf",
    pageCount: 3,
    ctx: {},
  };

  test("an abort while a page read is in flight destroys the loading task and rejects as terminal", async () => {
    const h = makeHarness();
    const controller = new AbortController();

    const pending = h.transcriber.transcribe(capture, new Blob([new Uint8Array(0)]), {
      signal: controller.signal,
    });
    // Wait until page 1's read is genuinely in flight, then abort — the sweep is
    // parked on `getPage(1)`, so this exercises the destroy wiring: pdf.js must
    // be told to stop while a read is outstanding.
    await vi.waitFor(() => expect(h.pageCalls).toEqual([1]));
    controller.abort();
    h.resolvePage1();

    const error = await pending.catch((e: unknown) => e);

    // pdf.js observed exactly one page request — pages 2 and 3 never ran.
    expect(h.pageCalls).toEqual([1]);
    // pdf.js observed the destroy — the loading task was torn down, not left open.
    expect(h.destroyCalls).toBe(1);
    // And the classification: terminal, so the queue does not retry a cancelled
    // transcription the way it retries a flaky network.
    expect(error).toBeInstanceOf(TerminalError);
    expect(isTransientFailure(error)).toBe(false);
  });

  test("an abort between pages stops the sweep before the next page is requested", async () => {
    // The abort fires inside the onPage(1) hook — the synchronous gap between
    // page 1 completing and page 2 being requested — so this isolates the
    // between-pages check from the destroy wiring: with the check removed, the
    // loop still calls getPage(2) (which the abort race then discards) and
    // pageCalls records it.
    const h = makeHarness(() => controller.abort());
    const controller = new AbortController();

    const pending = h.transcriber.transcribe(capture, new Blob([new Uint8Array(0)]), {
      signal: controller.signal,
    });
    h.resolvePage1();
    const error = await pending.catch((e: unknown) => e);

    // Page 2 was never requested — the sweep stopped at the page boundary.
    expect(h.pageCalls).toEqual([1]);
    expect(h.destroyCalls).toBe(1);
    expect(error).toBeInstanceOf(TerminalError);
    expect(isTransientFailure(error)).toBe(false);
  });

  test("an already-aborted signal never opens the document", async () => {
    const h = makeHarness();
    const controller = new AbortController();
    controller.abort();

    const error = await h.transcriber
      .transcribe(capture, new Blob([new Uint8Array(0)]), { signal: controller.signal })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TerminalError);
    expect(h.pageCalls).toEqual([]);
  });

  test("without an abort the sweep completes as before — destroy is not called on success", async () => {
    // Pins the non-regression: a cancellation must not change the lifecycle for
    // a sweep that finishes, including a handle whose readText is called twice.
    const h = makeHarness();

    const pending = h.transcriber.transcribe(capture, new Blob([new Uint8Array(0)]));
    h.resolvePage1();
    const transcript = await pending;

    expect(h.pageCalls).toEqual([1, 2, 3]);
    expect(h.destroyCalls).toBe(0);
    expect(transcript.engine).toBe(PDFJS_ENGINE);
  });
});
