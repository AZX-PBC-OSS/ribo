# Live transcription spike — Silero VAD + AudioWorklet findings

**Date:** 2026-08-11

> **The probe code is not committed.** Both probes were small and single-purpose — a manual Silero
> loader and a worklet browser test — and their value is the numbers below, which they will not be
> re-run to produce. Reproducing any of this means writing the probe again, which is cheaper than
> maintaining one nobody runs. Where a figure below matters to a decision, the method is described
> precisely enough to repeat.

## Q1 — Does Silero load in OUR worker/ORT setup?

**Yes.** Silero VAD loads through `AutoModel.from_pretrained("onnx-community/silero-vad", { config:
{ model_type: "custom" }, dtype: "fp32" })` under the same `env.backends.onnx.wasm.wasmPaths`
configuration the ASR and pyannote VAD paths already use. The ORT runtime is served same-origin
from `__ORT_WASM_BASE__` (the `/@fs/` path into `node_modules/.pnpm/onnxruntime-web@.../dist/`),
never from a CDN.

### What happened

transformers.js logs two warnings, both expected and harmless:

```
Unknown model class "custom", attempting to construct from base class.
[resolve_model_type] Architecture(s) not found in MODEL_TYPE_MAPPING: [(none)]
for model type 'custom'. Falling back to EncoderOnly (single model.onnx file).
```

`AutoModel` has `BASE_IF_FAIL = true`, so `model_type: "custom"` falls through to the base
`PreTrainedModel`, which uses `encoder_forward` — the same default path that runs any unrecognized
single-ONNX-file model. No second loading path through raw `onnxruntime-web` is needed; Silero
loads through the same `@huggingface/transformers` import the worker already uses.

### Measured numbers

| metric                           | value       |
| -------------------------------- | ----------- |
| weights (fp32, model.onnx)       | **2.14 MB** |
| first-frame P(speech) on silence | 0.0443      |
| load + first inference (cold)    | ~2.4 s      |

The 2.14 MB figure is the sum of per-file `total` values from the `progress_callback`. The Hugging
Face Hub lists `model.onnx` at 2.24 MB — the small discrepancy is the difference between the HTTP
`Content-Length` and the bytes transformers.js reports in its progress events.

### Input/output contract (discovered, not assumed)

The Silero ONNX graph's input names are **`input`**, **`sr`**, and **`state`** — not
`input_values` as the Hugging Face reference snippet implies. The error when this is wrong is
opaque: `"Missing the following inputs: input, sr."`

| input   | type    | shape         | notes                                                                                     |
| ------- | ------- | ------------- | ----------------------------------------------------------------------------------------- |
| `input` | float32 | `[1, 512]`    | one audio frame; must be a Tensor, not a raw Float32Array (auto-dims `[512]` is rejected) |
| `sr`    | int64   | `[1]`         | `BigInt64Array.from([16000n])`                                                            |
| `state` | float32 | `[2, 1, 128]` | zero-initialised, threaded from `stateN`                                                  |

| output   | type    | shape         | notes                           |
| -------- | ------- | ------------- | ------------------------------- |
| `output` | float32 | `[1, 1]`      | P(speech), `data[0]`            |
| `stateN` | float32 | `[2, 1, 128]` | new state, thread to next frame |

---

## Q2 — Does the recurrent state actually carry?

**Yes — decisively.** Carrying the state produces materially different results from passing a
fresh zero state every frame: **312 of 313 frames differ**, with a maximum probability difference
of **0.29** — large enough to flip the design's hysteresis thresholds (enter at 0.3, leave at 0.1).

### Evidence

Synthetic audio: 10 s at 16 kHz, alternating 0.5 s of 200 Hz tone (amplitude 0.5) and 0.5 s of
silence. 313 frames of 512 samples. Two passes over the same audio:

| metric                          | carried state | fresh zero state |
| ------------------------------- | ------------- | ---------------- |
| inference time (total)          | 62 ms         | 56 ms            |
| per-frame inference             | **0.20 ms**   | 0.18 ms          |
| frames with different P(speech) | —             | 312/313          |
| max                             | ΔP            |                  | —   | **0.291** |

The first 20 frames of each pass show the difference clearly:

```
carried: 0.048, 0.046, 0.029, 0.043, 0.026, 0.043, 0.036, 0.043, 0.027, 0.043,
         0.030, 0.043, 0.029, 0.043, 0.026, 0.169, 0.319, 0.243, 0.199, 0.164

fresh:   0.048, 0.067, 0.064, 0.048, 0.043, 0.048, 0.067, 0.064, 0.048, 0.043,
         0.048, 0.067, 0.064, 0.048, 0.043, 0.099, 0.044, 0.044, 0.044, 0.044
```

