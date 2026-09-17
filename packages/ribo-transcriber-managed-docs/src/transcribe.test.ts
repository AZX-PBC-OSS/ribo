import {
  isTransientFailure,
  TerminalError,
  TranscriberUnavailableError,
  UnsupportedItemError,
  type DocumentCapture,
} from "@azx/ribo-core";
import { describe, expect, test } from "vitest";

import { ManagedDocsTranscriber } from "./index.js";
import { MANAGED_DOCS_ENGINE } from "./config.js";

/**
 * Transcribe tests for the managed docs transcriber. No network, no credential:
 * `fetch` is injected with a double that returns canned responses. The package
 * has no capacity to authenticate, so there is nothing to double beyond the
 * transport. Mirrors `ribo-transcriber-managed/src/transcribe.test.ts`.
 *
 * The failure-mapping tests are the heart of this package's contract — the three
 * failure classes must not be conflated (transcriber.ts). Each test asserts both
 * the error class and the `isTransientFailure` classification, because those two
 * properties together are what the queue and the fallback ladder read.
 */

const ENDPOINT =
  "https://example.invalid/documentintelligence/documentModels/prebuilt-read:analyze";

const DOC: DocumentCapture = {
  id: "doc-001",
  capturedAt: "2026-09-09T12:00:00.000Z",
  kind: "document",
  mimeType: "application/pdf",
  pageCount: 2,
  ctx: {},
};

const BYTES = new Blob(["fake-pdf-bytes"], { type: "application/pdf" });

/** A fetch double that records its call and returns a canned Response. */
function fakeFetch(response: Response): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    // A `Request` has no meaningful string form, so take the URL off whichever
    // member of the union arrived rather than coercing the whole object.
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init: init ?? {} });
    return Promise.resolve(response);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** A successful response body with text content and a table. */
const OK_BODY = {
  pages: [
    {
      pageNumber: 1,
      content: "Invoice Summary",
      tables: [
        {
          rows: [
            [{ text: "Subtotal" }, { text: "$70,903.33" }],
            [{ text: "Tax" }, { text: "$5,600.00" }],
          ],
        },
      ],
    },
    {
      pageNumber: 2,
      content: "Equipment: Heat pump 3-ton.",
    },
  ],
};

