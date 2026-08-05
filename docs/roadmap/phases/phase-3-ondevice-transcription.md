# Phase 3 — On-Device Transcription Implementation Plan

The plan for on-device transcription — Whisper via `@huggingface/transformers` in a Web Worker, in a new `@azx/ribo-transcriber-ondevice` package. Phase 3 is complete.

**Goal:** speak into the playground, and get a real transcript back — computed on the device, with no network after a one-time model download. This is the project's central technical bet, and this phase is where it stops being an assumption.

**Architecture:** a new package `@azx/ribo-transcriber-ondevice` implementing `ribo-core`'s `Transcriber` interface, wrapping `@huggingface/transformers` and running Whisper in a Web Worker. It is a **separate package** because transformers.js pulls `onnxruntime-node` and `sharp` as hard dependencies with postinstall scripts — every `ribo-core` consumer would inherit them, including hosts that never transcribe on-device.

**Tech Stack:** `@huggingface/transformers` ^4.2.0, `whisper-base.en`, WebGPU, Web Worker, Cache API.

## Scope decision: the happy path only

**Target: evergreen Chromium with WebGPU — Surface tablets and desktop.** iOS is explicitly **out of scope for this phase**.

That is a deliberate narrowing, and it defers real work: engine sniffing, the WASM single-threaded path, and the managed Azure STT fallback (which existed to serve devices that cannot run on-device). Those remain designed and documented in [`01`](../../implementation/01-feasibility-spike.md) and [`02`](../../implementation/02-server-stt.md); they are not deleted, just not built yet.

**The known gap, which must stay visible:** field devices were described as _"Surfaces but maybe also mobile phones."_ An auditor on an iPhone is unsupported on this path. Do not let that quietly become an assumption that everyone has a Surface.

## Global Constraints

Everything in [`AGENTS.md`](../../../AGENTS.md) applies, plus:

- **Never `?worker`.** The worker ships as a **published entry** (`@azx/ribo-transcriber-ondevice/worker`) and the consumer injects the factory. vitejs/vite#15618 is still open, and HF's own tutorial uses the app-only pattern that breaks in library mode — we get no help there.
- **Measure, do not cite.** No credible public browser RTF benchmark exists for any of these models; every circulating figure traces to one post with no methodology, and the only _measured_ datum shows WebGPU **slower** than WASM for Whisper. Numbers in this phase must come from our own runs.
- **Model weights are fetched at runtime, never bundled.** They already cache to the Cache API under `transformers-cache`.
- Dependencies catalog-pinned exact, in the new package's own manifest — **not** `ribo-core`'s.

---

### Task 1: Package scaffold

**Files:** `packages/ribo-transcriber-ondevice/*`

- Create the package following `AGENTS.md` §6 exactly — the `@azx/source` → `types` → `default` exports contract, `files: ["dist"]`, `sideEffects: false`, `@azx/tsconfig` in devDependencies (the bug we have already shipped once).
- `@azx/ribo-core` as a **peer** dependency (the consumer must share one core instance) mirrored in dev, per §6's workspace-dependency rule.
- Declare a **`./worker` subpath export** with all three conditions, including `@azx/source` pointing at the TypeScript source — otherwise the playground cannot exercise the worker without building the package first.
- **Move the placeholder `./worker` entry out of `ribo-core`.** It was added in Phase 2 anticipating this; the worker is this package's implementation detail, not core's. Nothing depends on the old path yet — do it now, before anything does.

### Task 2: Model loading, priming and cache

**Files:** `packages/ribo-transcriber-ondevice/src/*`

