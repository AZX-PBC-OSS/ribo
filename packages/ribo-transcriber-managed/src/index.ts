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
import type { Recording, Transcript, Transcriber, TranscriberCapability } from "@azx/ribo-core";

import { MANAGED_AZURE_SPEECH_ENGINE, type ManagedTranscriberOptions } from "./config.js";

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
 * ## Transcription (Task 4 — not yet implemented)
 *
 * {@link transcribe} is a stub that throws. The request path, failure
 * classification, and response mapping land in Task 4 of the managed transcription
 * plan. Splitting here keeps the packaging gates (`check:pkg`, `check:resolve`,
 * `build:packages`) reviewable separately from the request logic.
 */
export class ManagedTranscriber implements Transcriber {
  readonly engine = MANAGED_AZURE_SPEECH_ENGINE;

  readonly #endpoint?: string;
  readonly #doFetch?: typeof fetch;
  readonly #isOnline: () => boolean;

  constructor(options: ManagedTranscriberOptions = {}) {
    this.#endpoint = options.endpoint;
    // `fetch` may be absent in a non-browser env without a polyfill; that is a
    // "no transport" situation, which capability reports as `not-configured`.
    this.#doFetch = options.fetchImpl ?? fetch;
    // Optimistic default: a host that cares about offline state supplies a real
    // predicate. The package never reaches for `navigator.onLine` directly.
    this.#isOnline = options.isOnline ?? (() => true);
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

  transcribe(_recording: Recording, _audio: Blob): Promise<Transcript> {
    // Task 4 implements the multipart Fast Transcription request, failure
    // classification, and response mapping. A stub that throws is correct here —
    // splitting keeps the packaging gates reviewable separately from the request
    // logic.
    throw new Error(
      `${MANAGED_AZURE_SPEECH_ENGINE}: transcribe() is not implemented yet — see Task 4 of the managed transcription plan`,
    );
  }
}
