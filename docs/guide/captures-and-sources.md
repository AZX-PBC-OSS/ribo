# Captures & Sources

Ribo's queue carries audio and PDFs today, and whatever a future transcriber package adds later —
the whole pipeline is written against one union, `CapturePayload`, not against either branch by name.

**A `Transcriber` turns any capture into citable text.** Audio was the first kind Ribo had a
transcriber for. The interface predates documents, and the name stayed because renaming a public
seam costs more than it buys.

## `CapturePayload`: two branches, one union

`Recording` (audio) and `DocumentCapture` (a PDF, today) share four fields — `id`, `capturedAt`,
`mimeType`, and a host-supplied `ctx` — and each adds exactly one field of its own on top of a
`kind` discriminant:

```ts
import { basePayloadSchema } from "@azx/ribo-core";

const invoice = basePayloadSchema.parse({
  id: "cap-invoice",
  capturedAt: new Date().toISOString(),
  mimeType: "application/pdf",
  kind: "document",
  pageCount: 4,
  ctx: {},
});

const dictation = basePayloadSchema.parse({
  id: "cap-dictation",
  capturedAt: new Date().toISOString(),
  mimeType: "audio/webm;codecs=opus",
  durationMs: 96_000,
  ctx: {},
  // `kind` omitted here — the union stamps "audio" onto a row with no `kind`
  // key at all, so every pre-existing recording still parses.
});
```

`CapturePayload` is a `z.discriminatedUnion` on `kind`, so `restrictToKind`, the relay, and every
transcriber engine below can narrow on it directly — there is no `instanceof`, no duck-typing on
"does this have `durationMs`."

**Why a PDF is not a `Recording` with `durationMs: 0`.** `durationMs` is `.int().nonnegative()`
because a silent, empty recording is still a legitimate capture — zero is real. `pageCount` is
`.int().positive()` because a zero-page document isn't a thin document, it's a parse that already
went wrong upstream, and the schema says so at the boundary rather than downstream where the zero
would be indistinguishable from "really has no pages." Forcing a PDF through the audio branch would
give every consumer that reads `durationMs` a second meaning for zero — "actually a document." `kind`
is what `restrictToKind` and every fallback engine below route on; inferring it from a bogus duration
would put the routing decision back on a heuristic instead of a fact stamped at capture time.

## Transcriber packages, one seam

Every engine below implements the same `Transcriber` interface from `@azx/ribo-core`; only the
capture kind and the transport differ.

| Package                              | Capture kind      | What it does                                                                                                                                   |
| ------------------------------------ | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `@azx/ribo-transcriber-ondevice`     | `Recording`       | On-device transcription (Moonshine by default), run through `@huggingface/transformers` in a Web Worker — no network once the model is cached. |
| `@azx/ribo-transcriber-managed`      | `Recording`       | Azure AI Speech Fast Transcription, proxied through the host's own transport.                                                                  |
| `@azx/ribo-transcriber-pdfjs`        | `DocumentCapture` | PDF text extraction via pdf.js, entirely in-browser — the reference document engine.                                                           |
| `@azx/ribo-transcriber-managed-docs` | `DocumentCapture` | A hosted document-understanding API behind the host's transport — the engine to fall back to when `pdfjs` can't read a page.                   |

They compose the same way audio-only engines always did — `firstCapable` for preference order,
`hedged` to race a fallback on a latency budget, `fallbackTranscriber` to let an arbiter decide
whether an outcome is acceptable — none of that machinery changed to make room for documents.

## The capability model

A `Transcriber` reports what it can do **right now** through `capability()`, and a caller is
expected to call it often and cheaply:

```ts
type TranscriberCapability =
  | { status: "ready" }
  | { status: "needs-download"; downloadBytes: number; detail?: string }
  | { status: "unavailable"; reason: TranscriberUnavailableReason; detail: string };
```

Three states, not a boolean, because `needs-download` and `unavailable` need completely different
screens — "165 MB has to come down first, with your say-so" is not "this cannot run here." The
`unavailable` reasons are a closed set: `unsupported-platform`, `too-slow`, `model-unavailable`,
`offline`, `not-configured`, `unknown`. Only the first two are permanent for the life of the page —
a device without WebGPU won't grow one, and a measured real-time factor won't improve — everything
else (an uplink, a download, a missing key) is a situation, re-probed on the next check rather than
cached forever.

## `UnsupportedItemError`: the third failure class

A `Transcriber` fails three ways. The contract keeps them apart:

- **Attempt failure** — this clip OOMed, this request 503'd. Throw anything; the queue's own
  backoff and `maxAttempts` already handle it.
- **Capability failure** — the runtime won't init, the device can't do this at all. Throw
  `TranscriberUnavailableError`. Falling back to another engine is correct, and the capability
  answer that said `ready` was wrong.
