/**
 * @file Configuration for the managed document transcriber.
 *
 * The engine id and the options interface live here so `index.ts` can stay
 * focused on the class. The engine id is a published constant — it rides into every
 * `Transcript.engine` this package produces and into the storage document, so a
 * rename is a migration, not a refactor (see `transcript.ts`).
 */

/**
 * `Transcriber.engine` this implementation stamps onto every `Transcript` it
 * produces. Short and stable across versions — it is persisted data, readable
 * straight off `storage.captures.list()` to see the engine mix across a queue.
 *
 * Chosen to parallel `"managed-azure-speech"` (the managed audio transcriber)
 * and to read as distinct from `"pdfjs"` (the on-device document transcriber).
 * The `managed-` prefix signals "hosted service behind the host's transport";
 * the `-docs` suffix signals "document understanding" without committing to a
 * specific vendor, because the package takes a bare endpoint and an injected
 * `fetch` and knows nothing about which service answers.
 * @category Transcription
 */
export const MANAGED_DOCS_ENGINE = "managed-docs";

/**
 * Options for {@link ManagedDocsTranscriber}.
 *
 * **The package has no capacity to authenticate.** There is no token option, no
 * API-key option, and no gateway base URL. The credential lives in the transport
 * the host supplies through `fetchImpl` — whether that fetch goes straight to a
 * document understanding service with a key attached, or is rewritten onto
 * `<gateway>/_api/fetch/<url>` so egress injects the stored secret, is the host's
 * business and never the package's. This mirrors `ManagedTranscriberOptions`
 * exactly; see `ribo-transcriber-managed/src/config.ts`.
 *
 * Connectivity is injected too, as a predicate: the package does not call
 * `navigator.onLine` and does not duplicate `ribo-core`'s three-state connectivity
 * model.
 * @category Transcription
 */
export interface ManagedDocsTranscriberOptions {
  /**
   * The document analysis endpoint URL. Injected by the host — the package
   * never constructs or discovers it. When absent,
   * {@link ManagedDocsTranscriber.capability} reports `not-configured`; the host
   * may supply one later, so the failure is not permanent.
   */
  readonly endpoint?: string;

  /**
   * Override `fetch` — inject a double for tests, or a credential-attaching
   * transport for production. Defaults to the bare global `fetch`, which is
   * expressly allowed in this headless package (AGENTS.md §4). The package adds
   * no credential to the request; whatever auth the call needs is the transport's
   * responsibility.
   */
  readonly fetchImpl?: typeof fetch;

  /**
   * Connectivity predicate. Returns `true` when the network is up. When the
   * predicate reports `false`, {@link ManagedDocsTranscriber.capability} reports
   * `offline`. Defaults to `() => true` (optimistic) — a host that cares about
   * offline state supplies a real predicate, typically backed by
   * `ribo-core`'s `Connectivity` or `navigator.onLine`.
   */
  readonly isOnline?: () => boolean;
}
