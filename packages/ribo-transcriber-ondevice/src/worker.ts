/**
 * @file Worker entry for the `@azx/ribo-transcriber-ondevice/worker` subpath.
 *
 * The inference half of the package: it runs Whisper via `@huggingface/transformers` inside a Web
 * Worker. Per AGENTS.md §5.2 the worker ships as a **published entry**, constructed by a
 * consumer-supplied `createWorker` factory — library code never calls `new Worker(...)` via a
 * `?worker` import (vitejs/vite#15618). The `@azx/source` branch on this subpath points here at
 * source, so the playground can exercise the worker in-workspace without building `dist/` first.
 *
 * ## Task 2: priming, not inference
 *
 * This worker currently handles one message — `prime` — which constructs the ASR pipeline. That
 * download-and-cache step is the whole of Task 2: it proves the model comes down with visible
 * progress and lands in the `transformers-cache` bucket. Inference on a `Float32Array` (the
 * `transcribe` message, {@link TranscribeWorkerRequest}) is Task 3.
 *
 * ## Why `@huggingface/transformers` is imported dynamically
 *
 * The import lives **inside** the message handler, not at module top level, for two reasons:
 * transformers.js's Node entry pulls `onnxruntime-node` (a 210 MB native addon whose build script
 * we do not run), so a static import would make the node-side `worker.test.ts` — which only reads
 * {@link WORKER_ENTRY_NAME} — try to load it; and the whole point is to defer the heavy runtime
 * until the user explicitly primes. In a real worker this file is bundled for the web, where the
 * web entry (onnxruntime-web) is what resolves.
 *
 * ## It receives a `Float32Array`, never a `Blob` (doc 11 §4)
 *
 * Decode + resample cannot run here: `AudioContext`/`OfflineAudioContext` are `Exposed=Window` and
 * absent from `WorkerGlobalScope`. So Task 3's main-thread half decodes the queue's `Blob` to 16 kHz
 * mono PCM and transfers the samples; this worker only ever sees {@link TranscribeWorkerRequest}.
 */

import { WHISPER_SAMPLE_RATE } from "./decode.js";
import type {
  MainToWorkerMessage,
  PrimeConfig,
  PrimeProgress,
  TranscribeWorkerRequest,
  WorkerToMainMessage,
} from "./protocol.js";
import {
  planFallbackChunks,
  planVadChunks,
  rootMeanSquare,
  speechProbabilities,
  WHISPER_WINDOW_SECONDS,
} from "./segmentation.js";
import type { FrameGeometry, SampleRange } from "./segmentation.js";
import { RegionVad, createSileroDetector } from "./vad-stream.js";
import type { RegionFrameResult } from "./vad-stream.js";

/** The subpath this module is published under — the stable name of the worker entry. */
export const WORKER_ENTRY_NAME = "@azx/ribo-transcriber-ondevice/worker" as const;

// The transcribe request/prompt contract now lives in `protocol.ts` (it is a wire type, and Task 3
// changed its shape from `promptIds: number[]` to `prompt: string` — see the type's own doc for
// why). Re-exported here so existing importers of the worker entry keep resolving it.
export type { TranscribeWorkerRequest } from "./protocol.js";

/**
 * transformers.js's `progress_callback` payload. Loosely typed at the seam because it is untyped
 * upstream; {@link normalizeProgress} narrows it to our {@link PrimeProgress} wire type.
 */
interface RawProgressItem {
  readonly status: string;
  readonly file?: string;
  readonly loaded?: number;
  readonly total?: number;
  readonly progress?: number;
}

/**
 * Narrow transformers.js's per-file progress into our {@link PrimeProgress}. Returns `null` for
 * pipeline-level statuses that carry no file (`"ready"`), which the caller drops rather than relays.
 */
export function normalizeProgress(item: RawProgressItem): PrimeProgress | null {
  const file = item.file ?? "";
  switch (item.status) {
    case "initiate":
      return { stage: "initiate", file };
    case "download":
      return { stage: "download", file };
    case "progress":
      return {
        stage: "progress",
        file,
        loaded: item.loaded ?? 0,
        total: item.total ?? 0,
        progress: item.progress ?? 0,
      };
    case "done":
      return { stage: "done", file };
    default:
      return null;
  }
}

/**
 * Minimal structural view of the transformers.js ASR pipeline we drive. Loosely typed at the seam:
 * transformers.js ships its own types, but importing them here would pull the library into this
 * module's static type graph and into the node-side `worker.test.ts`. We reach for exactly three
 * members — the tokenizer, the model (for `generate` + its generation config), and the processor
 * (the feature extractor) — so we name just those.
 */
interface AsrPipeline {
  readonly tokenizer: {
    encode(text: string, options?: { add_special_tokens?: boolean }): number[];
    decode(ids: number[], options?: { skip_special_tokens?: boolean }): string;
  };
  readonly model: {
    readonly generation_config?: {
      readonly decoder_start_token_id?: number;
      readonly no_timestamps_token_id?: number | null;
    };
    generate(inputs: Record<string, unknown>): Promise<unknown>;
  };
  // Whisper's feature extractor returns `input_features` (a mel spectrogram); Moonshine's returns
  // `input_values` (the waveform, unpadded). Both are the single positional input to `generate`.
  processor(audio: Float32Array): Promise<{ input_features?: unknown; input_values?: unknown }>;
}

/**
 * The warm pipeline, memoized per config so inference reuses it (plan Task 3: "for inference you
 * want it warm"). Task 2 reconstructed per prime because priming only needed the download side
 * effect; Task 3 keeps one instance alive across `transcribe` calls. Keyed by the config that
 * defines the pipeline's identity, so a consumer that reconfigures (different model/dtype/device)
 * gets a fresh one rather than a stale hit.
 */
