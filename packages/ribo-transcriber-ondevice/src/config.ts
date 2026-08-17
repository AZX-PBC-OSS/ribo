/**
 * @file Consumer-facing configuration for {@link ../index.ts OnDeviceTranscriber} and the model
 * download-size registry.
 *
 * The one non-negotiable option is {@link OnDeviceTranscriberOptions.wasmPaths}: it is **required**
 * on purpose. A published library cannot ship the ONNX Runtime `.wasm`/`.mjs` files into an
 * arbitrary consumer's bundler, and the transformers.js default points them at a jsDelivr CDN —
 * which breaks the offline guarantee this whole phase exists to make good, and trips strict host
 * CSPs (doc 01 §Recommendation, doc 10 §4). Forcing the consumer to name a same-origin path is the
 * honest shape: there is no hidden CDN fallback to paper over a missing config.
 */
import type { OnnxDtype } from "./protocol.js";

/**
 * Domain-jargon priming for the Whisper decoder. Mirrors `TranscribeHints` as designed in
 * `docs/implementation/03-ribo-core.md` — deliberately re-declared in this package rather than
 * imported from `ribo-core`, because `ribo-core`'s shipped `Transcriber.transcribe(recording, audio)`
 * carries **no** hints argument (it is a documented, still-deferred additive change). Wiring hints
 * through a third parameter would change that interface and break relay substitutability; instead the
 * vocabulary is supplied once at construction (the adapter's domain vocabulary is the natural source,
 * doc 03) and applied to every transcription this instance runs.
 *
 * **Hints are Whisper-only, and that is now a constraint rather than a reason.** This comment used to
 * read "the decisive reason Whisper was chosen over Moonshine/Parakeet: those expose no biasing
 * hook." The default model is now Moonshine, chosen on latency (see
 * `docs/roadmap/design/live-transcription-design.md`), and priming does not come with it.
 *
 * Not for want of a mechanism — `MoonshineForConditionalGeneration` declares `decoder_input_ids` in
 * its `forward_params`, so the prefix is reachable. It does not *work*, and it fails destructively.
 * Measured (`moonshine-priming.manual.ts`): given a jargon prefix, Moonshine echoes the prefix, emits
 * a comma, and stops. The audio is never transcribed at all.
 *
 *   baseline  "We are starting the walk-thru at the front of the house, the blower door test…"
 *   primed    "R-value, CFM50, ACH50, blower door, backdrafting, zorbulator,"
 *
 * The cause is visible in the tokenizer: Moonshine reports `special_tokens: []`. Whisper's priming
 * works because `<|startofprev|>` is a *trained* control token marking a region the decoder learned
 * to condition on without emitting. With no such token there is no such region, so a prefix is simply
 * text to continue.
 *
 * Hence {@link modelSupportsHints} and the hard failure it drives: silently ignoring hints would let
 * a caller believe they are primed when they are not, and silently applying them would return that
 * comma as somebody's transcript.
 *
 * See {@link ../worker.ts} for how the assembled text becomes a `decoder_input_ids` prefix on the
 * models that do support it (transformers.js 4.2.0's `prompt_ids` field is inert — a Task 3 finding).
 */
export interface TranscribeHints {
  /** Domain jargon to bias decoding toward, e.g. `["R-value", "CFM50", "AFUE", "backdrafting"]`. */
  readonly vocabulary?: readonly string[];
  /** Free-text priming, when a phrase list is the wrong shape. Appended after the vocabulary. */
  readonly prompt?: string;
}

/**
 * Assemble hint text into the single priming string the worker tokenizes. Pure and exported so the
 * hint → prompt logic is unit-testable in node without a model. Returns `undefined` when there is
 * nothing to prime with, which the worker reads as "no `decoder_input_ids` prefix".
 */
