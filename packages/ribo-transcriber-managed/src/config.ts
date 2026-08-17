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
}