let pipelineCache: { readonly key: string; readonly pipeline: Promise<AsrPipeline> } | undefined;

function pipelineKey(config: PrimeConfig): string {
  return `${config.modelId}|${config.device ?? "auto"}|${config.dtype ?? "default"}|${config.revision ?? "main"}`;
}

/**
 * Get (or build) the ASR pipeline for `config`. Building it is what downloads the weights and
 * populates `transformers-cache`, streaming per-file progress to `onProgress` — so this is both
 * Task 2's prime and the warm handle Task 3's inference reuses. A warm-cache build reads from
 * `transformers-cache` rather than the network.
 */
function getPipeline(
  config: PrimeConfig,
  onProgress?: (progress: PrimeProgress) => void,
): Promise<AsrPipeline> {
  const key = pipelineKey(config);
  if (pipelineCache && pipelineCache.key === key) return pipelineCache.pipeline;

  const built = (async (): Promise<AsrPipeline> => {
    const { env, pipeline } = await import("@huggingface/transformers");

    // The load-bearing line (plan Task 2, doc 01): serve the ORT runtime from the consumer's origin
    // instead of the jsDelivr default. Assigning wasmPaths also engages ORT's own caching of the
    // runtime binary, so the ~24 MB .wasm is not re-fetched every session.
    const wasm = env.backends?.onnx?.wasm;
    if (wasm) wasm.wasmPaths = config.wasmPaths;

    return (await pipeline("automatic-speech-recognition", config.modelId, {
      ...(config.device ? { device: config.device } : {}),
      ...(config.dtype ? { dtype: config.dtype } : {}),
      ...(config.revision ? { revision: config.revision } : {}),
      progress_callback: (item: RawProgressItem) => {
        const progress = normalizeProgress(item);
        if (progress && onProgress) onProgress(progress);
      },
    })) as unknown as AsrPipeline;
  })();

  // Cache the promise (not just the resolved value) so concurrent primes share one build, and drop
  // it on failure so a transient load error does not poison every later call.
  pipelineCache = { key, pipeline: built };
  built.catch(() => {
    if (pipelineCache?.pipeline === built) pipelineCache = undefined;
  });
  return built;
}

/**
 * Minimal structural view of the voice-activity model. Same reasoning as {@link AsrPipeline}: naming
 * only what we touch keeps transformers.js out of this module's static type graph, so the node-side
 * unit tests can import it without dragging in `onnxruntime-node`.
 */
interface VadPipeline {
  readonly processor: ((audio: Float32Array) => Promise<Record<string, unknown>>) & {
    readonly feature_extractor: {
      readonly config: { readonly step: number; readonly offset: number };
    };
  };
  readonly model: (inputs: Record<string, unknown>) => Promise<{
    readonly logits: { readonly dims: readonly number[]; readonly data: Float32Array };
  }>;
}

let vadCache: { readonly key: string; readonly pipeline: Promise<VadPipeline> } | undefined;

/**
 * Get (or build) the voice-activity model. Same promise-caching shape as {@link getPipeline}, for
 * the same reasons: concurrent callers share one build, and a failed build is evicted so a transient
 * load error does not poison every later call.
 */
function getVad(
  config: PrimeConfig,
  onProgress?: (p: PrimeProgress) => void,
): Promise<VadPipeline> {
  const modelId = config.vadModelId;
  if (modelId === undefined) return Promise.reject(new Error("no VAD model configured"));
  const key = `${modelId}|${config.device ?? "auto"}|${config.revision ?? "main"}`;
  if (vadCache && vadCache.key === key) return vadCache.pipeline;

  const built = (async (): Promise<VadPipeline> => {
    const { AutoModelForAudioFrameClassification, AutoProcessor, env } =
      await import("@huggingface/transformers");
    const wasm = env.backends?.onnx?.wasm;
    if (wasm) wasm.wasmPaths = config.wasmPaths;

    const progress_callback = (item: RawProgressItem): void => {
      const progress = normalizeProgress(item);
      if (progress && onProgress) onProgress(progress);
    };
    const [processor, model] = await Promise.all([
      AutoProcessor.from_pretrained(modelId, { progress_callback }),
      AutoModelForAudioFrameClassification.from_pretrained(modelId, {
        // fp32 deliberately, matching the ASR default: q4/q8 do not load on the ORT build
        // transformers.js 4.2.0 pins (Task 2 finding). 6 MB either way.
        dtype: "fp32",
        ...(config.device ? { device: config.device } : {}),
        progress_callback,
      }),
    ]);
    return { processor, model } as unknown as VadPipeline;
  })();

  vadCache = { key, pipeline: built };
  built.catch(() => {
    if (vadCache?.pipeline === built) vadCache = undefined;
  });
  return built;
}

/** Construct the pipelines for their download side effect, relaying progress (Task 2's `prime`). */
async function prime(
  config: PrimeConfig,
  onProgress: (progress: PrimeProgress) => void,
): Promise<void> {
  await getPipeline(config, onProgress);
  // The VAD model is a quality upgrade, not a prerequisite: long audio falls back to fixed windows
  // without it. So a failure here must NOT fail the prime and strand a user whose ASR weights
  // downloaded perfectly well.
  if (config.vadModelId !== undefined) {
    try {
      await getVad(config, onProgress);
    } catch {
      /* fallback covers it */
    }
  }
}

/** pyannote-segmentation-3.0's training duration. Feeding it far longer audio is out of distribution. */
const VAD_WINDOW_SECONDS = 10;

