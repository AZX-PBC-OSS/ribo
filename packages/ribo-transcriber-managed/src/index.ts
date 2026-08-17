/**
 * @file The public surface of `@azx/ribo-transcriber-managed`.
 *
 * Managed transcription: Azure AI Speech Fast Transcription, proxied
 * through the host's transport. It implements `@azx/ribo-core`'s `Transcriber`
 * seam with engine id `managed-azure-speech`, and composes through `firstCapable`
 * or `hedged` alongside the on-device engine with no queue changes.
 *
 * **The package has no capacity to authenticate.** It takes the Azure transcribe
 * endpoint and an injected `fetch`, and knows nothing about how the call is routed
 * (design §5.2). Connectivity is injected as a predicate too. See {@link
 * ManagedTranscriberOptions} for the full constraint.
 */
import { TranscriberUnavailableError } from "@azx/ribo-core";
import type { Recording, Transcript, Transcriber, TranscriberCapability } from "@azx/ribo-core";

import { MANAGED_AZURE_SPEECH_ENGINE, type ManagedTranscriberOptions } from "./config.js";
import { transcribeViaManagedAzure } from "./transcribe.js";

export { MANAGED_AZURE_SPEECH_ENGINE } from "./config.js";
export type { ManagedTranscriberOptions } from "./config.js";

/**
 * Managed Azure AI Speech transcription, implementing `Transcriber`.
 *
 * ## Capability (Task 3)
 *
 * Maps onto reasons that already exist in `ribo-core`'s `transcriber.ts`:
 *
 * - A missing endpoint or transport yields `not-configured` — the host may supply
 *   one later, so the failure is **not** permanent.
 * - A connectivity predicate reporting down yields `offline` — also a situation,
 *   not a fact about the hardware, so also **not** permanent.
 * - Otherwise `ready`.
 *
 * ## Transcription (Task 4)
 *
 * {@link transcribe} POSTs the recording's audio blob as `multipart/form-data`
 * to the Fast Transcription endpoint through the injected `fetch`, and maps
 * the response onto a `Transcript`. The transcript text is
 * `combinedPhrases[0].text` (design §7). See {@link ./transcribe.ts} for the
 * request path and failure classification — the split keeps this file focused
 * on the class and its capability reporting.
 */
export class ManagedTranscriber implements Transcriber {
  readonly engine = MANAGED_AZURE_SPEECH_ENGINE;

  readonly #endpoint?: string;
  readonly #doFetch?: typeof fetch;
  readonly #isOnline: () => boolean;
  readonly #vocabulary?: readonly string[];

  constructor(options: ManagedTranscriberOptions = {}) {
    this.#endpoint = options.endpoint;
    // `fetch` may be absent in a non-browser env without a polyfill; that is a
    // "no transport" situation, which capability reports as `not-configured`.
    this.#doFetch = options.fetchImpl ?? fetch;
    // Optimistic default: a host that cares about offline state supplies a real
    // predicate. The package never reaches for `navigator.onLine` directly.
    this.#isOnline = options.isOnline ?? (() => true);
    this.#vocabulary = options.vocabulary;
  }

  async capability(): Promise<TranscriberCapability> {
    if (!this.#endpoint || !this.#doFetch) {
      return {
        status: "unavailable",
        reason: "not-configured",
        detail: "No Azure transcribe endpoint or transport is configured.",
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

  async transcribe(recording: Recording, audio: Blob): Promise<Transcript> {
    // If the endpoint or transport is missing, `capability()` would have
    // reported `not-configured` — but `firstCapable` caches capabilities, so
    // the configuration may have changed between the probe and this call.
    // Throwing `TranscriberUnavailableError` here is the "capability was
    // wrong" signal the contract describes (transcriber.ts).
    if (!this.#endpoint || !this.#doFetch) {
      throw new TranscriberUnavailableError({
        engine: this.engine,
        reason: "not-configured",
        detail: "No Azure transcribe endpoint or transport is configured.",
      });
    }
    return transcribeViaManagedAzure(recording, audio, {
      endpoint: this.#endpoint,
      doFetch: this.#doFetch,
      engine: this.engine,
      vocabulary: this.#vocabulary,
    });
  }
}