- **Explicit, user-initiated download with progress.** Decided already: no silent background fetch. A field tool quietly consuming an employee's cellular data is a support ticket. Expose download progress as an observable/callback — this is a ~165 MB operation and a UI that shows nothing is unusable.
- Set `env.backends.onnx.wasm.wasmPaths` **explicitly**. The default is a jsDelivr CDN URL, which breaks the offline guarantee and trips strict host CSPs; setting it also engages `useWasmCache` so the ORT runtime binary itself is cached. Remember the runtime adds ~24 MB on top of the model.
- Model: **`whisper-base.en`**. Make the model id configurable so `tiny.en` / `small.en` can be selected without a code change.
- **dtype: `fp32` — DECIDED (2026-07-23).** Task 2 found that q4 and q8 both throw at `InferenceSession` creation on the ORT dev build transformers.js 4.2.0 pins (`TransposeDQWeightsForMatMulNBits: Missing required scale … decoder.embed_tokens`); only `fp32` primes cleanly. For the PoC we take fp32 and do **not** chase a working quantized/fp16 export — it removes an iteration loop and fp32 is the one thing proven to load. Cost: `whisper-base.en` fp32 is ~290 MB (roughly 2× the q4 budget the docs still cite elsewhere), which the "make available offline" UX must reflect. Revisit (fp16 first — ~145 MB, WebGPU-preferred, no dequant scales) only if download size becomes a real pilot blocker.
- Expose whether the model is **already cached**, so the UI can distinguish "download required" from "ready".

### Task 3: `OnDeviceTranscriber`

**Files:** `packages/ribo-transcriber-ondevice/src/*` + browser tests

- Implement `ribo-core`'s `Transcriber`. It must be substitutable for `FakeTranscriber` — the queue relay should need no changes at all.
- Run inference **in a Web Worker**, constructed by a consumer-supplied factory with a best-effort default that throws an actionable error naming the option when it fails.
- **Wire `TranscribeHints` to Whisper's `prompt_ids`.** This is the decisive reason Whisper was chosen over Moonshine and Parakeet, which expose no biasing hook at all: we prime the decoder with domain jargon (R-value, CFM25, ACH50, AFUE, blower door, backdrafting). A prompt-biasable model at 8% WER beats a non-biasable one at 7% for our content.
- Batch, not streaming. Partials cost ~N× a batch transcription because Whisper re-encodes a zero-padded 30 s window; they are a later Chromium-only enhancement.
- Browser tests (`*.browser.test.ts`). Real inference is slow — consider a tiny model or a short clip for the gated tests, and keep the full measurement in Task 4.

### Task 4: Measure it — the actual spike

**Files:** `spikes/` or the package's test area

This is where the central bet gets checked. **Every number here must be produced by our own run.**

- Synthesize audio from the 14 existing `spikes/extraction-snuggpro/transcripts/*.txt` via TTS. We authored those, so we have **exact** ground-truth text — which makes WER directly computable with no consent dependency.
- Measure, on Chromium + WebGPU: **real-time factor** (processing time ÷ audio duration), **WER** against the source text, model **load time** cold and warm, and **peak memory**.
- Run the resulting transcripts through the existing extraction scorer (`spikes/extraction-snuggpro/score.mjs`) to measure the **transcription→extraction interaction** — the thing the extraction spike explicitly could not test, since it ran on clean text.
- State the limitation plainly: **TTS audio is cleaner than real field speech** — no background noise, no mic handling, no disfluent delivery, no cross-talk. A floor, not a forecast, and not a substitute for the real-recording gate.

### Task 5: Playground — the payoff

**Files:** `playground/src/*`

- A "make available offline" control that downloads the model with visible progress, and reports when it is cached.
- Transcribe a queued recording and show the text. The queue already has a `transcribing` step and a relay — use them rather than bypassing.
- **Verify it offline:** prime the model, cut the network, record, transcribe. That is the phase's whole claim and it should be demonstrable in the UI.

---

## Definition of done

- Speak into the playground → a real transcript, computed on-device.
- With the model primed and the **network cut**, recording and transcription still work.
- We have our **own** measured RTF and WER numbers on Chromium+WebGPU, and know what happens end-to-end through extraction.
- `@azx/ribo-transcriber-ondevice` is a proper published-shape package, and `ribo-core` has no transformers.js dependency.
- `./check.sh` green.

## Deliberately NOT in Phase 3

iOS/Safari support, engine sniffing, the WASM single-threaded path, managed Azure STT, streaming partials, real-recording validation (still gated on consent), and any transformers.js dependency inside `ribo-core`.
