---
"@azx/ribo-transcriber-managed": minor
---

Implement `ManagedTranscriber.transcribe` — POST the recording's audio blob as
`multipart/form-data` to the Azure Fast Transcription endpoint through the
injected `fetch`, and map the response onto a `Transcript` (Task 4 of the
managed transcription plan).

The request shape is verified against the live endpoint (design §7, measured
2026-08-17): two form parts — `audio` carrying the blob as recorded (no
transcode, no re-containering) and `definition` carrying JSON with `locales`.
The transcript text is `combinedPhrases[0].text`.

**The URL is the configured endpoint as-is** — the package does not prefix
`/_api/fetch/`. Routing is the host transport's job (design §5.2), and baking
the gateway into the package would double up once the host's transport adds its
own prefix.

**Failure classification is the point of this task**, and getting it wrong is
the bug the `Transcriber` contract exists to prevent (`transcriber.ts`,
`first-capable` rule 5):

- 5xx, timeout, network error, malformed body → **attempt** failures. Throw
  plainly with the HTTP `status` attached so `isTransientFailure` can classify
  it. These must **not** be `TranscriberUnavailableError`, or one bad clip
  permanently demotes the engine.
- 401 / 403 → **capability** failure. Throw `TranscriberUnavailableError` with
  reason `not-configured` so `firstCapable` demotes the engine and the next
  attempt re-probes.
- 413 → **terminal**. The payload is too large for the transport. Throw
  `TerminalQueueError` — the queue's existing terminal vocabulary, not a second
  retry classifier.

The package still has **no capacity to authenticate** — no token option, no
API-key option, no `Authorization` or `Ocp-Apim-Subscription-Key` header. The
credential lives in the transport the host supplies.

No new runtime dependencies. No change to `Transcriber`, `TranscriberCapability`,
`firstCapable`, or the outbox schema.