export function buildHintPrompt(hints: TranscribeHints | undefined): string | undefined {
  if (!hints) return undefined;
  const parts: string[] = [];
  if (hints.vocabulary && hints.vocabulary.length > 0) {
    // Comma-joined phrase list, the shape Whisper prompts respond to best for vocabulary biasing.
    parts.push(
      hints.vocabulary
        .map((term) => term.trim())
        .filter(Boolean)
        .join(", "),
    );
  }
  if (hints.prompt && hints.prompt.trim()) parts.push(hints.prompt.trim());
  const prompt = parts.join(". ").trim();
  return prompt.length > 0 ? prompt : undefined;
}

/**
 * Whether `modelId` can be primed with a decoder prefix — see {@link TranscribeHints}.
 *
 * **Deliberately name-based, not capability-probed.** The honest check is "does this tokenizer have a
 * `<|startofprev|>`-equivalent control token", which needs the tokenizer — and the tokenizer needs a
 * download. Refusing bad wiring has to happen at construction, before any network, or the error
 * arrives after a 250 MB fetch and mid-recording. A prefix substring is a coarse test that fails in
 * the safe direction: an unknown model is treated as unable to prime, so the worst case is hints
 * being refused for a model that could have used them, never applied to one that cannot.
 */
export function modelSupportsHints(modelId: string): boolean {
  return /whisper/i.test(modelId);
}

/**
 * Default model.
 *
 * **Moonshine, not Whisper, since the live-transcription work.** Whisper pads every input to its 30 s
 * receptive field before the encoder runs, so cost is set by the window rather than by the speech —
 * measured at 1.26× across a 14.5× range of audio, i.e. a 2-second utterance costs what a 29-second
 * one does. Moonshine's feature extractor passes audio through unpadded and is 4–16× faster at the
 * lengths that matter. See `docs/roadmap/design/live-transcription-design.md`.
 *
 * **What this costs:** domain-jargon priming, which does not exist on Moonshine ({@link
 * TranscribeHints}). `docs/implementation/14` measured hints at up to −18.1 pp WER on the
 * jargon-dense combustion-safety transcript, so this is not a free swap and the replacement figures
 * must be measured on the same corpus before it is treated as settled.
 *
 * Overridable via {@link OnDeviceTranscriberOptions.modelId}, and any `whisper-*` id restores the
 * previous behaviour including hints.
 */
export const DEFAULT_MODEL_ID = "onnx-community/moonshine-base-ONNX";

/**
 * One-time download totals per known model, **including the ~24 MB Chromium ONNX Runtime binary** —
 * the addend doc 01 calls out as routinely forgotten in model-size arithmetic, and which
 * `ribo-core`'s `needs-download` capability requires be counted (`transcriber.ts`). These feed the
 * consent screen only.
 *
 * These are **fp32** figures: q4/q8 do not load on the ORT build transformers.js 4.2.0 pins, so the
 * PoC ships fp32 (~2x the quantized budget older docs cite). `base.en` is MEASURED — ~290 MB weights
 * + ~24 MB runtime = ~314 MB, from Task 4 (`docs/implementation/14-transcription-measurement.md`).
 * `tiny.en`/`small.en` are still fp32 estimates, scaled from the parameter counts, not measured.
 */
export const MODEL_DOWNLOAD_BYTES: Readonly<Record<string, number>> = {
  "Xenova/whisper-tiny.en": 175_000_000, // estimate (fp32)
  "Xenova/whisper-base.en": 314_000_000, // MEASURED (fp32, Task 4)
  "Xenova/whisper-small.en": 970_000_000, // estimate (fp32)
  "onnx-community/whisper-tiny.en": 175_000_000, // estimate (fp32)
  "onnx-community/whisper-base.en": 314_000_000, // MEASURED (fp32, Task 4)
  "onnx-community/whisper-small.en": 970_000_000, // estimate (fp32)
  // Encoder + merged decoder, fp32, read from the Hub blob sizes.
  "onnx-community/moonshine-base-ONNX": 247_000_000,
  "onnx-community/moonshine-tiny-ONNX": 109_000_000,
};