/**
 * Per-frame `P(speech)` across the whole recording.
 *
 * The model is run over **fixed windows of its training duration**, not the whole buffer in one
 * pass. pyannote itself warns that whole-recording inference for frame models degrades quality and
 * inflates memory, and defaults to the training duration; the ONNX graph declaring a dynamic time
 * axis means it *accepts* longer input, which is not the same as being trained for it.
 *
 * Two details that are easy to get wrong and would silently corrupt every downstream threshold:
 *
 *   - **The advance is snapped to a whole number of frames.** A nominal 50% advance of 80,000
 *     samples is 296.3 frames at a 270-sample step — fractional, so "average the overlapping frames"
 *     would have no index-to-index meaning at all. Rounding to 296 frames makes every window's
 *     frames land exactly on the global grid.
 *   - **Only `pSpeech` is averaged, never the seven class probabilities.** Speaker slots permute
 *     between independently processed windows, so class-wise averaging is meaningless. `pSpeech` is
 *     immune because all six non-empty powerset states collapse to one speaker-independent event.
 *
 * This is deliberately NOT pyannote's reference aggregation, which uses a ~10% advance with Hamming
 * weighting and warm-up suppression. A 50% advance is a cost tradeoff — 5× fewer passes — and is
 * unmeasured here.
 */
async function speechTimeline(
  vad: VadPipeline,
  samples: Float32Array,
  geometry: FrameGeometry,
): Promise<Float32Array> {
  const windowSamples = VAD_WINDOW_SECONDS * geometry.sampleRate;
  const advanceFrames = Math.max(1, Math.round(windowSamples / 2 / geometry.step));
  const advanceSamples = advanceFrames * geometry.step;

  const totalFrames = Math.max(
    0,
    Math.floor((samples.length - geometry.offset) / geometry.step) + 1,
  );
  const sum = new Float64Array(totalFrames);
  const hits = new Uint32Array(totalFrames);

  for (let start = 0; start < samples.length; start += advanceSamples) {
    const view = samples.subarray(start, Math.min(start + windowSamples, samples.length));
    // Zero-pad the final short window to the full training duration, then crop its frames back
    // below — the model expects its trained input length.
    let input = view;
    if (view.length < windowSamples) {
      input = new Float32Array(windowSamples);
      input.set(view);
    }

    const { logits } = await vad.model(await vad.processor(input));
    const frames = logits.dims[1] ?? 0;
    const classes = logits.dims[2] ?? 0;
    const p = speechProbabilities(logits.data, frames, classes);

    const frameOffset = start / geometry.step;
    // Frames past the real audio are padding artefacts, not silence the model observed.
    const usable = Math.min(frames, Math.ceil((view.length - geometry.offset) / geometry.step) + 1);
    for (let i = 0; i < usable; i++) {
      const global = frameOffset + i;
      if (global < 0 || global >= totalFrames) continue;
      sum[global] = (sum[global] ?? 0) + (p[i] ?? 0);
      hits[global] = (hits[global] ?? 0) + 1;
    }
    if (start + windowSamples >= samples.length) break;
  }

  const out = new Float32Array(totalFrames);
  for (let i = 0; i < totalFrames; i++) {
    const count = hits[i] ?? 0;
    out[i] = count > 0 ? (sum[i] ?? 0) / count : 0;
  }
  return out;
}

/**
 * Below this RMS a recording with no detected speech is taken as genuinely silent.
 *
 * Without an energy check, "VAD found nothing" and "this recording is silent" are indistinguishable,
 * and they want opposite responses: running fixed windows of padded silence through a decoder primed
 * with domain jargon is a way to manufacture content out of nothing.
 */
const SILENCE_RMS = 1e-4;

/**
 * Decide how to cut `samples` into chunks Whisper can actually consume.
 *
 * Order matters, and each branch exists for a reason worth stating:
 *   1. **At or under 30 s → one chunk over the original array.** The overwhelmingly common case
 *      keeps the exact path it has always taken; no VAD is loaded and none of its risk applies.
 *   2. **VAD segments it** into non-overlapping chunks that mostly begin and end in silence.
 *   3. **Speech found but audio is silent** → no chunks, empty transcript. Correct, and safer than
 *      inventing text from padded silence.
 *   4. **VAD unavailable, failing, or finding nothing in audible audio** → the fixed-window march,
 *      which duplicates a little text but never loses any.
 */
export async function planChunks(
  config: PrimeConfig,
  samples: Float32Array,
): Promise<readonly SampleRange[]> {
  if (samples.length === 0) return [];
  if (samples.length <= WHISPER_WINDOW_SECONDS * WHISPER_SAMPLE_RATE) {
    return [{ start: 0, end: samples.length }];
  }

  if (config.vadModelId !== undefined) {
    try {
      const vad = await getVad(config);
      const extractorConfig = vad.processor.feature_extractor.config;
      const geometry: FrameGeometry = {
        step: extractorConfig.step,
        offset: extractorConfig.offset,
        sampleRate: WHISPER_SAMPLE_RATE,
      };
      const chunks = planVadChunks(
        await speechTimeline(vad, samples, geometry),
        geometry,
        samples.length,
      );
      if (chunks.length > 0) return chunks;
      // No speech. Silent recording, or a VAD failure on audible speech? Energy tells them apart.
      if (rootMeanSquare(samples) < SILENCE_RMS) return [];
    } catch {
      // Fall through to the march — a VAD that will not load must never cost the user their audio.
    }
  }

  return planFallbackChunks(samples.length, WHISPER_SAMPLE_RATE);
}

/** How many jargon prompt tokens to keep. Whisper's decoder context is 448; a prompt beyond ~half
 * of that crowds out the audio it is meant to bias, so we cap generously below that. Matches the
 * `max_new_tokens // 2 - 1` guard OpenAI's reference applies to prompt length. */
const MAX_PROMPT_TOKENS = 210;