The carried probabilities show the model learning from the silence-to-tone transition: P(speech)
rises gradually from 0.026 to 0.319 as the tone burst begins (frames 14–16), then adjusts
downward. The fresh probabilities show no temporal context — they repeat the same per-frame
pattern every 8 frames (the 512-sample / 128-sample quantum cycle within the tone burst) and
barely react to the onset (0.043 → 0.099 → 0.044).

**The state contract is testable.** The design's testing requirement — "pass the initial zero
state every time and speech detection still broadly works on clean audio, which is exactly why
this needs an explicit test: the bug is silent and shows up as clipped onsets in noise" — is
directly supported by this evidence. The fresh-state pass detects the onset (frame 15, P=0.099)
but immediately forgets it (frame 16, P=0.044), where the carried pass sustains it (P=0.319).

### Per-frame inference time

**0.20 ms/frame** on desktop Chromium (WASM, fp32). At 32 ms/frame (16 kHz, 512 samples), that is
0.6% of the frame budget — Silero inference is nowhere near the bottleneck. The design's
hysteresis + buffering + ASR dispatch loop has ~31.8 ms of headroom per frame before it even
matters.

---

## Q3 — Does an AudioWorklet work here at all?

**Yes.** An `AudioWorkletProcessor` that regroups 128-sample render quanta into 512-sample frames
runs in the repo's `browser` Vitest project (real Chromium via Playwright) and posts frames at
exactly 512 samples.

### What was tried

**Real-time `AudioContext` — did not work.** Headless Chromium's Vitest iframe starts an
`AudioContext` in "suspended" state (autoplay policy), and `resume()` does not resolve without a
user gesture. An oscillator has no external driver to force the graph to run, so `process()` is
never called and the test hangs until timeout. The recorder sidesteps this because a real
`MediaStream` (the fake device) drives the graph, but an oscillator alone cannot.

**`OfflineAudioContext` — works.** Renders the audio graph synchronously at maximum speed with no
autoplay restriction. The worklet's `process()` is called every render quantum, and frames are
posted via `this.port.postMessage` and collected on the main thread after the render completes.
This is both more reliable and more deterministic for a test that cares about frame sizes, not
real-time cadence.

### Evidence

20 frames of 512 samples rendered through an `OfflineAudioContext` at 16 kHz:

```
context: OfflineAudioContext
sample rate: 16000 Hz
render length: 10240 samples (0.64s)
render quantum: 128 samples
frame size: 512 samples (32 ms at 16000 Hz)
frames received: 20 (expected 20)
quanta per frame: 4
first frame has signal: true
```

Assertions verified:

- Every frame is exactly 512 samples (not 128, not 508, not 516).
- The render quantum is 128 — the Web Audio spec's fixed `AUDIO_WORKLET_QUANTUM_SIZE`, confirmed
  in Chromium, not assumed.
- 4 quanta per frame (512 / 128 = 4), exactly as the design assumes.
- Frame contents are the oscillator signal, not silence — the worklet is tapping the real audio
  graph.
- Frame indices increment sequentially (1, 2, 3, ..., 20).

### What this does NOT prove

The cadence question — "do frames arrive at ~32 ms intervals in real-time?" — is not answered
here. `OfflineAudioContext` renders at max speed, so all frames arrive at once. Measuring real-time
cadence requires a running `AudioContext` with a live `MediaStream`, which is the e2e project's
domain (the `browser` project's `--use-fake-device-for-media-stream` flag gives a synthetic stream
that would drive a real-time graph). The 32 ms figure is a design constant from Silero's frame
size and the 16 kHz sample rate, not something that needs re-deriving in a spike.

### The Blob URL approach works for tests

The processor source was inlined as a string and loaded via `new Blob([source], { type:
"application/javascript" })` + `URL.createObjectURL(blob)`. This is relevant to Q4 — see below.

---

## Q4 — How would a worklet module ship in a published package?

**Recommendation: a separate build entry, same as the existing `./worker` subpath.** Add
`worklet: "src/worklet.ts"` to `tsdown.config.ts`'s `entry` object and a `./worklet` subpath to
`package.json`'s `exports`. The consumer's bundler resolves `new URL("./worklet.js",
import.meta.url)` and emits the worklet as a separate asset.

### The three options, what each costs

#### Option A — separate build entry + `new URL("./worklet.js", import.meta.url)` (recommended)

