# ManagedTranscriber

Managed speech-to-text: Azure AI Speech Fast Transcription, proxied through the **host's
transport**. Implements the [`Transcriber`](/api/transcriber) seam with engine id
`managed-azure-speech`, so it composes through `firstCapable` or `hedged` alongside the on-device
engine with no queue changes. **The package has no capacity to authenticate** — no token option,
no API-key option, no gateway URL. The credential lives in the transport the host supplies
through `fetchImpl`.

## When to reach for it

Reach for it as the fallback for devices that fail the on-device speed gate — it is the managed
half of the roster [`firstCapable`](/api/composing-transcribers) selects from. Reach for the
[Captures & Sources guide](/guide/captures-and-sources) for where that roster is wired and what
egress does with the request.

## Usage

Everything below runs with no credentials and no network: the endpoint is never real, and the
transport is an injected `fetch` double. With no endpoint, `capability()` reports
`not-configured` — the host may supply one later, so the failure is not permanent:

<<< @/api/examples/managed-transcriber.run.ts#usage

## Options

`new ManagedTranscriber(options?)` takes `ManagedTranscriberOptions` — every member is optional.

The defaults the page states are quoted from the example file rather than retyped, and the same
file's test run asserts them — the engine id against its exported constant, the optimistic
connectivity default by observed behaviour:

<<< @/api/examples/managed-transcriber.run.ts#defaults

| Name         | Type                | Default                       | What it does                                                                                                                                                                                                                     |
| ------------ | ------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `endpoint`   | `string`            | —                             | The Azure Fast Transcription endpoint URL, already carrying `?api-version=...`. Injected by the host; the package never constructs or discovers it. Absent, `capability()` reports `not-configured`.                             |
| `fetchImpl`  | `typeof fetch`      | the bare global `fetch`       | Override `fetch` — inject a double for tests, or a credential-attaching transport for production. The package adds no credential to the request; whatever auth the call needs is the transport's responsibility.                 |
| `isOnline`   | `() => boolean`     | `() => true` (observed above) | Connectivity predicate. `false`, `capability()` reports `offline`. The package never calls `navigator.onLine` and does not duplicate core's three-state connectivity model — the host backs the predicate with that.             |
| `vocabulary` | `readonly string[]` | — (no phrase list)            | Domain terms sent as `definition.phraseList.phrases` to bias recognition. Load-bearing, not a refinement: the same audio returned "our 19" without a phrase list and "R-19" with one. Empty after trimming sends no phrase list. |

Options are read from `packages/ribo-transcriber-managed/src/config.ts` (the options interface)
and `src/index.ts` (the class).

## Return value

- `capability()` — `ready`, or `unavailable` with `not-configured` (no endpoint or transport) or
  `offline` (the predicate reported down). Both are situations, not facts about the hardware, so
  neither is permanent and both are re-probed.
- `transcribe(recording, audio, options?)` — POSTs the audio blob as `multipart/form-data` (an
  `audio` part and a `definition` JSON part) and maps the response onto a `Transcript` whose text
  is `combinedPhrases[0].text` and whose `engine` is `managed-azure-speech`. The caller's
  `signal` is forwarded into the fetch init, so an abort tears down the in-flight HTTP request;
  a cancellation rejects with `TerminalError`.

## Errors

- **Attempt failure** — 5xx, timeout, network error, malformed body. Thrown plainly with the
  HTTP `status` attached so the queue can classify it (5xx retryable, 4xx dead). Never a
  `TranscriberUnavailableError`: one bad clip must not permanently demote the engine.
- **Capability failure** — 401/403 (the credential is missing or wrong), or a call made after the
  configuration was lost (a cached `ready` can go stale). Throws `TranscriberUnavailableError`
  with reason `not-configured`; the engine is demoted and the next attempt re-probes.
- **Terminal** — 413 (the payload is too large; retrying an oversized body forever is worse than
  failing it) and the caller's own abort. Both throw `TerminalError`.

## Full example

Runs in CI. Every exported function below is executed by the Vitest `unit` project on every
`test` run, ending in assertions on exactly what this page claims — including the defaults quoted
under Options.

<<< @/api/examples/managed-transcriber.run.ts

## Related APIs

- [`Transcriber`](/api/transcriber) — the seam this class implements.
- [`firstCapable` and friends](/api/composing-transcribers) — where the managed engine sits in a
  roster, and when a race or a hedge is the wrong shape for it.
- [`ManagedDocsTranscriber`](/api/managed-docs-transcriber) — the document counterpart, same
  injected-transport shape.

## Guides that use it

- [Captures & Sources](/guide/captures-and-sources) — the managed half of the engine roster, and
  what the transport must do that the package will not.

## Reference

- [`ManagedTranscriber`](/reference/@azx/ribo-transcriber-managed/classes/ManagedTranscriber.html)
- [`ManagedTranscriberOptions`](/reference/@azx/ribo-transcriber-managed/interfaces/ManagedTranscriberOptions.html)
- [`MANAGED_AZURE_SPEECH_ENGINE`](/reference/@azx/ribo-transcriber-managed/variables/MANAGED_AZURE_SPEECH_ENGINE.html)
