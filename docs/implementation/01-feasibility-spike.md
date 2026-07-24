# 01 — On-Device Transcription Feasibility Spike

**Do this first.** It's the highest-uncertainty item and it decides whether on-device WASM is the default transcription path or whether the managed Azure STT path carries more of the load. Time-boxed; a failure is cheap to absorb, because the managed STT path is already the designed fallback.

## The question, narrowed (2026-07-23)

The **target platform baseline is now decided** ([open questions §4](../open-questions.md)): evergreen Chromium on Windows (current − 2) for the Surface tablets, Safari on iOS/iPadOS (current − 1 major), Chrome on Android (current − 2). WebGPU, WASM SIMD, OPFS, IndexedDB, MediaRecorder, Web Workers, `crypto.randomUUID` and top-level await are therefore **assumed present**.

That settles **capability, not performance** — and this spike was always mostly about performance. "WebGPU is available on this device" is not "Whisper runs faster than real-time on this device's GPU." A phone GPU that exposes the API can still be several times too slow, or thermally throttle after two minutes of an attic walkthrough.

It also turns out not to settle capability as cleanly as it reads: on iOS the browser exposes WebGPU while the library we ship **cannot use it** (research pass, Finding 1 below). Browser capability and _reachable_ capability are different things.

So the spike **narrows; it does not disappear**:

- ~~Can a WASM Whisper model _run at all_ on these devices?~~ — **answered by the baseline.** Do not spend spike time on capability probing for its own sake.
- **How fast, how accurately, and on which device class?** — still open, still the whole point.

**Question to answer:** at what **real-time factor** and **word error rate** does a WASM Whisper model transcribe auditor speech on each device class in the baseline — and which classes clear the bar for on-device-by-default?

## Research pass (2026-07-22) — what is known before we measure

A desk-research pass ran ahead of the spike to pick the runtime and model, and to stop the spike burning its budget on candidates that cannot ship. It changed the shape of the spike materially, so it is recorded here rather than in a side document.

### Evidence grades — read these markers, they are the point

Everything below carries one of three tags, and they are **not** decoration. The most valuable output of this research pass is knowing which claims are load-bearing and which are somebody's marketing:

- **[verified by inspection]** — established by unpacking published artifacts or reading source. Trustworthy.
- **[vendor-claimed]** — asserted by a vendor, maintainer or README. Plausible, unconfirmed.
- **[unmeasured]** — nobody has a number, including us. Must not be planned against.

### Finding 1 — iOS gets no WebGPU code path at all **[verified by inspection]**

`@huggingface/transformers` v4 **deliberately serves Safari a different ONNX Runtime build**, one that contains no WebGPU code. It hard-codes `ort-wasm-simd-threaded.{mjs,wasm}` for Safari and `.asyncify.*` for everyone else. The Safari binary contains **zero** WebGPU references and is **12.9 MB against 23.6 MB** for the other build.

Established by unpacking the published tarballs of `@huggingface/transformers@4.2.0` and `onnxruntime-web@1.26.0-dev.20260416` — **not** from documentation, which does not mention this.