- **Item unsuitability** — this engine cannot handle this specific item, and that says nothing
  about the engine. Throw `UnsupportedItemError`.

A scanned invoice PDF with no text layer is the third kind, not the first or second: `pdfjs` is
working exactly as designed, and retrying it burns backoff attempts that will never succeed. Its
reasons are `no-text-layer`, `encrypted`, `unsupported-format` — each plainly a property of the
item, not of the engine or the device.

`UnsupportedItemError` is **terminal for the queue**, not **terminal for the item**. It subclasses
`TerminalError`, the base class `isTransientFailure` treats as non-retryable outright, so the
relay spends no retry budget on an engine+item pair that will never succeed. A composition layer sees
the failure and routes to the next engine: a scanned invoice that `pdfjs` can't read a text layer
from is exactly the case `@azx/ribo-transcriber-managed-docs`'s OCR exists for, and
`fallbackTranscriber` moves on to it without the item ever reaching `dead`.

## `TranscribeOptions`: cancellation is part of the contract

`transcribe(item, bytes, options?)` takes a trailing options bag — an options object rather than a
positional parameter, so members can join without a third parameter ever appearing. It currently
carries two.

**`signal?: AbortSignal`** cancels the attempt. The relay passes one, and it aborts when the
transcribe step's timeout fires — the signal and the timeout are one mechanism, not two, so a hung
transcription is cancelled rather than left running behind the rejection. What an abort does is
per-transport, and each implementation states it in its own docs:

- The **fetch-based** engines (`@azx/ribo-transcriber-managed`,
  `@azx/ribo-transcriber-managed-docs`) forward the signal into the fetch init, so an abort tears
  down the in-flight HTTP request.
- **`pdfjs`** destroys the pdf.js loading task on abort, and additionally checks the signal at the
  top of every page, so work already queued for the next page stops too.
- The **on-device** engine sends a `cancelTranscribe` message to its worker and the worker's batch
  loop stops between chunks — deliberately not `worker.terminate()`, which would throw away the
  loaded model along with the cancelled clip.

Every one of the shipped engines classifies a caller-aborted transcription as a `TerminalError`
— the caller withdrew the work, and the queue must not spend its retry budget re-running it. That
classification is load-bearing: an abort rejection has no HTTP status, and `isTransientFailure`
reads any error without one as retryable — so without it, a cancelled capture would be re-sent until
`dead` for the worst possible reason. An implementation that cannot honour a signal must say so
plainly rather than accept it and ignore it: a signal that is accepted and not forwarded looks like
cancellation and is not.

**`storage?: CaptureStorageScope`** is the capture-scoped handle a transcriber uses to write
durable, plugin-namespaced state — page annotations, a provider's own structured response — for an
extractor
from the same plugin to read back later. The relay supplies it; a host driving a transcriber by hand
has none to give, so it is optional, and an engine that needs storage must handle its absence.
[Plugin Storage](/guide/plugin-storage) covers the handle in full.

## `restrictToKind`: lifting a narrow engine into a wider slot

`Transcriber.transcribe` is a function-typed property, not a method, so an audio-only
`Transcriber<Recording>` does **not** silently satisfy `Transcriber<CapturePayload>` — method syntax is
bivariant even under `strict`, and would let a recording-only engine slide into a slot that can also
see a `DocumentCapture`. `RelayOptions.transcriber` wants `Transcriber<CapturePayload>` because the
queue holds either kind: the compiler rejects an audio-only roster, and `restrictToKind` is the fix:

```ts
import { firstCapable, restrictToKind } from "@azx/ribo-core";
import { OnDeviceTranscriber } from "@azx/ribo-transcriber-ondevice";
import { ManagedTranscriber } from "@azx/ribo-transcriber-managed";

const audioEngine = firstCapable([
  new OnDeviceTranscriber(onDeviceOptions),
  new ManagedTranscriber(managedOptions),
]);
// `audioEngine` is `Transcriber<Recording>` — it does not typecheck as
// `RelayOptions.transcriber`, which is `Transcriber<CapturePayload>`.

const transcriber = restrictToKind("audio", audioEngine);
// `transcriber` satisfies `Transcriber<CapturePayload>`: a document handed to it
// throws `UnsupportedItemError` immediately, and an audio item is delegated
// straight through to `audioEngine`.
```

It changes no engine and asks nothing of the caller beyond naming the kind once. A composition root
wiring both a document roster (`pdfjs` falling back to `managed-docs`) and an audio roster
(`ondevice` falling back to `managed`) into one relay lifts each with `restrictToKind` and merges
both into a single `fallbackTranscriber` — one `Transcriber<CapturePayload>` the relay drains against,
regardless of which kind of capture it's handed next.

## Next

[Sessions](/guide/sessions) is where these captures go once they're transcribed — one or several,
audio or document, joined into a single transcript and extracted once.