This is exactly the pattern `@azx/ribo-transcriber-ondevice` already uses for its `./worker`
subpath. `tsdown.config.ts` declares `entry: { index: "src/index.ts", worker: "src/worker.ts" }`,
and `defaultCreateWorker` in `config.ts` calls `new Worker(new URL("./worker.js", import.meta.url),
{ type: "module" })`.

**Why it works:** the `sharedTsdown` config in `@azx/build-config` deliberately omits
`experimental.resolveNewUrlToAsset` (see the comment on the last line of
`packages/build-config/src/index.ts`). With it off, `new URL("./worklet.js", import.meta.url)`
passes through the build **verbatim** — confirmed by inspecting the built output:

```js
// dist/index.js, line 112 (ondevice package)
return new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
```

A consumer's bundler (Vite, webpack 5, Rollup, esbuild, Parcel) statically analyzes
`new URL(..., import.meta.url)` and emits the referenced file as a separate asset. The same
mechanism would apply to:

```ts
await audioContext.audioWorklet.addModule(new URL("./worklet.js", import.meta.url));
```

**What it costs:**

- One more entry in `tsdown.config.ts` and one more subpath in `package.json`'s `exports` — the
  same mechanical addition the `./worker` subpath already required.
- The worklet file is a separate published artifact in `dist/`, so `files: ["dist"]` already
  covers it.
- tsdown may split shared code into chunks (e.g., the built `worker.js` imports
  `./decode-K0sC0KzQ.js`). This is fine for `addModule`, which loads the script as a module — the
  consumer's bundler emits the chunks as separate assets and the imports resolve at runtime.

**What it does NOT cost:**

- No `createWorkletUrl` injection is needed. The vitejs/vite#15618 bug that forced `createWorker`
  injection is specific to `new Worker(...)` in library mode — `addModule(url)` just fetches the
  URL, so the bug does not apply.

#### Option B — inline the processor source as a string + `Blob` URL

This is what the Q3 test uses. The processor source is a string constant, wrapped in a `Blob`,
and loaded via `URL.createObjectURL(blob)`.

**Why it works:** the Blob URL is created at runtime — no bundler resolution, no separate file,
no `exports` subpath. It works in every environment that supports `AudioWorklet`.

**What it costs:**

- The processor source is a string, so no syntax highlighting, no type checking, no IDE support.
- The worklet code is bundled into the main chunk (a few hundred bytes — negligible).
- `blob:` URLs may trip strict CSPs (though `script-src blob:` is less restrictive than
  `worker-src blob:`).
- Debugging is harder — the worklet's source is not a file you can open in DevTools.

**When to use it:** as a fallback when the consumer's bundler cannot handle
`new URL(..., import.meta.url)` — increasingly rare. Or for a self-contained worklet with no
imports, which is the common case (a frame aggregator is ~30 lines).

**Critical limitation:** a Blob URL has no base URL, so if tsdown splits the worklet into chunks
with `import` statements, the imports will NOT resolve from a Blob URL. This approach only works
if the worklet is a single self-contained file — which a string constant guarantees by
construction, but a built entry does not.

#### Option C — inject the worklet URL (like `createWorker`)

Add `createWorkletUrl?: () => string` to `RiboOptions`, and the consumer provides
`new URL("./worklet.js", import.meta.url).href`.

**Why it is overkill:** the `createWorker` injection exists because of vitejs/vite#15618 — a
Vite library-mode bug that 404s `new Worker(...)` in production. `addModule(url)` does not use
`new Worker(...)`, so the bug does not apply. There is no known bundler bug that breaks
`addModule(new URL(..., import.meta.url))`. Adding an injection point for a non-existent problem
is API surface for no benefit.

### What `pnpm build:packages` already proves

The existing `./worker` entry in `@azx/ribo-transcriber-ondevice` is the proof of concept for
Option A. `pnpm build:packages` emits `dist/worker.js` (28.95 kB) alongside `dist/index.js`, and
the `exports` block resolves `./worker` to `dist/worker.js`. A `./worklet` entry would be an
identical mechanical addition — same `tsdown.config.ts` entry form, same `exports` shape, same
publint/attw validation. No new build machinery is needed.

The worklet would live in `ribo-core` (where `Recorder` lives, per the design), not
`ribo-transcriber-ondevice`. `ribo-core`'s `tsdown.config.ts` currently has a single entry
(`entry: { index: "src/index.ts" }`); adding `worklet: "src/worklet.ts"` is the same one-line
change `ribo-transcriber-ondevice` already made for its worker.