**Consequence: on iOS you get WASM CPU inference regardless of the `device` you request.** The split is defensive, and the reasons are public: ORT [#26827](https://github.com/microsoft/onnxruntime/issues/26827) reports WebKit 26 at 400%+ CPU with memory growth to 14 GB before crashing; [#27584](https://github.com/microsoft/onnxruntime/issues/27584) reports crashes after roughly 500 WebGPU inferences on iOS 26.3. **Both were closed by a stale bot, not fixed** — so the underlying defects should be assumed live.

**The trap, and it is ours to avoid:** transformers.js's `isSafari()` check excludes `CriOS` / `FxiOS` / `EdgiOS`, so **Chrome on iPhone receives the asyncify build** — precisely the configuration those crash reports describe. We must sniff the **engine**, not the brand, and force the Safari path for all iOS browsers.

### Finding 2 — the circulating performance numbers are fabricated **[verified by inspection]**

Every browser real-time-factor figure in circulation traces back to [one SEO post dated 2026-04-28](https://offlinetts.com/blog/browser-speech-recognition-whisper-comparison/) with no device specs, no library versions, no audio samples and no stated procedure. It is not a benchmark.

The only **measured** browser data we could find ([transformers.js #894](https://github.com/huggingface/transformers.js/issues/894), M2 Mac mini, 60 s of audio) shows **WebGPU _slower_ than WASM** for Whisper — 9.5 s against 5.9 s — because Whisper's small encoder/decoder loops are dispatch-bound, not FLOP-bound.

**Standing caution: no credible public browser RTF benchmark exists for any of these models.** This spike must therefore **measure rather than cite**, and "WebGPU is faster" is an assumption we are not permitted to carry into a plan.

### Revised device matrix

Capability is assumed per the baseline; the column that matters is throughput. Finding 1 changes the iOS row from a performance unknown into a known architectural constraint.

| Class                               | Baseline entry            | Backend actually available                                          | Open question                                                                    |
| ----------------------------------- | ------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Surface tablet (Windows + Chromium) | Chrome/Edge, current − 2  | WebGPU or WASM-SIMD                                                 | Expected to clear the bar comfortably — confirm, don't assume                    |
| iPhone / iPad (Safari _or_ Chrome)  | Safari, current − 1 major | **WASM only** — no WebGPU code in the shipped binary **[verified]** | Throughput at (likely) **one thread**. The hard case, and harder than we thought |
| Android phone (Chrome)              | Chrome, current − 2       | WebGPU or WASM-SIMD                                                 | Widest hardware spread — one datum won't characterise the class                  |

**This revises the previous matrix.** iOS was recorded as "WebGPU present, sustained throughput unknown." That was wrong: iOS is **WASM-only and probably single-threaded**, and requesting `device: 'webgpu'` there does something we have not yet observed ([open questions §10](../open-questions.md)).

**Still needed:** representative hardware per class (SoC/GPU generation, RAM), because within a browser baseline the silicon is what decides throughput. This is a **sampling** question, not a blocking scoping one — the spike can start on whatever devices are to hand and widen.

### Recommendation carried into the spike

- **Library: `@huggingface/transformers` ^4.2.0** — the only viable option, chosen **by attrition** rather than by preference. Moonshine has strong research behind it (v2 paper, streaming encoders) but **no shippable browser artifact**: `moonshine-js` wraps transformers.js v3 and runs gen-1 models only (last publish 2025-07-03), and the newer WASM port is not on npm and needs COOP/COEP or a build from source. `@transcribe/shout` requires COOP/COEP unconditionally. Vosk, whisper-turbo and ratchet are dead on npm. Parakeet and Voxtral are 454 MB–2.5 GB — impossible for a field tablet's one-time download.
- **Model: `whisper-base.en`** (~142–165 MB), with **`tiny.en`** (~96 MB) as the low-end fallback and **`small.en`** (~300 MB) as an accuracy escape hatch, selected at download time from a device probe. **Add ~13 MB (Safari) / ~24 MB (Chromium) for the ORT runtime binary itself** — real one-time download that is routinely forgotten in model-size arithmetic, and it belongs in the prime-on-first-launch progress UI ([09](09-offline-first.md)).
- **The decisive reason for Whisper is not accuracy — it is `prompt_ids`.** See [03](03-ribo-core.md); it is a transcriber-interface consequence, not just a model choice.
- **Backend policy:** WebGPU on Chromium, WASM-SIMD single-thread-safe everywhere else. **Never require COOP/COEP** — the candidates that did were disqualified for it.
- **Delivery:** self-host the ORT `.wasm`/`.mjs` and the model weights, and set `wasmPaths` explicitly ([10 §4](10-build-and-packaging.md)).
- **Streaming:** **batch stays the contract.** Partials are demonstrated on Chromium+WebGPU but cost roughly N× a batch transcription, because Whisper re-encodes a zero-padded 30 s window each time — unaffordable on single-threaded WASM iOS. Ship partials as a **Chromium-only progressive enhancement, off by default**.

## Method

- Runtime: `@huggingface/transformers` ^4.2.0. `whisper.cpp`-WASM stays as a comparison point only if time allows — the packaging research (above) already rules out the wrappers that would make it shippable without COOP/COEP.
- Candidate models: `whisper-base.en` first (English-only per spec), fall back to `tiny.en` if too slow, try `small.en` if accuracy is short.
- **Measure both backends where both exist**, and do not assume the ordering — the one measured data point available has WASM beating WebGPU for Whisper (Finding 2).
- Fixed audio sample set. Real home-energy audit dictation clips are **not available** — the in-home recording-consent path is deferred ([open questions §8](../open-questions.md), [07](07-testing-and-accuracy.md)). Use the **TTS-synthesized audio path** proposed below, and read its limitations before quoting any number that comes out of it.
- Measure, per device × runtime × model: **real-time factor** (processing time ÷ audio length), **word error rate** vs. a hand-checked reference, **cold-load time** (model download + init), **peak memory**.

## Go / no-go criteria

- **On-device is default for a device class** if RTF < ~1.0 (keeps up) _and_ WER is low enough that the downstream extractor can recover the measure-relevant fields.
- **A device class falls back to the managed Azure STT path** if it can't hit that. Note the justification has shifted: the fallback is no longer there because a device might _lack_ WebGPU or WASM SIMD — the baseline says it doesn't — but because a device that has them may still be **too slow or too inaccurate** to run the model on the audio lengths an audit walkthrough produces. It is a **performance** fallback now, and it should be argued that way in front of anyone who asks why we ship two transcription paths.
- If _no_ class clears the bar, on-device becomes a fast-follow and the managed STT path ships the pilot (a named descope lever, [08](08-risks-and-sequencing.md)).
- **iOS is now the likeliest class to fall back**, and for an architectural reason rather than a throughput one (Finding 1). The two live sub-questions — what `device: 'webgpu'` actually does there, and the single- vs multi-thread WASM penalty — are [open questions §10 and §11](../open-questions.md). §10 is a ~30-minute experiment that decides whether iOS is on-device-batch-only or managed-STT-primary; **run it before anything else in this spike.**

## Deliverables

- A short spike report (numbers per device/runtime/model + recommendation).
- A `capability probe` function that `ribo-core`'s `Controller` uses to pick `OnDeviceTranscriber` vs `ManagedTranscriber` at runtime ([03](03-ribo-core.md)). Given the baseline, its **feature-detection half shrinks to a cheap safety net** (it should still not crash on an out-of-baseline browser) and its **micro-benchmark half becomes the load-bearing part** — the routing decision is now a throughput measurement, not an API-presence check.
  - One feature-detection job does **not** shrink: **engine sniffing for iOS**. `IS_WEBGPU_AVAILABLE` is `true` on iOS while the shipped runtime has no WebGPU path, and transformers.js's own `isSafari()` misses `CriOS`/`FxiOS`/`EdgiOS` (Finding 1). The probe must detect the **engine** and route all iOS browsers to the WASM path, rather than trusting either the vendor check or the capability flag.
- The **model-size decision rule** the download step uses to choose `tiny.en` / `base.en` / `small.en` per device, including the ORT runtime binary in the quoted total.

## Proposed sub-spike: TTS-synthesized audio (not yet implemented)

**Status: a proposal.** Nothing below has been built. It is written down here because it is the one path that unblocks **end-to-end** measurement while the recording-consent question is deferred.

### What it does

1. Take the **14 existing transcripts** in `spikes/extraction-snuggpro/transcripts/*.txt` — synthetic auditor dictations already written to stress the hard cases.
2. Run each through **text-to-speech** to synthesize audio.
3. Feed that audio to **on-device Whisper** and measure **WER against the known-exact source text**. The ground truth is perfect by construction: we authored the text, so there is no hand-transcription step and no reference-transcript ambiguity. This is a genuinely better WER measurement than a hand-checked real recording would give.
4. Then feed **the Whisper output** — not the clean source text — into the extraction step, and re-score it against `spikes/extraction-snuggpro/ground-truth/`.

### Why step 4 is the valuable part

Step 4 measures the **transcription → extraction interaction**, which **no test we have has ever touched**. The extraction spike (`spikes/extraction-snuggpro/`) explicitly could not cover it: it runs on clean authored text, and its own README says so — real input arrives through a WASM Whisper model at some word error rate. The feasibility spike measures WER in isolation. Neither answers the question that actually decides the product: _does a 12% WER transcript still yield the right AFUE, or does it yield a confidently wrong one?_

The specific things to look for, since they are cheap to check once the pipeline exists:

- Does a mis-transcribed **number** (`R-19` → `R-90`, `92` → `82`) survive into a non-null field with high confidence? That is the worst failure mode in the system.
- Does WER concentrate in **domain jargon** (AFUE, HSPF, CFM50, ACH50, kneewall, soffit) — the exact tokens the extractor depends on — while overall WER looks acceptable?
- Does `sourceSpan` validity collapse? The spans are checked as verbatim substrings of the transcript; if the transcript is now the Whisper output, the check still works, but a span quoting a garbled phrase is much less useful to a reviewing auditor.
- Do the two **hallucination probes** (transcripts 03 and 09) behave differently when the "nothing in the attic" denial is itself mis-transcribed?

### The limitation — state it every time the numbers are quoted

**TTS audio is cleaner than real field speech.** It has no background noise (no running furnace, no blower door), no microphone handling or placement variation, no disfluent delivery (real dictation has restarts, trailing off, mid-word corrections), no cross-talk with a homeowner, no room acoustics — no attic, no crawlspace, no basement reverb — and none of the accent and pacing variation across 51→59 assessors.

Every one of those makes real WER **worse**, and the extraction accuracy that rides on it worse again.

So: **a floor, not a forecast.** A good result means "the pipeline is not obviously broken end to end, proceed." It does **not** mean transcription or extraction accuracy is validated, and it **does not replace the real-recording gate** ([07](07-testing-and-accuracy.md)) that must clear before any field use.

### Size

**S** — the corpus and ground truth already exist; the new work is TTS synthesis, a WER scorer, and re-pointing the existing extraction scorer at Whisper output instead of the source text.

## Size

**S** (relative t-shirt) — time-boxed, up front, before locking transcription implementation. Narrowed by the platform baseline: the capability half of the question is already answered, so the whole budget goes to measurement.
