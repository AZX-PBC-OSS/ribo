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
import { StreamingVad, createSileroDetector } from "./vad-stream.js";

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
      ? { max_new_tokens: Math.max(1, Math.floor(samples.length / WHISPER_SAMPLE_RATE) * 6) }
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
 * while a feed was queued behind `serialize`).
 */
interface LiveWorkerSession {
  /** The streaming VAD that turns frames into closed utterances. */
  readonly vad: StreamingVad;
  /** The pipeline config for ASR calls on closed utterances. */
  readonly config: PrimeConfig;
}

/** Active live sessions, keyed by `sessionId`. */
const liveSessions = new Map<string, LiveWorkerSession>();

/** Clear all live sessions — test cleanup so one test's session does not leak into the next. */
export function clearLiveSessions(): void {
  liveSessions.clear();
}

/**
 * Create the Silero detector and the {@link StreamingVad} for a new session.
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
    liveSessions.set(sessionId, { vad: new StreamingVad(detector), config });
    post({ type: "liveOpened", sessionId });
  } catch (error) {
    post({ type: "liveError", sessionId, message: errorMessage(error) });
  }
}

/**
 * Feed one frame to a live session's VAD. When the VAD emits closed utterances,
 * transcribe each with the ASR pipeline and post the text back. All of this goes
 * through `serialize` so VAD + ASR never interleave with a batch `transcribe` —
 * the single-inference-at-a-time constraint transformers.js imposes.
 *
 * If the session was closed while this feed was queued behind `serialize`, the
 * map lookup returns `undefined` and the feed is a no-op — the late reply simply
 * never happens.
 */
function feedLiveFrame(
  sessionId: string,
  frame: Float32Array,
  post: (message: WorkerToMainMessage) => void,
): void {
  void serialize(async () => {
    const session = liveSessions.get(sessionId);
    if (!session) return;
    try {
      const utterances = await session.vad.feed(frame);
      if (utterances.length === 0) return;
      const pipeline = await getPipeline(session.config);
      for (const { samples } of utterances) {
        // No jargon prefix for live — Moonshine (the default model) cannot be primed
        // (`config.ts` / `moonshine-priming.manual.ts`), and live previews are
        // provisional anyway: the batch pass after `stop()` replaces them entirely.
        const text = await transcribeChunk(pipeline, samples, []);
        if (text.length > 0) post({ type: "liveSegment", sessionId, text });
      }
    } catch (error) {
      // **Surfaced, and the session ends here.** Without this the rejection was `void`-ed into an
      // `unhandledrejection` nobody sees: a Moonshine OOM two minutes into a walkthrough stopped the
      // preview with no console output and no host signal, and every later frame threw again. The
      // auditor's only clue was that text quietly stopped appearing.
      //
      // The design's failure table asks for three things — preview stops, recording continues, error
      // surfaced. Deleting the session delivers the first (later frames no-op on the map lookup, the
      // same path `liveClose` uses), the main thread was never involved so the second holds by
      // construction, and `liveError` is the third. It already existed and was posted only by
      // `openLiveSession`; this is the other half it was designed for.
      liveSessions.delete(sessionId);
      post({ type: "liveError", sessionId, message: errorMessage(error) });
    }
  });
}

/**
 * Handle `liveClose`: flush any buffered speech, transcribe it, post the segment, then
 * remove the session. Goes through `serialize` so it runs after any pending `liveFeed`
 * calls — the flush must see the buffer state after all queued frames are processed.
 *
 * Without this flush, speech right up to the moment the auditor pressed stop was silently
 * dropped: the VAD emits only on a silence close, and continuous dictation never gives it
 * 800 ms of silence. Measured on the 54-second fixture, the live path lost the last 24
 * words. See `StreamingVad.flush` for the buffer mechanics.
 */
function closeLiveSession(sessionId: string, post: (message: WorkerToMainMessage) => void): void {
  void serialize(async () => {
    const session = liveSessions.get(sessionId);
    if (!session) return;
    try {
      const utterances = await session.vad.flush();
      if (utterances.length === 0) {
        liveSessions.delete(sessionId);
        return;
      }
      const pipeline = await getPipeline(session.config);
      for (const { samples } of utterances) {
        // No jargon prefix for live — same reasoning as `feedLiveFrame`: Moonshine (the
        // default model) cannot be primed, and live previews are provisional anyway.
        const text = await transcribeChunk(pipeline, samples, []);
        if (text.length > 0) post({ type: "liveSegment", sessionId, text });
      }
    } catch (error) {
      // Same error handling as `feedLiveFrame`: the session ends here, the error is
      // surfaced, and later frames no-op on the map lookup. The flush is the last thing
      // the session does — a failure here means the final segment is lost, but the
      // batch pass after `stop()` recovers it.
      liveSessions.delete(sessionId);
      post({ type: "liveError", sessionId, message: errorMessage(error) });
      return;
    }
    liveSessions.delete(sessionId);
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
