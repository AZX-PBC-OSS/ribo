---
"@azx/ribo-transcriber-managed": minor
---

Add `@azx/ribo-transcriber-managed` — the managed Azure AI Speech transcriber
plasmid, scaffold and capability reporting only (Task 3 of the managed
transcription plan).

The package implements `@azx/ribo-core`'s `Transcriber` seam with engine id
`managed-azure-speech`. It takes the Azure transcribe endpoint and an injected
`fetch`, and has **no capacity to authenticate** — no token option, no API-key
option, no gateway base URL. The credential lives in the transport the host
supplies (design §5.2). Connectivity is injected as a predicate too; the package
does not call `navigator.onLine` directly and does not duplicate `ribo-core`'s
three-state connectivity model.

Capability maps onto reasons that already exist in `ribo-core`'s `transcriber.ts`:
a missing endpoint or transport yields `not-configured`, a connectivity predicate
reporting down yields `offline`, otherwise `ready`. Neither failure is permanent —
both are situations, not facts about the hardware — so
`isPermanentlyUnavailable()` is `false` for both.

`transcribe()` is a stub that throws; the request path lands in Task 4. Splitting
here keeps the packaging gates (`check:pkg`, `check:resolve`, `build:packages`)
reviewable separately from the request logic.

New exports:

- `ManagedTranscriber` — the class implementing `Transcriber`.
- `ManagedTranscriberOptions` — `endpoint`, `fetchImpl`, `isOnline`.
- `MANAGED_AZURE_SPEECH_ENGINE` — the stable engine id `"managed-azure-speech"`.

No new runtime dependencies. No change to `Transcriber`, `TranscriberCapability`,
`firstCapable`, or the outbox schema.