/** Fallback total for an unrecognized model id — base.en-ish, so the bar is never absurdly wrong. */
export const FALLBACK_DOWNLOAD_BYTES = 314_000_000;

/**
 * The voice-activity model used to segment recordings longer than Whisper's 30 s receptive field.
 *
 * `pyannote-segmentation-3.0` rather than Silero, which is smaller, because transformers.js already
 * supports it (`PyAnnoteForAudioFrameClassification` ships in 4.2.0): it reuses the same cache
 * bucket, the same download-progress relay, the same same-origin ORT config and the same worker,
 * where Silero's stateful RNN would need a second loading path through raw `onnxruntime-web`. It is
 * also what WhisperX uses.
 */
export const VAD_MODEL_ID = "onnx-community/pyannote-segmentation-3.0";

/**
 * The streaming voice-activity model for live transcription — a **second** VAD, separate from
 * {@link VAD_MODEL_ID}'s batch path.
 *
 * `onnx-community/silero-vad` loads through the same `@huggingface/transformers` we already pin
 * (via `AutoModel.from_pretrained` with `config: { model_type: "custom" }`, not raw
 * `onnxruntime-web` — the spike confirmed this works under the same `wasmPaths` config the ASR
 * path uses). It is frame-synchronous — 512 samples (32 ms) at a time, carrying its own recurrent
 * state tensor — where pyannote's 10-second windows make a frame's value non-final until 5–10 s
 * of later audio exists. That settle latency is why Silero, not pyannote, is the live VAD.
 *
 * Measured in the spike: 2.14 MB fp32 weights, 0.20 ms per frame inference. See
 * `docs/roadmap/design/live-spike-findings.md` for the input/output contract and the
 * state-carrying evidence.
 */
export const STREAMING_VAD_MODEL_ID = "onnx-community/silero-vad";

/** fp32 weights for {@link STREAMING_VAD_MODEL_ID} — measured in the spike: 2.14 MB. */
export const STREAMING_VAD_DOWNLOAD_BYTES = 2_200_000;

/**
 * Default worker-reply budget: 10 minutes.
 *
 * Sized from the measured worst case rather than guessed — RTF ~0.16 means a 30-minute
 * recording is ~5 minutes of inference, and a cold fp32 load adds to that. A tighter
 * default would fail real work on a slow phone; the purpose here is to bound the
 * unbounded, not to be precise.
 */
export const DEFAULT_WORKER_TIMEOUT_MS = 600_000;

/** fp32 weights for {@link VAD_MODEL_ID} — 1.9% of the ASR download it rides alongside. */
export const VAD_DOWNLOAD_BYTES = 6_000_000;

/**
 * Best-effort download-size estimate for the consent screen.
 *
 * `includeVad` exists because the two callers want different numbers. The one-time consent prompt
 * needs the full figure; `capability()` needs only what is actually **missing**, since telling a
 * user with Whisper already cached that they need another ~314 MB — when they need 6 MB — is a
 * false prompt that would talk them out of a trivial download.
 */
export function estimateDownloadBytes(modelId: string, includeVad = true): number {
  const asr = MODEL_DOWNLOAD_BYTES[modelId] ?? FALLBACK_DOWNLOAD_BYTES;
  return includeVad ? asr + VAD_DOWNLOAD_BYTES : asr;
}

/**
 * Options for {@link ../index.ts OnDeviceTranscriber}.
 */
