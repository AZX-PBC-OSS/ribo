# Feasibility

::: warning Superseded 2026-08-11 — the default model changed from Whisper to Moonshine
This page is the record of the **original** feasibility decision, written when Whisper was the
on-device default. That default has since moved to **Moonshine**
(`onnx-community/moonshine-base-ONNX`, see `DEFAULT_MODEL_ID` in
`@azx/ribo-transcriber-ondevice`) — a **major**, deliberate change, not a drift. The reason: Whisper
pads every input to its 30-second receptive field before the encoder runs, so cost is set by the
window rather than by the speech (measured at 1.26× across a 14.5× range of audio — a 2-second
utterance costs what a 29-second one does); Moonshine's feature extractor passes audio through
unpadded and is 4–16× faster at the short utterance lengths live transcription needs.

**What's still valid below:** the device baseline, the iOS WebGPU trap (Finding 1), the debunking of
circulating public benchmarks (Finding 2), the library-attrition reasoning (`@huggingface/transformers`
was, and remains, the only viable runtime), and the backend/streaming policy under "What the spike
committed to." **What's no longer current:** every present-tense claim that Whisper or
`whisper-base.en` specifically _is_ the default, and the `prompt_ids` argument below — Moonshine has
no equivalent hinting mechanism (see the callout after that section).
:::

On-device WASM Whisper (`@huggingface/transformers` + `whisper-base.en`) was Ribo's default
transcription path when this page was written. It was chosen by attrition — every other
browser-runnable candidate failed to survive a feasibility spike run against a specific device
baseline — not because it was assumed to be the best model available. This page is the working
behind that choice, as it stood then; the numbers it produced are on
[Transcription: Measured](/deep-dives/transcription-measurement).

## The question the spike had to answer

The target device baseline was fixed before the spike ran: evergreen Chromium on Windows (current −
2), Safari on iOS/iPadOS (current − 1 major), Chrome on Android (current − 2). WebGPU, WASM SIMD,
OPFS, IndexedDB, `MediaRecorder` and Web Workers can be assumed present on that baseline — but
presence is capability, not performance. A device exposing the WebGPU API can still run several
times too slow, or thermally throttle mid-walkthrough. So the spike's real question was narrower and
harder than "can this run at all": **at what real-time factor and word error rate does a WASM
Whisper model transcribe on each device class — and which classes clear the bar for on-device by
default?**

## Finding 1 — iOS has no reachable WebGPU path at all