/**
 * Turn hint text into a Whisper decoder prefix (`decoder_input_ids`).
 *
 * The prefix format for an English-only model, mirroring `_retrieve_init_tokens` with a prompt:
 *
 *   `<|startofprev|>  ‹jargon tokens›  <|startoftranscript|>  [<|notimestamps|>]`
 *
 * The `<|startofprev|>` segment is how Whisper was trained to accept prior-context/vocabulary
 * priming; the trailing sot(+notimestamps) is the normal transcription start the model would
 * otherwise build itself. Returns the id array plus its length, which the caller slices back off the
 * generated sequence so the jargon never appears in the transcript.
 */
function buildDecoderPrefix(pipeline: AsrPipeline, prompt: string): number[] {
  const gen = pipeline.model.generation_config ?? {};
  const sot = gen.decoder_start_token_id;
  if (sot == null) {
    // No decoder-start token means we cannot safely assemble a prefix; skip biasing rather than
    // guess and corrupt generation.
    return [];
  }
  const startOfPrev = pipeline.tokenizer.encode("<|startofprev|>", { add_special_tokens: false });
  const jargon = pipeline.tokenizer
    .encode(` ${prompt.trim()}`, { add_special_tokens: false })
    .slice(-MAX_PROMPT_TOKENS);
  const tail = gen.no_timestamps_token_id != null ? [sot, gen.no_timestamps_token_id] : [sot];
  return [...startOfPrev, ...jargon, ...tail];
}

/** Coerce transformers.js's generate output (a `Tensor`) to a flat array of token ids. */
function toTokenIds(output: unknown): number[] {
  const first = (output as { [index: number]: { tolist?: () => number[] } })[0];
  const list = first?.tolist?.();
  return (list ?? []).map((token) => Number(token));
}

/**
 * One inference pass over at most Whisper's 30 s receptive field.
 *
 * Bypasses the pipeline's `_call_whisper` decode/merge on purpose: it decodes the *whole* generated
 * sequence including our injected prefix, which would prepend the jargon to the transcript. Driving
 * `model.generate` directly lets us slice the known prefix off before decoding, so priming biases
 * without leaking.
 *
 * **Why the library's own long-form path is not used instead** — the previous version of this comment
 * implied the prefix was the whole reason, and that was wrong. transformers.js 4.2.0 does ship
 * `_generate_with_seek`, a timestamp-driven seek loop, and it carries an injected prefix perfectly
 * well: it passes `decoder_input_ids` into every segment and slices `init_tokens.length` off the
 * result, exactly as this function does by hand.
 *
 * The real obstacle is upstream of `generate`. `WhisperFeatureExtractor` truncates the waveform to
 * `n_samples` before producing features (`feature_extraction_whisper.js`), so a spectrogram built
 * through `processor()` is always one segment — the seek loop iterates once and audio past 30 s is
 * gone before generation starts. Measured, not reasoned: see `long-audio.manual.ts`, which drives it
 * and asserts that 54 s of audio yields exactly 3000 mel frames. Using it would mean building a
 * full-length mel spectrogram ourselves, which is more work than {@link planChunks}.
 */
async function transcribeChunk(
  pipeline: AsrPipeline,
  samples: Float32Array,
  prefix: readonly number[],
  tokenBudgetOverride?: number,
): Promise<string> {
  const features = await pipeline.processor(samples);
  // `?? null` rather than `||`: an empty tensor is still the model's input, and coercing it away here
  // would send `undefined` to `generate` and surface as an opaque ORT error.
  const waveformInput =
    features.input_features === undefined && features.input_values !== undefined;
  const inputs = features.input_features ?? features.input_values ?? null;
  if (inputs === null) {
    throw new Error(
      "ondevice: the processor returned neither `input_features` nor `input_values`. This model's " +
        "feature extractor is not one this worker knows how to drive.",
    );
  }
  const output = await pipeline.model.generate({
    inputs,
    // **Moonshine needs an explicit generation bound and Whisper must not get one.**
    //
    // Moonshine's `generation_config.json` carries no `max_length`, so an unbounded `generate` falls
    // back to the library default and truncates every chunk a few words in. The whole 54 s fixture
    // came back as four sentence fragments — a green suite and a broken transcript, because every
    // gated test drives a FakeWorker.
    //
    // 6 tokens per second of audio is the model's own heuristic, from its paper ("greedy decoding,
    // with a heuristic limit of 6 output tokens per second of audio to avoid repeated output
    // sequences") and applied identically by transformers.js's own `_call_moonshine`. We reach past
    // that pipeline to inject a decoder prefix, so we inherit its responsibilities too.
    //
    // Whisper is excluded deliberately: its config bounds generation already, and 6 tokens/s would
    // truncate IT. `input_values` is the discriminator — Whisper's extractor emits `input_features`.
    ...(waveformInput
      ? {
          max_new_tokens:
            tokenBudgetOverride ??
            Math.max(1, Math.floor(samples.length / WHISPER_SAMPLE_RATE) * 6),
        }
      : {}),
    ...(prefix.length > 0 ? { decoder_input_ids: [...prefix] } : {}),
  });

  // Slice our injected prefix off; the model's own init tokens (sot/notimestamps, when we did not
  // inject a prefix) are special and fall out under `skip_special_tokens`.
  const generated = toTokenIds(output).slice(prefix.length);
  return pipeline.tokenizer.decode(generated, { skip_special_tokens: true }).trim();
}

/**
 * Serializes every inference pass through this worker.
 *
 * The message handler does not await one request before starting the next, and the main thread
 * explicitly supports several outstanding correlated requests — so without this, two concurrent
 * `transcribe()` calls interleave `generate()` against the one shared ORT session. Long audio makes
 * that window much wider, because a single request now issues many passes rather than one.
 */
