/**
 * @file The public surface of `@azx/ribo-transcriber-managed-docs`.
 *
 * Managed document transcription: a hosted document understanding API behind the
 * host's transport. It implements `@azx/ribo-core`'s `Transcriber<DocumentCapture>`
 * seam with engine id `managed-docs`, and composes through `fallbackTranscriber`
 * alongside `@azx/ribo-transcriber-pdfjs` with no core changes.
 *
 * **The package has no capacity to authenticate.** It takes the document analysis
 * endpoint and an injected `fetch`, and knows nothing about how the call is routed.
 * Connectivity is injected as a predicate too. See {@link ManagedDocsTranscriberOptions}
 * for the full constraint. This mirrors `ribo-transcriber-managed` exactly — read
 * its `config.ts` and `index.ts` for the pattern this package copies.
 */
import { TranscriberUnavailableError } from "@azx/ribo-core";
import type {
  DocumentCapture,
  Transcript,
  Transcriber,
  TranscriberCapability,
  TranscribeOptions,
} from "@azx/ribo-core";

import { MANAGED_DOCS_ENGINE, type ManagedDocsTranscriberOptions } from "./config.js";
import { transcribeViaManagedDocs } from "./transcribe.js";

export { MANAGED_DOCS_ENGINE } from "./config.js";
export type { ManagedDocsTranscriberOptions } from "./config.js";
export {
  flattenDocumentAnalysisResponse,
  isEncryptedError,
  stripMarkersAndWhitespace,
} from "./response.js";
export type {
  DocumentAnalysisCell,
  DocumentAnalysisErrorBody,
  DocumentAnalysisPage,
  DocumentAnalysisResponse,
  DocumentAnalysisTable,
} from "./response.js";

/**
 * Managed document transcription, implementing `Transcriber<DocumentCapture>`.
 *
 * ## Capability
 *
 * Maps onto reasons that already exist in `ribo-core`'s `transcriber.ts`,
 * mirroring `ManagedTranscriber`:
 *
 * - A missing endpoint or transport yields `not-configured` — the host may supply
 *   one later, so the failure is **not** permanent.
 * - A connectivity predicate reporting down yields `offline` — also a situation,
 *   not a fact about the hardware, so also **not** permanent.
 * - Otherwise `ready`.
 *
 * ## Transcription
 *
 * {@link transcribe} POSTs the document bytes to the endpoint through the
 * injected `fetch`, and maps the response onto a `Transcript` whose `engine` is
 * `managed-docs`. The response is flattened into text with page markers and table
 * separators matching pdf.js conventions. See `transcribe.ts` for the
 * request path and failure classification — the split keeps this file focused
 * on the class and its capability reporting.
 *
 * ## Cancellation
 *
 * The signal is **honoured**: `TranscribeOptions.signal` is forwarded into the
 * fetch request init, so an abort tears down the in-flight HTTP request, and an
 * already-aborted signal cancels before the request is sent. A cancellation
 * rejects with `TerminalQueueError` rather than an abort error, so the queue
 * does not mistake it for a flaky network and burn the retry budget — see
 * `transcribe.ts` for the full classification. Mirrors `ManagedTranscriber`.
 */
export class ManagedDocsTranscriber implements Transcriber<DocumentCapture> {
  readonly engine = MANAGED_DOCS_ENGINE;

  readonly #endpoint?: string;
  readonly #doFetch?: typeof fetch;
  readonly #isOnline: () => boolean;

  constructor(options: ManagedDocsTranscriberOptions = {}) {
    this.#endpoint = options.endpoint;
    this.#doFetch = options.fetchImpl ?? fetch;
    this.#isOnline = options.isOnline ?? (() => true);
  }

  async capability(): Promise<TranscriberCapability> {
    if (!this.#endpoint || !this.#doFetch) {
      return {
        status: "unavailable",
        reason: "not-configured",
        detail: "No document analysis endpoint or transport is configured.",
      };
    }

    if (!this.#isOnline()) {
      return {
        status: "unavailable",
        reason: "offline",
        detail: "The network is currently offline.",
      };
    }

    return { status: "ready" };
  }

  async transcribe(
    item: DocumentCapture,
    bytes: Blob,
    options?: TranscribeOptions,
  ): Promise<Transcript> {
    if (!this.#endpoint || !this.#doFetch) {
      throw new TranscriberUnavailableError({
        engine: this.engine,
        reason: "not-configured",
        detail: "No document analysis endpoint or transport is configured.",
      });
    }
    return transcribeViaManagedDocs(item, bytes, {
      endpoint: this.#endpoint,
      doFetch: this.#doFetch,
      engine: this.engine,
      signal: options?.signal,
    });
  }
}