describe("ManagedDocsTranscriber — transcribe", () => {
  test("a successful response yields a Transcript with the expected text, recordingId, and engine id", async () => {
    const { fetchImpl } = fakeFetch(Response.json(OK_BODY));
    const t = new ManagedDocsTranscriber({ endpoint: ENDPOINT, fetchImpl });

    const transcript = await t.transcribe(DOC, BYTES);

    expect(transcript.recordingId).toBe("doc-001");
    expect(transcript.engine).toBe(MANAGED_DOCS_ENGINE);
    // Page markers and table separators match pdfjs conventions.
    expect(transcript.text).toContain("\n===== PAGE 1 =====\n");
    expect(transcript.text).toContain("Invoice Summary");
    expect(transcript.text).toContain("Subtotal | $70,903.33");
    expect(transcript.text).toContain("\n===== PAGE 2 =====\n");
    expect(transcript.text).toContain("Equipment: Heat pump 3-ton.");
  });

  test("HTML entities in the response content are decoded to literal characters", async () => {
    // Transcript.text holds rendered text, not escaped markup. A managed document
    // understanding API may return content with HTML entities (e.g. &amp;), so
    // decoding happens at the transcriber before the text reaches the outbox.
    const body = {
      pages: [
        {
          pageNumber: 1,
          content: "Tom &amp; Jerry Plumbing &amp; Heating",
        },
      ],
    };
    const { fetchImpl } = fakeFetch(Response.json(body));
    const t = new ManagedDocsTranscriber({ endpoint: ENDPOINT, fetchImpl });

    const transcript = await t.transcribe(DOC, BYTES);

    expect(transcript.text).toContain("Tom & Jerry Plumbing & Heating");
    expect(transcript.text).not.toContain("&amp;");
  });

  // --- Failure classification: attempt failure ------------------------------------

  test("a 503 throws, and the thrown value is not UnsupportedItemError or TranscriberUnavailableError", async () => {
    // A 503 is an attempt failure, not item unsuitability or a capability
    // failure. Throwing UnsupportedItemError here would permanently kill the
    // item on a transient outage — the exact bug the contract exists to
    // prevent. The queue's backoff owns it, so this must throw plainly and
    // isTransientFailure must read it as retryable.
    const { fetchImpl } = fakeFetch(new Response("Service Unavailable", { status: 503 }));
    const t = new ManagedDocsTranscriber({ endpoint: ENDPOINT, fetchImpl });

    const error = await t.transcribe(DOC, BYTES).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(UnsupportedItemError);
    expect(error).not.toBeInstanceOf(TranscriberUnavailableError);
    expect(isTransientFailure(error)).toBe(true);
  });

  test("a network error (fetch rejects) throws a plain Error, classified as transient", async () => {
    const fetchImpl = (() => Promise.reject(new TypeError("Failed to fetch"))) as typeof fetch;
    const t = new ManagedDocsTranscriber({ endpoint: ENDPOINT, fetchImpl });

    const error = await t.transcribe(DOC, BYTES).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(UnsupportedItemError);
    expect(isTransientFailure(error)).toBe(true);
  });

  test("a 422 without an encrypted code throws a plain error, not UnsupportedItemError", async () => {
    // 422 is ambiguous: it could be a service-side validation issue that is
    // transient. Only an encrypted indicator in the error code maps to item
    // unsuitability; everything else stays an attempt failure.
    const { fetchImpl } = fakeFetch(
      Response.json(
        { error: { code: "InvalidRequest", message: "Something went wrong." } },
        { status: 422 },
      ),
    );
    const t = new ManagedDocsTranscriber({ endpoint: ENDPOINT, fetchImpl });

    const error = await t.transcribe(DOC, BYTES).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(UnsupportedItemError);
    expect(isTransientFailure(error)).toBe(false);
  });

  // --- Failure classification: capability failure ---------------------------------

  test("a 401 throws TranscriberUnavailableError with reason not-configured", async () => {
    const { fetchImpl } = fakeFetch(new Response("Unauthorized", { status: 401 }));
    const t = new ManagedDocsTranscriber({ endpoint: ENDPOINT, fetchImpl });

    const error = await t.transcribe(DOC, BYTES).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TranscriberUnavailableError);
    if (error instanceof TranscriberUnavailableError) {
      expect(error.reason).toBe("not-configured");
    }
  });

  test("a 403 throws TranscriberUnavailableError with reason not-configured", async () => {
    const { fetchImpl } = fakeFetch(new Response("Forbidden", { status: 403 }));
    const t = new ManagedDocsTranscriber({ endpoint: ENDPOINT, fetchImpl });

    const error = await t.transcribe(DOC, BYTES).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TranscriberUnavailableError);
  });

  // --- Failure classification: item unsuitability ---------------------------------

  test("a 415 throws UnsupportedItemError with reason unsupported-format", async () => {
    const { fetchImpl } = fakeFetch(new Response("Unsupported Media Type", { status: 415 }));
    const t = new ManagedDocsTranscriber({ endpoint: ENDPOINT, fetchImpl });

    const error = await t.transcribe(DOC, BYTES).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnsupportedItemError);
    if (error instanceof UnsupportedItemError) {
      expect(error.reason).toBe("unsupported-format");
    }
    expect(isTransientFailure(error)).toBe(false);
  });

  test("a 413 throws UnsupportedItemError with reason unsupported-format (not TerminalError)", async () => {
    // The managed audio transcriber maps 413 to TerminalError (terminal,
    // not routed). Here 413 maps to UnsupportedItemError instead, because this
    // package composes in a fallback ladder: a document too large for the
    // managed service may be within pdf.js's limits.
    const { fetchImpl } = fakeFetch(new Response("Too Large", { status: 413 }));
    const t = new ManagedDocsTranscriber({ endpoint: ENDPOINT, fetchImpl });

    const error = await t.transcribe(DOC, BYTES).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnsupportedItemError);
    if (error instanceof UnsupportedItemError) {
      expect(error.reason).toBe("unsupported-format");
    }
    expect(isTransientFailure(error)).toBe(false);
  });

  test("a 422 with encrypted error code throws UnsupportedItemError with reason encrypted", async () => {
    const { fetchImpl } = fakeFetch(
      Response.json(
        { error: { code: "EncryptedDocument", message: "The document is password-protected." } },
        { status: 422 },
      ),
    );
    const t = new ManagedDocsTranscriber({ endpoint: ENDPOINT, fetchImpl });

    const error = await t.transcribe(DOC, BYTES).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnsupportedItemError);
    if (error instanceof UnsupportedItemError) {
      expect(error.reason).toBe("encrypted");
    }
    expect(isTransientFailure(error)).toBe(false);
  });

  test("a 200 with no extractable text throws UnsupportedItemError with reason no-text-layer", async () => {
    const { fetchImpl } = fakeFetch(Response.json({ pages: [{ pageNumber: 1, content: "  " }] }));
    const t = new ManagedDocsTranscriber({ endpoint: ENDPOINT, fetchImpl });

    const error = await t.transcribe(DOC, BYTES).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnsupportedItemError);
    if (error instanceof UnsupportedItemError) {
      expect(error.reason).toBe("no-text-layer");
    }
    expect(isTransientFailure(error)).toBe(false);
  });

  test("a 200 with empty pages array throws UnsupportedItemError with reason no-text-layer", async () => {
    const { fetchImpl } = fakeFetch(Response.json({ pages: [] }));
    const t = new ManagedDocsTranscriber({ endpoint: ENDPOINT, fetchImpl });

    const error = await t.transcribe(DOC, BYTES).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnsupportedItemError);
    if (error instanceof UnsupportedItemError) {
      expect(error.reason).toBe("no-text-layer");
    }
  });

  // --- Request shape --------------------------------------------------------------

  test("the request URL is the bare endpoint with no /_api/fetch/ prefix", async () => {
    const { fetchImpl, calls } = fakeFetch(Response.json(OK_BODY));
    const t = new ManagedDocsTranscriber({ endpoint: ENDPOINT, fetchImpl });

    await t.transcribe(DOC, BYTES);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(ENDPOINT);
    expect(calls[0]!.url).not.toContain("/_api/fetch/");
  });

  test("no credential appears in the request — no Authorization header", async () => {
    const { fetchImpl, calls } = fakeFetch(Response.json(OK_BODY));
    const t = new ManagedDocsTranscriber({ endpoint: ENDPOINT, fetchImpl });

    await t.transcribe(DOC, BYTES);

    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("authorization")).toBeNull();
  });

  test("the document bytes are sent as the request body", async () => {
    const { fetchImpl, calls } = fakeFetch(Response.json(OK_BODY));
    const t = new ManagedDocsTranscriber({ endpoint: ENDPOINT, fetchImpl });

    await t.transcribe(DOC, BYTES);

    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.body).toBe(BYTES);
  });

  test("Content-Type reflects the document's MIME type", async () => {
    const { fetchImpl, calls } = fakeFetch(Response.json(OK_BODY));
    const t = new ManagedDocsTranscriber({ endpoint: ENDPOINT, fetchImpl });

    await t.transcribe(DOC, BYTES);

    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("content-type")).toBe("application/pdf");
  });

  // --- Missing endpoint at call time ----------------------------------------------

  test("transcribe without an endpoint throws TranscriberUnavailableError", async () => {
    const t = new ManagedDocsTranscriber({});
    const error = await t.transcribe(DOC, BYTES).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TranscriberUnavailableError);
    if (error instanceof TranscriberUnavailableError) {
      expect(error.reason).toBe("not-configured");
    }
  });

  // --- Cancellation — Task 2 of the widen-transcriber-contract plan ---------------
  //
  // Mirrors `ribo-transcriber-managed/src/transcribe.test.ts`. Two properties
  // must hold, and neither may be asserted on "the promise rejected": the
  // transport must OBSERVE the caller's signal (by identity, and by actually
  // being torn down by it), and a cancellation must be classified terminal so
  // the queue does not burn its retry budget re-running work the caller withdrew.

  test("the caller's signal reaches the fetch init — by identity", async () => {
    const { fetchImpl, calls } = fakeFetch(Response.json(OK_BODY));
    const t = new ManagedDocsTranscriber({ endpoint: ENDPOINT, fetchImpl });
    const controller = new AbortController();

    await t.transcribe(DOC, BYTES, { signal: controller.signal });

    expect(calls[0]!.init.signal).toBe(controller.signal);
  });

  test("aborting mid-flight aborts the in-flight request — the transport observed the abort, and the rejection is terminal", async () => {
    // A fetch double with REAL abort semantics: it rejects only when the signal
    // it was handed fires. If the implementation stops forwarding the signal,
    // this promise never settles and the test times out — a hung test IS the
    // observation that the transport never saw the abort. An implementation that
    // forwards the signal but not the classification fails the assertions below.
    let observed: AbortSignal | undefined;
    const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) => {
      observed = init?.signal ?? undefined;
      return new Promise<Response>((_, reject) => {
        observed?.addEventListener("abort", () =>
          reject(new DOMException("This operation was aborted", "AbortError")),
        );
      });
    }) as typeof fetch;
    const t = new ManagedDocsTranscriber({ endpoint: ENDPOINT, fetchImpl });
    const controller = new AbortController();

    const pending = t.transcribe(DOC, BYTES, { signal: controller.signal });
    controller.abort();
    const error = await pending.catch((e: unknown) => e);

    // The transport observed the abort, not merely a rejection.
    expect(observed?.aborted).toBe(true);
    // ...and the classification: terminal, so the queue does not retry a
    // cancelled transcription the way it retries a flaky network.
    expect(error).toBeInstanceOf(TerminalError);
    expect(isTransientFailure(error)).toBe(false);
  });

  test("an already-aborted signal cancels before the request is sent", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return Response.json(OK_BODY);
    }) as typeof fetch;
    const t = new ManagedDocsTranscriber({ endpoint: ENDPOINT, fetchImpl });
    const controller = new AbortController();
    controller.abort();

    const error = await t
      .transcribe(DOC, BYTES, { signal: controller.signal })
      .catch((e: unknown) => e);

    // The caller withdrew before the call — nothing may reach the network.
    expect(calls).toBe(0);
    expect(error).toBeInstanceOf(TerminalError);
  });

  test("a genuine network failure stays retryable — the cancellation path must not swallow it", async () => {
    const fetchImpl = (() => Promise.reject(new TypeError("Failed to fetch"))) as typeof fetch;
    const t = new ManagedDocsTranscriber({ endpoint: ENDPOINT, fetchImpl });

    const error = await t
      .transcribe(DOC, BYTES, { signal: new AbortController().signal })
      .catch((e: unknown) => e);

    expect(error).not.toBeInstanceOf(TerminalError);
    expect(isTransientFailure(error)).toBe(true);
  });
});
