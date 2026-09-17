/**
 * @file The transcribe request path for {@link ManagedDocsTranscriber}.
 *
 * POST the document bytes to the managed document analysis endpoint through the
 * injected `fetch`, and map the response onto a {@link Transcript}. The response
 * is flattened into text by `response.ts`, using page markers and table
 * separators that match `@azx/ribo-transcriber-pdfjs`'s conventions.
 *
 * **The URL is the configured endpoint as-is.** The package does not prefix
 * `/_api/fetch/` — routing is the host transport's job. This mirrors
 * `ribo-transcriber-managed/src/transcribe.ts` exactly.
 *
 * ## Failure classification — the point of this task
 *
 * Three failure classes exist and conflating them is the bug the `Transcriber`
 * contract exists to prevent (`transcriber.ts`). The line drawn here:
 *
 * - **5xx, network error, malformed body → attempt failure.** Throw plainly
 *   (with HTTP `status` attached for non-2xx) so `isTransientFailure` can
 *   classify it (5xx → retryable, 4xx → dead). These must **not** be
 *   {@link UnsupportedItemError}, because a transient outage would then
 *   permanently kill the item — getting the third class too greedy turns a
 *   transient outage into a permanent `dead`.
 *
 * - **401 / 403 → capability failure.** The credential is missing or wrong and
 *   the host can fix it. Throw {@link TranscriberUnavailableError} with reason
 *   `not-configured`, mirroring the managed audio transcriber.
 *
 * - **415, 413, encrypted error, no text → item unsuitability.** The service is
 *   rejecting *this document* for a property of the document itself — its
 *   format, its size, its encryption, or its lack of extractable text. These
 *   will not change on retry and are specific to this document, so they throw
 *   {@link UnsupportedItemError} and route the fallback ladder to the next
 *   engine (pdf.js). Getting this too narrow burns the retry budget on a
 *   document the managed service can never read.
 *
 * The specific conditions mapping to `UnsupportedItemError`:
 *
 * | Condition                          | Reason              | Why item, not attempt |
 * | ---------------------------------- | ------------------- | --------------------- |
 * | 415 Unsupported Media Type         | `unsupported-format` | Service says it can't read this format; retry sends the same bytes. |
 * | 413 Payload Too Large              | `unsupported-format` | Document's size is a property of the item; retry sends the same size. |
 * | 4xx with `error.code` containing "encrypt"/"password" | `encrypted` | Password-protected document; retry without a password is futile. |
 * | 200, no extractable text           | `no-text-layer`     | Service processed it but found nothing; mirrors pdf.js's guard. |
 *
 * Everything else — 400 without an encrypted code, 404, 406, 422 without an
 * encrypted code, 429, 5xx — is an attempt failure. The line is deliberately
 * conservative on the 4xx side: a 422 without a clear encrypted indicator stays
 * an attempt failure, because 422 is ambiguous and mapping it to
 * `UnsupportedItemError` would let a service-side validation bug permanently
 * kill an item that pdf.js might read fine. Only conditions where the service
 * explicitly names a document property (format, size, encryption) or where the
 * 200 response demonstrably has no text map to item unsuitability.
 *
 * - **The caller's signal aborted → cancellation, terminal.** The signal is
 *   forwarded into the fetch init, so an abort tears down the in-flight HTTP
 *   request. The rejection is rethrown as a `TerminalError` — a cancelled
 *   transcription is the caller withdrawing the work, and the queue must not
 *   spend its retry budget re-running it. Without this, an abort reads to
 *   `isTransientFailure` exactly like a flaky network (an error with no
 *   `status` defaults to retryable) and the item is re-sent until `dead` for
 *   the worst possible reason. Mirrors `ribo-transcriber-managed`.
 *
 * Contrast the managed audio transcriber, which maps 413 to
 * `TerminalError` (terminal, not routed to a next engine). Here 413 maps
 * to `UnsupportedItemError` instead, because this package composes in a
 * fallback ladder: a document too large for the managed service may be within
 * pdf.js's limits, so the ladder should try the next rung rather than give up.
 */
import {
  TranscriberUnavailableError,
  TerminalError,
  UnsupportedItemError,
  decodeEntities,
} from "@azx/ribo-core";
import type { DocumentCapture, Transcript } from "@azx/ribo-core";

import {
  flattenDocumentAnalysisResponse,
  isEncryptedError,
  stripMarkersAndWhitespace,
  type DocumentAnalysisErrorBody,
  type DocumentAnalysisResponse,
} from "./response.js";

/** Inputs for {@link transcribeViaManagedDocs} — supplied by the class. */
export interface TranscribeViaManagedDocsOptions {
  /** The document analysis endpoint URL. */
  readonly endpoint: string;
  /** The injected `fetch` — the host's transport, credential-attaching or not. */
  readonly doFetch: typeof fetch;
  /** `Transcriber.engine` — stamped onto the resulting `Transcript.engine`. */
  readonly engine: string;
  /**
   * The caller's cancellation signal, from `TranscribeOptions.signal`. Forwarded
   * into the fetch request init — an abort tears down the in-flight HTTP
   * request — and checked before the request is sent, so an already-aborted
   * signal never reaches the network at all. A cancellation rejects with
   * `TerminalError`; see the failure-classification table above.
   */
  readonly signal?: AbortSignal;
}

