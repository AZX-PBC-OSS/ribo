/**
 * @file Configuration for the managed Azure Speech transcriber.
 *
 * The engine id and the options interface live here so {@link ./index.ts} can stay
 * focused on the class. The engine id is a published constant — it rides into every
 * `Transcript.engine` this package produces and into the outbox document, so a
 * rename is a migration, not a refactor (see `transcript.ts`).
 */

/**
 * `Transcriber.engine` this implementation stamps onto every `Transcript` it
 * produces. Short and stable across versions — it is persisted data, readable
 * straight off `Outbox.list()` to see the on-device/managed engine mix. Matches
 * `docs/roadmap/design/managed-transcription-plan.md` Task 3 and `transcript.ts`.
 */
export const MANAGED_AZURE_SPEECH_ENGINE = "managed-azure-speech";

/**
 * Options for {@link ManagedTranscriber}.
 *
 * **The package has no capacity to authenticate.** There is no token option, no
 * API-key option, and no gateway base URL. The credential lives in the transport
 * the host supplies through `fetchImpl` — whether that fetch goes straight to
 * Azure with a key attached, or is rewritten onto `<gateway>/_api/fetch/<url>` so
 * egress injects the stored `azure-stt` secret, is the host's business and never
 * the package's (design §5.2).
 *
 * Connectivity is injected too, as a predicate: the package does not call
 * `navigator.onLine` and does not duplicate `ribo-core`'s three-state connectivity
 * model.
 */
export interface ManagedTranscriberOptions {
  /**
   * The Azure Fast Transcription endpoint URL. Injected by the host — the package
   * never constructs or discovers it. When absent, {@link ManagedTranscriber.capability}
   * reports `not-configured`; the host may supply one later, so the failure is not
   * permanent.
   */
  readonly endpoint?: string;

  /**
   * Override `fetch` — inject a double for tests, or a credential-attaching
   * transport for production. Defaults to the bare global `fetch`, which is
   * expressly allowed in this headless package (AGENTS §4). The package adds no
   * credential to the request; whatever auth the call needs is the transport's
   * responsibility.
   */
  readonly fetchImpl?: typeof fetch;

  /**
   * Connectivity predicate. Returns `true` when the network is up. When the
   * predicate reports `false`, {@link ManagedTranscriber.capability} reports
   * `offline`. Defaults to `() => true` (optimistic) — a host that cares about
   * offline state supplies a real predicate, typically backed by
   * `ribo-core`'s `Connectivity` or `navigator.onLine`.
   */
  readonly isOnline?: () => boolean;

  /**
   * Domain terms sent to the Fast Transcription endpoint as
   * `definition.phraseList.phrases` to bias recognition toward supplied
   * vocabulary. This is load-bearing, not a refinement: measured on 2026-08-17
   * the same audio returned "our 19" with no phrase list and "R-19" with one
   * (design §6) — R-values are exactly the class of term the downstream
   * extractor reads.
   *
   * **The vocabulary belongs to the host.** This package is tool-agnostic and
   * holds no home-energy word list; the host supplies the list (plan Task 7).
   * The option mirrors the shape of `TranscribeHints.vocabulary` in
   * `ribo-transcriber-ondevice/src/config.ts` (`readonly string[]`) so a single
   * host-held list can feed both engines by two mechanisms — a jargon prefix
   * on-device, a phrase list here. The type is re-declared rather than
   * imported: `TranscribeHints` lives in the on-device package and must not
   * move to `ribo-core` (plan Task 5).
   *
   * Omitted, or a list that is empty after trimming, sends no `phraseList` at
   * all — an empty phrase list is no phrase list.
   */
  readonly vocabulary?: readonly string[];
}