export interface OnDeviceTranscriberOptions {
  /**
   * **Required.** Same-origin base URL the ORT `.wasm`/`.mjs` runtime files are served from, e.g.
   * `"/ort/"`. Assigned to `env.backends.onnx.wasm.wasmPaths` inside the worker. The consumer
   * copies `onnxruntime-web/dist/ort-wasm-simd-threaded*.{wasm,mjs}` into a static dir they serve
   * and points this at it. See the package README / doc 01 for why this cannot be defaulted.
   */
  readonly wasmPaths: string;
  /**
   * Factory that constructs the inference worker. **The supported path** (AGENTS §5.2): library
   * code must never reach `new Worker(...)` through a `?worker` import (vitejs/vite#15618), so the
   * consumer builds it in their own bundler context. Omitted, a best-effort default is used that
   * throws an actionable error naming this option if it cannot construct the worker.
   */
  readonly createWorker?: () => Worker;
  /** ASR model repo id. Defaults to {@link DEFAULT_MODEL_ID}. */
  readonly modelId?: string;
  /** ORT execution provider. Omitted lets transformers.js auto-select. */
  readonly device?: "webgpu" | "wasm";
  /** Optional weight quantization passed through to the pipeline. */
  readonly dtype?: OnnxDtype;
  /**
   * HuggingFace Hub revision (branch, tag, or full commit hash) to fetch `modelId` at. Omitted
   * defaults to transformers.js's own default, `"main"` — the moving branch tip, which is fine for
   * an app but not for anything that must be reproducible across runs. Pin a commit hash wherever
   * an upstream push to the model repo must not silently change what downloads and runs. Forwarded
   * verbatim as `PrimeConfig.revision` (`./protocol.ts`) to the worker's `pipeline()` call.
   */
  readonly revision?: string;
  /**
   * Domain-jargon priming applied to every transcription this instance runs. Supplied at
   * construction because `ribo-core`'s `Transcriber.transcribe` takes no hints argument (see
   * {@link TranscribeHints}). Omitted means unbiased decoding.
   */
  readonly hints?: TranscribeHints;
  /**
   * How long to wait for a worker reply before treating the request as failed.
   *
   * Defaults to {@link DEFAULT_WORKER_TIMEOUT_MS}. It exists because a worker can die
   * WITHOUT firing `error` — which is the shape an out-of-memory kill takes, and the most
   * likely failure on a long recording (peak RSS was measured at ~3.5 GB for base.en fp32
   * on ≤30 s clips, on a laptop). Unbounded, that silence strands the relay's serial
   * drain forever and every capture behind it with it.
   *
   * Generous by default: this budget covers a cold model load AND inference over a
   * multi-minute recording, so it must not fire on a slow device merely doing its job.
   * A wrong-but-large timeout still converts a bricked queue into a retryable failure;
   * a wrong-but-small one invents failures that were about to succeed.
   */
  readonly workerTimeoutMs?: number;
  /** Override the {@link estimateDownloadBytes} figure the consent screen shows. */
  readonly downloadBytes?: number;
  /**
   * Cache API instance the "is it cached?" probe reads. Defaults to `globalThis.caches`. Injectable
   * so the cache logic is unit-testable in node, where there is no `caches` global.
   */
  readonly cacheStorage?: CacheStorage;
  /**
   * Real-time-factor threshold above which `capability()` reports `too-slow`. Defaults to
   * `DEFAULT_RTF_THRESHOLD` (3, provisional — refine with measured Surface Go 3 numbers).
   *
   * A device whose measured RTF exceeds this is permanently demoted: `too-slow` is in
   * `PERMANENT_TRANSCRIBER_UNAVAILABLE_REASONS`, so `firstCapable` stops re-probing it and
   * the managed engine is selected instead. Set higher to tolerate slower devices, lower to
   * route to the managed engine sooner.
   */
  readonly rtfThreshold?: number;
}

/**
 * The best-effort default worker factory (AGENTS §5.2). Uses the standard
 * `new Worker(new URL(...), { type: "module" })` form — **not** a `?worker` import — and rethrows
 * any failure with a message that names `createWorker`, because the common failure (a host bundler
 * that cannot resolve the published `./worker` entry from a bare `new URL`) is otherwise opaque.
 */
export function defaultCreateWorker(): Worker {
  try {
    return new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  } catch (cause) {
    throw new Error(
      "OnDeviceTranscriber could not construct its worker with the built-in default. Supply a " +
        "`createWorker` factory that builds `@azx/ribo-transcriber-ondevice/worker` in your app's " +
        "bundler context (see AGENTS.md §5.2).",
      { cause },
    );
  }
}
