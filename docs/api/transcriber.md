# Transcriber

A `Transcriber` turns one captured item — a `Recording` or a `DocumentCapture` — into citable
text: it reports what the engine can do right now through `capability()`, and turns the captured
bytes into a `Transcript` through `transcribe()`. It is the seam every transcription engine
implements — on-device Whisper, the managed Azure path, the pdf.js document engine, and the
`FakeTranscriber` the examples below run on.

## When to reach for it

Reach for the contract when you are **implementing or composing** an engine: selection
(`firstCapable`), hedging, fallback and arbitration all speak `Transcriber`. Reach for the
[Captures & Sources guide](/guide/captures-and-sources) when you want the flow a capture takes
through the queue rather than the shape of one seam. Nothing in the pipeline calls a transcriber
directly except the relay, which drains against a `Transcriber<CapturePayload>`.

## Usage

<<< @/api/examples/transcriber.run.ts#usage

The contract is generic — `Transcriber<S extends CapturePayload = Recording>` — so **"Recording"
is the default type parameter** while the rest of the surface says "capture". A document engine
implements `Transcriber<DocumentCapture>`; an engine that accepts either kind implements
`Transcriber<CapturePayload>`. The full example constructs both. The asymmetry is deliberate and
enforced: `transcribe` is declared as a function-typed property, not a method, so an audio-only
`Transcriber<Recording>` does not slide unchallenged into a `Transcriber<CapturePayload>` slot —
the compiler sends a host to `restrictToKind` instead.

## Options

`transcribe(item, bytes, options?)` takes `TranscribeOptions` — an optional trailing object, the
same bag `Extractor.extract` takes. Neither member has a default; both are supplied by the
caller or not at all.

| Name      | Type                  | Default | What it does                                                                                                                                                                                                                                                             |
| --------- | --------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `signal`  | `AbortSignal`         | —       | Cancels the transcription attempt. An implementation must forward it to its work or say plainly that it cannot — an accepted-but-ignored signal lies.                                                                                                                    |
| `storage` | `CaptureStorageScope` | —       | The plugin-storage handle for **this capture**, supplied by the caller that has one (the relay). The transcriber names its own plugin via `forPlugin`, so two engines on one capture land in separate namespaces. A host driving a transcriber by hand has none to give. |

The defaults this page states belong to `FakeTranscriber`, the engine the example runs on, and
are quoted from the example file below rather than retyped: with no constructor options its
engine id is `"fake"`, its transcript text is the exported constant
`DEFAULT_FAKE_TRANSCRIPT_TEXT` — `"fake transcript"` — and it reports `{ status: "ready" }` until
told otherwise. An options-less `transcribe` passes no options at all. The same file's test run
asserts every one of those values, so a source change that moves them fails the `test` stage:

<<< @/api/examples/transcriber.run.ts#defaults

The contract — `Transcriber`, `TranscribeOptions`, `TranscriberCapability`,
`TranscriberUnavailableError`, `isPermanentlyUnavailable` — is read from
`packages/ribo-core/src/transcription/transcriber.ts`; the fake's defaults from
`packages/ribo-core/src/transcription/fake-transcriber.ts`. The unavailable-reason vocabulary is
a closed set derived from a source constant in `transcriber.ts`; it is not part of the surface
this page documents, and nothing here asks you to adopt it.

## Return value

`transcribe()` resolves to a `Transcript`: `recordingId` (the capture the text came from),
`text`, `engine` (the implementation that actually ran, never a wrapper that delegated), optional
`confidence`, optional `annotations`. `confidence` is not load-bearing — record it, never branch
on it.

`capability()` resolves to a `TranscriberCapability` — three states, not a boolean, because
`needs-download` and `unavailable` produce completely different screens:

- `{ status: "ready" }` — can transcribe now.
- `{ status: "needs-download", downloadBytes, detail? }` — capable, but weights or runtime
  binaries must be fetched first, over the network, with the user's agreement. `downloadBytes`
  includes the runtime, not just the model.
- `{ status: "unavailable", reason, detail }` — cannot run; `reason` is a closed set
  (`unsupported-platform`, `too-slow`, `model-unavailable`, `offline`, `not-configured`,
  `unknown`) and `detail` is required. `isPermanentlyUnavailable()` is true for the reasons that
  will not change for the life of the page (`unsupported-platform`, `too-slow`); everything else
  is a situation, and is re-probed.

## Errors

Three kinds of failure, and conflating them is the bug the contract exists to prevent:

- **Attempt failure** — this clip OOMed, this inference threw, this request 503'd. Throw
  anything; the queue owns retry and backoff, and a selection combinator must let it straight
  through. One bad clip never demotes a device to the cloud for good.
- **Capability failure** — the runtime would not init, the weights will not load. Throw
  `TranscriberUnavailableError` (constructed from `{ engine, reason, detail, cause? }`; carries
  `.engine`, `.reason`, `.detail` and a `.capability` getter ready to replace a stale cached
  answer). Deliberately _not_ terminal: the next attempt re-probes and may route elsewhere.
- **Item unsuitability** — this engine cannot handle this item (a scanned PDF with no text
  layer, say). Throw `UnsupportedItemError`: terminal for the queue (no retry budget burned) but
  not for the item — a composition layer routes to the next engine.

## Full example

Runs in CI. Every exported function below is executed by the Vitest `unit` project on every
`test` run, ending in assertions on exactly what this page claims — including the defaults
quoted under Options.

<<< @/api/examples/transcriber.run.ts

## Related APIs

- [`firstCapable`](/reference/@azx/ribo-core/functions/firstCapable.html) — try engines in
  preference order; first one ready wins.
- [`hedged`](/reference/@azx/ribo-core/functions/hedged.html) — race a preferred engine against
  a fallback on a latency budget.
- [`fallbackTranscriber`](/reference/@azx/ribo-core/functions/fallbackTranscriber.html) — let an
  arbiter decide whether an outcome is acceptable.
- [`restrictToKind`](/reference/@azx/ribo-core/functions/restrictToKind.html) — lift a narrow
  transcriber into a `Transcriber<CapturePayload>` slot, refusing other kinds.
- [`FakeTranscriber`](/reference/@azx/ribo-core/classes/FakeTranscriber.html) — the fake the
  example runs on; simulates all three capability states and all three failure kinds.

## Guides that use it

- [Captures & Sources](/guide/captures-and-sources) — the flow a capture takes through the queue,
  and the engine packages that implement this contract.

## Reference

- [`Transcriber`](/reference/@azx/ribo-core/interfaces/Transcriber.html)
- [`TranscribeOptions`](/reference/@azx/ribo-core/interfaces/TranscribeOptions.html)
- [`TranscriberCapability`](/reference/@azx/ribo-core/type-aliases/TranscriberCapability.html)
- [`TranscriberUnavailableError`](/reference/@azx/ribo-core/classes/TranscriberUnavailableError.html)
- [`isPermanentlyUnavailable`](/reference/@azx/ribo-core/functions/isPermanentlyUnavailable.html)
- [`UnsupportedItemError`](/reference/@azx/ribo-core/classes/UnsupportedItemError.html)
- [`FakeTranscriberOptions`](/reference/@azx/ribo-core/interfaces/FakeTranscriberOptions.html)
