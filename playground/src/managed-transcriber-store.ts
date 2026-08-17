import { ManagedTranscriber, MANAGED_AZURE_SPEECH_ENGINE } from "@azx/ribo-transcriber-managed";

import { DOMAIN_VOCABULARY } from "./whisper-store.js";

/**
 * @file The shared managed transcriber, and the transport that credentials it.
 *
 * **The host owns the transport; the package owns the request.**
 * `@azx/ribo-transcriber-managed` deliberately has no capacity to authenticate —
 * no token option, no key option (design §5.2). It builds the Azure request and
 * calls an injected `fetch`. This file supplies that `fetch`.
 *
 * ## The transport, and why it is shaped like this
 *
 * {@link devTransport} rewrites the Azure URL onto the same-origin
 * `/api/transcribe`, which the Vite plugin in `../vite-transcribe.ts` forwards
 * upstream with the subscription key attached **server-side**. The key never
 * reaches the browser and is never inlined into a bundle.
 *
 * That is deliberately the same shape as production. Helix's fetch-proxy is
 * `POST <gateway>/_api/fetch/<absolute-url>`, with the edge injecting the stored
 * `azure-stt` secret — a same-origin call that gets credentialed where the browser
 * cannot see. So the eventual migration is a change to the URL this function
 * builds, and nothing else: no package release, no change to any caller.
 *
 * ## Vocabulary
 *
 * {@link DOMAIN_VOCABULARY} is the single host-held list, already used to prime the
 * on-device engine's jargon prefix. It feeds the managed engine's
 * `definition.phraseList.phrases` too — one source, two mechanisms. This is
 * load-bearing rather than cosmetic: the same audio returned "our 19" without a
 * phrase list and "R-19" with one (design §6).
 */

/**
 * Route the package's Azure request through the same-origin dev endpoint.
 *
 * The package's URL is discarded rather than forwarded, and deliberately so: the
 * server derives the real endpoint from its own environment, and letting the
 * browser name the upstream host would make this a request forwarder pointed
 * wherever a page asked. The Helix transport that replaces this one *does* carry
 * the absolute URL — but the platform validates it against a manifest allowlist,
 * which is the check this dev endpoint has no way to perform.
 */
const devTransport: typeof fetch = (_input, init) => fetch("/api/transcribe", init);

/**
 * The endpoint the package builds its request against — when managed
 * transcription is switched on at all.
 *
 * **`VITE_MANAGED_TRANSCRIPTION=1` is the switch, and it is off by default.** The
 * browser cannot tell whether the dev server actually holds a key: that lives in
 * `process.env` on the Vite side, correctly invisible here. Without a switch the
 * transcriber would claim `ready` on every machine, `firstCapable` would select it
 * over an unprimed on-device engine, and every drain on a machine with no
 * credentials would fail instead of behaving as it does today. Off by default
 * keeps CI and every uncredentialed checkout on exactly their current path.
 *
 * The host itself is a placeholder. The dev server derives the real resource
 * endpoint from `AZURE_AI_FOUNDRY_OPENAI_BASE_URL` on its own side; what matters
 * here is only that the package *has* an endpoint, so `capability()` can report
 * `ready`. The package never contacts this host — `devTransport` rewrites the
 * call onto `/api/transcribe`.
 */
const ENABLED = import.meta.env.VITE_MANAGED_TRANSCRIPTION === "1";

const ENDPOINT = ENABLED
  ? "https://managed-transcription.invalid/speechtotext/transcriptions:transcribe?api-version=2025-10-15"
  : undefined;

let transcriber: ManagedTranscriber | undefined;

/** The shared managed transcriber, constructed on first use. */
export function getManagedTranscriber(): ManagedTranscriber {
  transcriber ??= new ManagedTranscriber({
    endpoint: ENDPOINT,
    fetchImpl: devTransport,
    isOnline: () => navigator.onLine,
    vocabulary: DOMAIN_VOCABULARY,
  });
  return transcriber;
}

/** The engine id, for display in the footer alongside the other package names. */
export { MANAGED_AZURE_SPEECH_ENGINE };