let inferenceQueue: Promise<unknown> = Promise.resolve();
export function serialize<T>(work: () => Promise<T>): Promise<T> {
  const next = inferenceQueue.then(work, work);
  // Swallow rejections on the CHAIN only — the caller still sees them through `next`. Without this a
  // single failed request would reject the shared chain and poison every request behind it.
  inferenceQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/**
 * Transcribe the decoded samples, segmenting anything past Whisper's 30 s receptive field.
 *
 * ## Two decisions worth stating, because both could reasonably have gone the other way
 *
 * **Every chunk gets the same jargon prefix.** Priming is vocabulary bias, and the vocabulary does
 * not stop applying at 00:30. Building it once also keeps the per-chunk cost to the inference itself.
 *
 * **No chunk is conditioned on the previous chunk's text** — Whisper's `condition_on_previous_text`
 * is deliberately NOT emulated. It buys coherence across a boundary, but it makes one bad chunk
 * poison every chunk after it, and OpenAI's reference only dares it because it can detect a failed
 * decode (temperature fallback, compression-ratio and log-prob thresholds) and drop the context.
 * Without that machinery the failure is unbounded and silent — precisely the class of bug this change
 * exists to remove. It would also compete with the jargon for the same {@link MAX_PROMPT_TOKENS}.
 *
 * Chunks are **non-overlapping**, so their texts are simply joined. There is no alignment step, and
 * therefore no alignment step to get wrong — the reason this design was preferred over an overlapped
 * sliding window, whose merge can silently delete speech.
 *
 * Chunks run **sequentially**: they share one ORT session, so overlapping `generate` calls would
 * contend for it rather than finish sooner.
 */
async function transcribe(config: PrimeConfig, request: TranscribeWorkerRequest): Promise<string> {
  return serialize(async () => {
    const pipeline = await getPipeline(config);
    const { samples } = request;
    const chunks = await planChunks(config, samples);
    if (chunks.length === 0) return "";

    const prefix = request.prompt ? buildDecoderPrefix(pipeline, request.prompt) : [];

    const texts: string[] = [];
    for (const { start, end } of chunks) {
      // `subarray`, not `slice`: a VIEW over the samples already in memory, so a 10-minute recording
      // (~38 MB) is not re-copied per chunk. Verified safe against the feature extractor, which
      // reads `audio.slice(0, n_samples)` / `waveform.set(audio)` — both view-relative, neither
      // reaching past the view into the backing buffer.
      const view =
        chunks.length === 1 && start === 0 && end === samples.length
          ? samples
          : samples.subarray(start, end);
      const text = await transcribeChunk(pipeline, view, prefix);
      if (text.length > 0) texts.push(text);
    }

    return texts.join(" ").trim();
  });
}

// ── Live transcription (Task 3: the live seam) ───────────────────────────────
//
// The live conversation runs alongside `prime` and `transcribe` in this same worker.
// Frames arrive at audio-callback rate (32 ms each); the worker runs Silero per frame,
// and when an utterance closes, transcribes it with the same ASR pipeline the batch path
// uses. VAD and ASR go through the `serialize` chain so they never interleave with a
// batch `transcribe` call — transformers.js does not support simultaneous inference in
// one worker, and this worker already serialises its batch passes.

/**
 * Worker-side state for one live session. Created on `liveOpen`, removed on
 * `liveClose` (or when a `liveFeed` finds it missing — the close may have arrived
 * while a feed was in flight).
 *
 * The `vad` field is a structural type matching {@link RegionVad}'s public
 * surface, not `RegionVad` itself, so a test can inject a fake VAD via
 * `injectLiveSession` without dynamic-importing transformers.js. The
 * `transcribe` field bundles the pipeline-load + inference step so the
 * per-region error boundary can catch a transcription failure without needing
 * to know whether the pipeline was warm or cold — and so a test can inject a
 * session with a fake `transcribe` without dynamic-importing transformers.js.
 *
 * `refreshInFlight` is the load-shedding flag: when `true`, a refresh
 * transcription is running and new refreshes are skipped (not queued). See
 * {@link feedLiveFrame} for why skipping a refresh is safe and skipping audio
 * is not.
 */
interface LiveWorkerSession {
  /**
   * The region VAD — turns frames into refresh/commit events over a contiguous,
   * unfiltered region buffer. A structural type, not `RegionVad` itself, so a
   * test can inject a fake VAD via `injectLiveSession` without
   * dynamic-importing transformers.js.
   */
  readonly vad: {
    feed(frame: Float32Array): Promise<RegionFrameResult>;
    drain(): Promise<Float32Array>;
    readonly samples: Float32Array;
    /** Trimmed speech-span samples for the refresh path's transcription input. Null = no speech. */
    speechSpanSamples(): Float32Array | null;
  };
  /**
   * Transcribe one region's samples. Bundles `getPipeline` + `transcribeChunk`
   * so the caller's error boundary does not care which threw — both are
   * per-region failures.
   */
  readonly transcribe: (samples: Float32Array) => Promise<string>;
  /** Whether a refresh transcription is currently in flight — load shedding. */
  refreshInFlight: boolean;
}

/** Active live sessions, keyed by `sessionId`. */
const liveSessions = new Map<string, LiveWorkerSession>();

/**
 * Session ids that received a `liveClose` before their `liveOpen` completed.
 *
 * `handleMessage` is async and does not await `openLiveSession` before processing the
 * next message, so a `liveClose` can arrive while the Silero model is still loading.
 * Without this set, the close finds nothing in `liveSessions`, returns, and the open
 * later inserts a session that can never be closed — leaking a `RegionVad`, a Silero
 * detector, and the main thread's message listener. This is not just a priming race:
 * a user who stops recording immediately hits the same path.
 *
 * `openLiveSession` checks this set after inserting the session and, if the id is
 * present, closes the session immediately so nothing leaks.
 */
const pendingCloses = new Set<string>();

/** Clear all live sessions and pending closes — test cleanup. */
export function clearLiveSessions(): void {
  liveSessions.clear();
  pendingCloses.clear();
}

/**
 * Inject a live session directly into the session map — test-only.
 *
 * `handleMessage` for `liveOpen` dynamic-imports `@huggingface/transformers` via
 * `createSileroDetector`, which pulls `onnxruntime-node` (unbuilt native addon) in node.
 * Tests that need to exercise `feedLiveFrame`'s error handling inject a session with a
 * `RegionVad` backed by a fake {@link ProbabilityDetector} and a fake `transcribe`
 * function — no model loads, no browser.
 */
export function injectLiveSession(sessionId: string, session: LiveWorkerSession): void {
  liveSessions.set(sessionId, session);
}

/**
 * If a `liveClose` arrived before this session's `liveOpen` completed, close the
 * session now and post `liveClosed`. Called by `openLiveSession` after inserting
 * the session. Exported so the pending-close race can be tested in node without
 * dynamic-importing transformers.js (which `openLiveSession` does via
 * `createSileroDetector`).
 *
 * The session was just created and has no buffered frames, so `closeLiveSession`'s
 * drain returns empty samples and takes the fast cleanup path — delete + post
 * `liveClosed`. `liveOpened` was already posted before this call, so the main thread
 * has created its `OnDeviceLiveSession` and installed the message listener that will
 * receive `liveClosed`.
 */
export function processPendingClose(
  sessionId: string,
  post: (message: WorkerToMainMessage) => void,
): void {
  if (pendingCloses.delete(sessionId)) {
    closeLiveSession(sessionId, post);
  }
}

/**
 * Create the Silero detector and the {@link RegionVad} for a new session.
 * The detector dynamic-imports `@huggingface/transformers` inside
 * {@link createSileroDetector} — the same deferred-load pattern as `getPipeline` —
 * so this import does not pull `onnxruntime-node` into the node-side unit tests
 * that import this module for routing alone.
 */
async function openLiveSession(
  sessionId: string,
  config: PrimeConfig,
  post: (message: WorkerToMainMessage) => void,
): Promise<void> {
  try {
    const detector = await createSileroDetector({
      wasmPaths: config.wasmPaths,
      ...(config.revision ? { revision: config.revision } : {}),
    });
    liveSessions.set(sessionId, {
      vad: new RegionVad(detector),
      // No jargon prefix for live — Moonshine (the default model) cannot be primed
      // (`config.ts` / `moonshine-priming.manual.ts`), and live previews are provisional
      // anyway: the batch pass after `stop()` replaces them entirely.
      transcribe: (samples) =>
        getPipeline(config).then(async (pipeline) => {
          const text = await transcribeChunk(pipeline, samples, []);
          // TEMP DIAGNOSTIC — DROP BEFORE MERGE. Three hypotheses for empty live output
          // (silence ratio, amplitude, sample rate) were falsified by measurement. This
          // discriminates the two remaining families: if the same buffer produces text with
          // a large token budget, the fault is in how we call the model; if it stays empty,
          // the fault is in the audio we hand it.
          return text;
        }),
      refreshInFlight: false,
    });
    post({ type: "liveOpened", sessionId });
    // A `liveClose` may have arrived while the Silero model was loading —
    // `handleMessage` does not await this function before processing the next
    // message. If so, close the session now so it does not leak.
    processPendingClose(sessionId, post);
  } catch (error) {
    post({ type: "liveError", sessionId, message: errorMessage(error) });
    // The session was never created, so there is nothing to close. Drop the
    // pending close so it does not outlive the session it was meant for.
    pendingCloses.delete(sessionId);
  }
}

/**
 * Feed one frame to a live session's region VAD. On a refresh, transcribe the
 * whole region and post the text as a provisional **tail**. On a commit,
 * transcribe the committed samples and post the text as **committed**.
 *
 * ## Why the VAD feed does NOT go through `serialize`
 *
 * `RegionVad` has its own internal promise chain that serializes VAD (Silero)
 * calls among themselves — two concurrent feeds would race the recurrent state
 * tensor. But the VAD feed is deliberately NOT wrapped in `serialize`, so it
 * does not chain with ASR (Moonshine) or batch `transcribe` calls. This is what
 * makes load shedding possible: while a refresh transcription is running through
 * `serialize`, the VAD can still process arriving frames, detect new refreshes,
 * and skip them — keeping the region buffer current without blocking on the
 * slow ASR call. If the VAD feed chained through `serialize`, every frame would
 * queue behind the in-flight transcription, the VAD would fall behind by the
 * ASR duration on every refresh, and `refreshInFlight` could never be `true`
 * when a new refresh fired — load shedding would be dead code.
 *
 * JavaScript's single-threaded event loop prevents true simultaneous ORT
 * inference: a VAD feed's Silero call and an ASR call's Moonshine call are both
 * synchronous WASM invocations that block the thread until they complete, so
 * they serialize at the runtime level even though their JS promise chains are
 * independent. `serialize` remains the guarantee for ASR-with-ASR and
 * ASR-with-batch, which share one ORT session and cannot interleave.
 *
 * ## Load shedding
 *
 * If a refresh comes due while a refresh transcription is already in flight,
 * **skip it** — do not queue. Dropping a refresh costs one intermediate
 * rendering of provisional text that is provisional anyway, and the region
 * buffer is untouched, so the next refresh sees everything including the audio
 * that arrived during the skip. A commit is never skipped: committed text is
 * permanent, and the committed samples are a snapshot taken at the commit
 * boundary, so delaying the transcription does not change what it transcribes.
 * Never let backpressure touch the region buffer — losing audio is the exact
 * failure revision 7 exists to eliminate.
 *
 * ## Two error boundaries, on purpose
 *
 * The outer `catch` handles **session-fatal** failures: the VAD threw. The VAD
 * processes every frame, so if it is broken every subsequent frame will throw
 * the same error and there is nothing to transcribe anyway — continuing is
 * pointless. The session is deleted (later frames no-op on the map lookup) and
 * the error is posted.
 *
 * The inner `catch` (in {@link transcribeAsTail} / {@link transcribeAsCommit})
 * handles **per-region** failures: one `transcribe` call threw. A single failed
 * region says nothing about the next one — a transient OOM or a one-off ORT
 * error does not mean the remaining 30 minutes of an audit should lose their
 * preview. The region is skipped, the error is posted, and the session stays
 * alive so later frames can still produce text.
 */
function feedLiveFrame(
  sessionId: string,
  frame: Float32Array,
  post: (message: WorkerToMainMessage) => void,
): void {
  const session = liveSessions.get(sessionId);
  if (!session) return;

  // VAD feed — through RegionVad's internal chain only, NOT through `serialize`.
  // See the comment above for why this is load-bearing for load shedding.
  session.vad
    .feed(frame)
    .then((result) => {
      if (result.commit && result.transcriptionSamples) {
        // Commit: always transcribe, never skip. The transcription samples are the
        // committed region trimmed to its speech span — a snapshot taken at the
        // commit boundary by the VAD, so the transcription sees exactly that audio
        // regardless of when it runs. When transcriptionSamples is null the
        // committed region had no speech (a cap-forced commit on noise), so there
        // is nothing to transcribe and the call is skipped.
        void transcribeAsCommit(sessionId, result.transcriptionSamples, post);
      } else if (result.refresh) {
        if (session.refreshInFlight) {
          // Load shedding: skip this refresh. The region buffer is untouched —
          // the next refresh will see everything including the audio that
          // arrived during this skip. Dropping a refresh costs one intermediate
          // rendering of provisional text; dropping audio is permanent.
          return;
        }
        // Trim the region to its speech span for the transcription input. The
        // region buffer itself is unchanged — only what we hand the model is
        // trimmed. Null means the region has no speech, which should not happen
        // here (the refresh is gated by the speech filter), but is handled
        // defensively: no speech means no transcription call.
        const samples = session.vad.speechSpanSamples();
        if (samples === null) return;
        session.refreshInFlight = true;
        void transcribeAsTail(sessionId, samples, post);
      }
    })
    .catch((error: unknown) => {
      // Session-fatal: the VAD threw. Every future frame will hit the same
      // failure, so continuing is pointless. Delete the session and surface
      // the error.
      liveSessions.delete(sessionId);
      post({ type: "liveError", sessionId, message: errorMessage(error) });
    });
}

/**
 * Transcribe a region snapshot and post the result as a provisional **tail**.
 * Goes through `serialize` so the ASR call does not interleave with a batch
 * `transcribe` or a commit transcription — transformers.js does not support
 * simultaneous inference in one worker.
 *
 * Sets `refreshInFlight = false` in the `finally` block, whether the
 * transcription succeeded or failed, so the next refresh can proceed. A failed
 * transcription is a per-region failure: the session stays alive and later
 * refreshes still produce text.
 */
function transcribeAsTail(
  sessionId: string,
  samples: Float32Array,
  post: (message: WorkerToMainMessage) => void,
): void {
  void serialize(async () => {
    const session = liveSessions.get(sessionId);
    if (!session) return;
    try {
      const text = await session.transcribe(samples);
      console.log(
        `@@LIVE@@ worker: transcribed ${(samples.length / 16000).toFixed(1)}s rms=${rootMeanSquare(samples).toFixed(5)} peak=${samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0).toFixed(4)} -> ${JSON.stringify(text)}`,
      );
      if (text.length > 0) post({ type: "liveSegment", sessionId, kind: "tail", text });
    } catch (error) {
      // Per-region: skip this refresh, surface the error, keep the session alive.
      post({ type: "liveError", sessionId, message: errorMessage(error) });
    } finally {
      const s = liveSessions.get(sessionId);
      if (s) s.refreshInFlight = false;
    }
  });
}

/**
 * Transcribe committed samples and post the result as **committed** text.
 * Goes through `serialize` for the same reason as {@link transcribeAsTail}.
 * A commit is never skipped by load shedding — committed text is permanent.
 *
 * An empty commit is posted, not silently dropped. On a commit the region buffer
 * has already advanced, so an empty ASR result means that audio's text is gone
 * from the preview with no trace — the exact silent-loss failure mode this feature
 * produced four separate times. The preview is provisional and the batch pass after
 * `stop()` recovers the text, but nothing else records that the commit happened.
 * Posting the empty segment gives the host a signal: it knows a region was
 * committed, can render a placeholder, and is not left guessing whether a segment
 * was lost or simply never produced. (The tail path keeps the `text.length > 0`
 * guard: an empty tail just means "no speech yet", and posting it would clear the
 * previous tail.)
 */
function transcribeAsCommit(
  sessionId: string,
  samples: Float32Array,
  post: (message: WorkerToMainMessage) => void,
): void {
  void serialize(async () => {
    const session = liveSessions.get(sessionId);
    if (!session) return;
    try {
      const text = await session.transcribe(samples);
      console.log(
        `@@LIVE@@ worker: transcribed ${(samples.length / 16000).toFixed(1)}s rms=${rootMeanSquare(samples).toFixed(5)} peak=${samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0).toFixed(4)} -> ${JSON.stringify(text)}`,
      );
      post({ type: "liveSegment", sessionId, kind: "commit", text });
    } catch (error) {
      // Per-region: skip this commit's text, surface the error, keep the session
      // alive. The audio is durable — the batch pass after `stop()` recovers it.
      post({ type: "liveError", sessionId, message: errorMessage(error) });
    }
  });
}

/**
 * Handle `liveClose`: drain the region buffer, transcribe whatever remains, and
 * post it as a **commit** — so the last region is never lost. Then remove the
 * session and post `liveClosed` so the main thread knows the drain is finished
 * and can tear down its subscription.
 *
 * `liveClosed` is posted in **every** exit path — empty drain, successful
 * commit, transcription error, and VAD-drain error — so the host never waits
 * for a signal that never comes. Without it the host has no way to know the
 * worker is done: the Subject stays open forever and the subscription leaks, or
 * the host guesses with a timer and either drops the flush or leaks.
 *
 * The drain goes through `RegionVad`'s internal chain, so it sees the buffer
 * state after all pending VAD feeds complete. The transcription goes through
 * `serialize`, so it chains after any in-flight refresh or commit transcription
 * — the close's commit runs after the last refresh's tail, which is the correct
 * order.
 *
 * Without this drain, speech right up to the moment the auditor pressed stop
 * was silently dropped: the VAD commits only on a long-enough pause or the
 * region cap, and continuous dictation never gives it 800 ms of silence.
 */
function closeLiveSession(sessionId: string, post: (message: WorkerToMainMessage) => void): void {
  const session = liveSessions.get(sessionId);
  if (!session) {
    // The open may still be in flight — `openLiveSession` is async (it loads the
    // Silero model), and `handleMessage` does not await it before processing the
    // next message, so a `liveClose` can arrive before the session is inserted.
    // This is not just a priming race: a user who stops recording immediately
    // hits the same path. Record the pending close so `openLiveSession` can
    // close the session once it lands. `liveClosed` is posted at that point, not
    // here — the main thread has no `OnDeviceLiveSession` listener until
    // `liveOpened` arrives, so posting `liveClosed` now would be lost.
    pendingCloses.add(sessionId);
    return;
  }

  // Drain through RegionVad's internal chain — waits for pending feeds, then
  // returns and clears the region buffer.
  session.vad
    .drain()
    .then((samples) => {
      if (samples.length === 0) {
        liveSessions.delete(sessionId);
        post({ type: "liveClosed", sessionId });
        return;
      }
      // Transcribe the drained region as a commit through `serialize` — chains
      // after any in-flight transcription, so the close's commit is the last
      // segment the host receives.
      void serialize(async () => {
        const s = liveSessions.get(sessionId);
        if (!s) return;
        try {
          const text = await s.transcribe(samples);
          console.log(
            `@@LIVE@@ worker: transcribed ${(samples.length / 16000).toFixed(1)}s rms=${rootMeanSquare(samples).toFixed(5)} peak=${samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0).toFixed(4)} -> ${JSON.stringify(text)}`,
          );
          // Always post, even when empty — see transcribeAsCommit for why an
          // empty commit is recorded rather than silently dropped.
          post({ type: "liveSegment", sessionId, kind: "commit", text });
        } catch (error) {
          // Per-region: the final region's transcription failed. The audio is
          // durable — the batch pass after `stop()` recovers it. Surface the
          // error and clean up.
          post({ type: "liveError", sessionId, message: errorMessage(error) });
        } finally {
          liveSessions.delete(sessionId);
          post({ type: "liveClosed", sessionId });
        }
      });
    })
    .catch((error: unknown) => {
      // Session-fatal (VAD drain threw). The session is closing anyway — surface
      // the error and clean up. The final region is lost, but the batch pass
      // after `stop()` recovers it.
      liveSessions.delete(sessionId);
      post({ type: "liveError", sessionId, message: errorMessage(error) });
      post({ type: "liveClosed", sessionId });
    });
}

/**
 * Handle one main→worker message. Exported (rather than only wired to `onmessage`) so the routing is
 * unit-testable without a real `WorkerGlobalScope`. `post` is the worker's `postMessage`, injected.
 */
export async function handleMessage(
  message: MainToWorkerMessage,
  post: (message: WorkerToMainMessage) => void,
): Promise<void> {
  if (message.type === "prime") {
    const { requestId, config } = message;
    try {
      await prime(config, (progress) => post({ type: "progress", requestId, progress }));
      post({ type: "primed", requestId });
    } catch (error) {
      post({ type: "error", requestId, message: errorMessage(error) });
    }
    return;
  }
  if (message.type === "transcribe") {
    const { requestId, config, request } = message;
    try {
      const text = await transcribe(config, request);
      post({ type: "transcribed", requestId, text });
    } catch (error) {
      post({ type: "error", requestId, message: errorMessage(error) });
    }
    return;
  }
  if (message.type === "liveOpen") {
    await openLiveSession(message.sessionId, message.config, post);
    return;
  }
  if (message.type === "liveFeed") {
    feedLiveFrame(message.sessionId, message.frame, post);
    return;
  }
  if (message.type === "liveClose") {
    closeLiveSession(message.sessionId, post);
    return;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Wire the handler to the worker's message loop — but only inside a real worker. Guarding on
// `WorkerGlobalScope` keeps this module importable in node (the unit tests read WORKER_ENTRY_NAME
// and normalizeProgress without a worker present), where `self` is not a worker scope.
declare const WorkerGlobalScope: { prototype: object } | undefined;
if (typeof WorkerGlobalScope !== "undefined" && self instanceof (WorkerGlobalScope as never)) {
  self.addEventListener("message", (event: MessageEvent<MainToWorkerMessage>) => {
    void handleMessage(event.data, (message) => self.postMessage(message));
  });
}