/**
 * Is this fetch rejection a cancellation rather than a transport failure?
 *
 * Two observations, either of which settles it: the caller's own signal has
 * aborted (the authoritative fact — whoever aborted withdrew the work), or the
 * rejection itself is abort-shaped (`name === "AbortError"`, what a real
 * `fetch` rejects with when its signal fires). Checked in that order, so an
 * injected fetch that rejects abort-shaped is honoured even if the signal
 * snapshot raced. Mirrors `ribo-transcriber-managed/src/transcribe.ts`.
 */
function isAbortRejection(cause: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true;
  return (cause as { name?: string } | null | undefined)?.name === "AbortError";
}

/**
 * The error a cancelled transcription throws. Terminal on purpose: a
 * cancellation is not a failure of the transport, the engine or the item, and
 * retrying it would restart work the caller explicitly withdrew.
 */
function cancellationError(engine: string, endpoint: string, cause: unknown): TerminalError {
  return new TerminalError(
    `${engine}: the transcription request to ${endpoint} was cancelled by the caller's ` +
      `AbortSignal — a cancelled transcription is never retried.`,
    { cause },
  );
}

/**
 * Send the document bytes to the document analysis endpoint and map the
 * response.
 *
 * The package adds **no credential** to the request — no `Authorization` header,
 * no API key. Whatever auth the call needs is the transport's responsibility.
 * The document bytes are sent as the raw request body with the capture's MIME
 * type as `Content-Type`, so the service can identify the document format.
 */
export async function transcribeViaManagedDocs(
  item: DocumentCapture,
  bytes: Blob,
  options: TranscribeViaManagedDocsOptions,
): Promise<Transcript> {
  const { endpoint, doFetch, engine, signal } = options;

  // An already-aborted signal means the caller withdrew before this call —
  // start nothing, touch no network.
  if (signal?.aborted) {
    throw cancellationError(engine, endpoint, undefined);
  }

  let response: Response;
  try {
    response = await doFetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": bytes.type || "application/octet-stream" },
      body: bytes,
      signal,
    });
  } catch (cause) {
    // The caller's signal fired — a deliberate cancellation, not a transport
    // failure. Terminal, so the queue does not burn its retry budget re-running
    // work the caller withdrew. Mirrors `ribo-transcriber-managed`.
    if (isAbortRejection(cause, signal)) {
      throw cancellationError(engine, endpoint, cause);
    }
    throw new Error(
      `${engine}: request to ${endpoint} failed: ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }

  // 401 / 403 — the credential is missing or wrong. A capability failure the
  // host can fix: throw TranscriberUnavailableError with not-configured so
  // firstCapable demotes the engine and the next attempt re-probes.
  if (response.status === 401 || response.status === 403) {
    throw new TranscriberUnavailableError({
      engine,
      reason: "not-configured",
      detail: `Document analysis endpoint returned ${response.status} — the credential is missing or wrong.`,
    });
  }

  // 415 — the service cannot process this document format. Item unsuitability:
  // retrying sends the same bytes in the same format.
  if (response.status === 415) {
    throw new UnsupportedItemError({
      engine,
      reason: "unsupported-format",
      detail: `The document was rejected as unsupported format (415) by ${endpoint}.`,
    });
  }

  // 413 — the document is too large for this service. Item unsuitability, not a
  // terminal queue error: in a fallback ladder, pdf.js may handle the size the
  // managed service refused.
  if (response.status === 413) {
    throw new UnsupportedItemError({
      engine,
      reason: "unsupported-format",
      detail: `The document (${bytes.size} bytes) was rejected as too large (413) by ${endpoint}.`,
    });
  }

  // Any other non-2xx — check for encrypted indicator first, then attempt
  // failure. The encrypted check is deliberately narrow: only an error code
  // containing "encrypt" or "password" maps to UnsupportedItemError. Everything
  // else (400, 404, 406, 422 without encrypted code, 429, 5xx) is an attempt
  // failure, because these are ambiguous or transient.
  if (!response.ok) {
    const errorDetail = await response.text().catch(() => "");
    let parsedError: DocumentAnalysisErrorBody | undefined;
    try {
      parsedError = JSON.parse(errorDetail) as DocumentAnalysisErrorBody;
    } catch {
      // Not JSON — treat as plain attempt failure below.
    }

    if (parsedError && isEncryptedError(parsedError)) {
      throw new UnsupportedItemError({
        engine,
        reason: "encrypted",
        detail: `The document is password-protected: ${parsedError.error?.message ?? errorDetail.slice(0, 500)}`,
      });
    }

    throw Object.assign(
      new Error(
        `${engine}: ${response.status} ${response.statusText} from ${endpoint}` +
          (errorDetail ? `: ${errorDetail.slice(0, 500)}` : ""),
      ),
      { status: response.status },
    );
  }

  // Parse the response body. A malformed body is an attempt failure — throw
  // plainly (no status) so isTransientFailure reads it as retryable.
  let body: DocumentAnalysisResponse;
  try {
    body = (await response.json()) as DocumentAnalysisResponse;
  } catch (cause) {
    throw new Error(`${engine}: response from ${endpoint} was not valid JSON`, {
      cause,
    });
  }

  const text = flattenDocumentAnalysisResponse(body);

  // No-text-layer guard: if the service processed the document (200) but yielded
  // no extractable text, the document is a scanned image or similar. This
  // mirrors pdf.js's guard and routes the ladder to the next engine.
  if (stripMarkersAndWhitespace(text).length === 0) {
    throw new UnsupportedItemError({
      engine,
      reason: "no-text-layer",
      detail: `The document analysis service returned no extractable text for this document.`,
    });
  }

  return {
    recordingId: item.id,
    text: decodeEntities(text),
    engine,
  };
}