`@huggingface/transformers` v4 deliberately ships Safari a different ONNX Runtime build than every
other browser — one that contains **no WebGPU code**. Unpacking the published tarballs directly
(not reading documentation, which doesn't mention this) shows the Safari binary is 12.9 MB against
23.6 MB for the general build, and contains zero WebGPU references.

The split is defensive, not accidental: two still-open upstream issues report WebKit growing to 14
GB of memory and crashing under WebGPU inference, and crashes after roughly 500 WebGPU inferences on
iOS. Both were closed by a stale bot rather than fixed, so the underlying defects have to be assumed
live. The practical consequence: **on iOS you get WASM CPU inference regardless of what `device` you
request.**

There's a trap layered on top of that split. The library's own Safari detection excludes `CriOS`,
`FxiOS` and `EdgiOS` — so Chrome on an iPhone doesn't get routed to the safe Safari build, it gets
the general build with the crash-prone WebGPU path, on the exact engine those crash reports describe.
Browser capability and _reachable_ capability are different things here, and the fix is to sniff the
rendering engine, not the browser brand, and force every iOS browser onto the WASM path.

## Finding 2 — the circulating performance numbers are fabricated

Every browser Whisper real-time-factor figure in public circulation traces back to one SEO blog post
with no device specs, no library versions, no audio samples and no stated procedure. It is not a
benchmark, and citing it would have been citing nothing.

The only _measured_ browser data point findable at the time — from an issue on the library's own
tracker, run on an M2 Mac mini — showed **WebGPU slower than WASM** for Whisper: 9.5 s against 5.9 s
for 60 s of audio. Whisper's encoder/decoder loops are small and dispatch-bound rather than
FLOP-bound, which is exactly the shape of workload a GPU dispatch doesn't help. The standing
conclusion the spike carried forward: no credible public browser RTF benchmark exists for any of
these models, so the spike would have to measure rather than cite, and "WebGPU is faster" was
explicitly not an assumption it was permitted to carry into a plan. (Ribo's own later, larger
measurement run stayed WASM-only for a different reason — headless Chromium has no GPU surface at
all — so WebGPU throughput remains unmeasured by this repo; see
[Transcription: Measured](/deep-dives/transcription-measurement).)

## Why `@huggingface/transformers` and `whisper-base.en`

**The library was chosen by attrition, not preference.** Moonshine has real research behind it but
no shippable browser artifact at spike time: its JS wrapper runs only first-generation models and
wraps an older major version of the runtime, and the newer WASM port needed a from-source build.
`@transcribe/shout` requires cross-origin isolation (`COOP`/`COEP`) unconditionally — a requirement
Ribo's hosting model can't guarantee. Vosk, whisper-turbo and ratchet were dead on npm. Parakeet and
Voxtral run 454 MB to 2.5 GB, which rules them out for a one-time download onto a field tablet.
`@huggingface/transformers` was the only candidate left standing.

**`whisper-base.en`** (~142–165 MB) was the shipped default, with **`tiny.en`** (~96 MB) as a
low-end fallback and **`small.en`** (~300 MB) as an accuracy escape hatch, selected at download time
from a device probe. Add roughly 13 MB (Safari) or 24 MB (Chromium) for the ONNX Runtime binary
itself — a real one-time download that's routinely left out of model-size arithmetic.

**The decisive reason for Whisper specifically, at the time, was not accuracy — it was `prompt_ids`.**
Whisper accepts a decoder-prefix hint: a list of domain vocabulary tokens that bias what the model
hears without retraining it. That was a `Transcriber`-interface consequence as much as a model
choice — see [Transcription: Measured](/deep-dives/transcription-measurement) for what hinting
actually bought in WER terms.

**That argument does not carry over to Moonshine, the current default.** Moonshine has no
`<|startofprev|>`-equivalent control token, so the same decoder-prefix trick doesn't degrade
gracefully — it makes the model echo the prefix, emit a comma, and stop transcribing the audio
entirely (measured in `moonshine-priming.manual.ts`). `@azx/ribo-transcriber-ondevice` now throws
rather than silently drop or silently apply hints on a model that can't honor them
(`modelSupportsHints`). Domain-jargon priming is a real capability the Moonshine switch gives up, not
a free swap — see the `moonshine-default` changeset.

## What the spike committed to

- **Backend policy:** WebGPU where the platform genuinely offers it (Chromium), WASM-SIMD
  everywhere else, and never a requirement for `COOP`/`COEP` — every candidate that needed it was
  disqualified for it.
- **Streaming stays off by default.** Batch transcription is the contract. Partial, in-progress
  results are technically demonstrable on Chromium+WebGPU, but Whisper re-encodes a zero-padded 30 s
  window on every partial, which costs roughly N× a batch transcription — unaffordable on
  single-threaded WASM iOS. Partials ship only as a Chromium-only progressive enhancement, off by
  default. (This exact padding cost is what later motivated moving the default off Whisper — see the
  note at the top of this page.)
- **Go/no-go is a throughput question, not a capability one.** A device class defaults to on-device
  if its real-time factor stays comfortably under 1.0 and its word error rate is low enough for the
  downstream extractor to recover the fields that matter; a class that can't clear that bar falls
  back to the managed Azure speech-to-text path. That fallback exists for a **performance** reason
  now, not a capability one — the baseline already guarantees WebGPU/WASM-SIMD presence, so a device
  that has them can still be too slow or too inaccurate for a full audit walkthrough.
- iOS was the class likeliest to fall back, and for the architectural reason above (Finding 1)
  rather than a raw-throughput one.

## What this doesn't settle

This page is the spike's design record — the reasoning that picked a library, a model, and a backend
policy before a single production number existed. It does not carry a single real-time-factor or
word-error-rate figure of its own; those come from a full measurement run on Ribo's own corpus, and
they are the whole subject of [Transcription: Measured](/deep-dives/transcription-measurement).

Full method and the research pass this page repackages:
[doc 01, the feasibility spike](https://github.com/AZX-PBC-OSS/ribo/blob/main/docs/implementation/01-feasibility-spike.md)
— implementation notes that live in the repo, not on this site.
