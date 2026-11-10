/**
 * @module @azx/ribo-transcriber-ondevice/worker
 *
 * @file Worker entry for the `@azx/ribo-transcriber-ondevice/worker` subpath.
 *
 * The inference half of the package: it runs Whisper via `@huggingface/transformers` inside a Web
 * Worker. Per AGENTS.md §5.2 the worker ships as a **published entry**, constructed by a
 * consumer-supplied `createWorker` factory — library code never calls `new Worker(...)` via a
 * `?worker` import (vitejs/vite#15618). The `@azx/source` branch on this subpath points here at
 * source, so the playground can exercise the worker in-workspace without building `dist/` first.
 *
 * ## Messages handled
 *
 * `prime` (constructs the ASR pipeline — download + cache), `transcribe` (batch
 * inference on a `Float32Array`, {@link TranscribeWorkerRequest}), and the live
 * conversation: `liveOpen`, `liveFeed`, `liveClose`. The live seam runs Silero VAD
 * per frame and transcribes closed utterances with the same ASR pipeline.
 *
 * ## Why `@huggingface/transformers` is imported dynamically
 *
 * The import lives **inside** the message handler, not at module top level, for two reasons:
 * transformers.js's Node entry pulls `onnxruntime-node` (a 210 MB native addon whose build script
 * we do not run), so a static import would make the node-side `worker.test.ts` — which only reads
 * `WORKER_ENTRY_NAME` — try to load it; and the whole point is to defer the heavy runtime
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
import { planFallbackChunks } from "./segmentation.js";
import { RegionVad, createSileroDetector } from "./vad-stream.js";
import {
  cancelledTranscribes,
  closeLiveSession,
  errorMessage,
  getVad,
  liveSessions,
  normalizeProgress,
  pendingCloses,
  planChunks,
  processPendingClose,
  serialize,
} from "./worker-internals.js";
import type { RawProgressItem } from "./worker-internals.js";

// The transcribe request/prompt contract now lives in `protocol.ts` (it is a wire type, and Task 3
// changed its shape from `promptIds: number[]` to `prompt: string` — see the type's own doc for
// why). Re-exported here so existing importers of the worker entry keep resolving it.
export type { TranscribeWorkerRequest } from "./protocol.js";

/**
 * Minimal structural view of the transformers.js ASR pipeline we drive. Loosely typed at the seam:
 * transformers.js ships its own types, but importing them here would pull the library into this
 * module's static type graph and into the node-side `worker.test.ts`. We reach for exactly three
 * members — the tokenizer, the model (for `generate` + its generation config), and the processor
 * (the feature extractor) — so we name just those.
 */
interface AsrPipeline {
  readonly tokenizer: {
    encode: (text: string, options?: { add_special_tokens?: boolean }) => number[];
    decode: (ids: number[], options?: { skip_special_tokens?: boolean }) => string;
  };
  readonly model: {
    readonly generation_config?: {
      readonly decoder_start_token_id?: number;
      readonly no_timestamps_token_id?: number | null;
    };
    generate: (inputs: Record<string, unknown>) => Promise<unknown>;
  };
  // Whisper's feature extractor returns `input_features` (a mel spectrogram); Moonshine's returns
  // `input_values` (the waveform, unpadded). Both are the single positional input to `generate`.
  processor: (audio: Float32Array) => Promise<{ input_features?: unknown; input_values?: unknown }>;
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
 *
 * `allowDownload` gates `env.allowRemoteModels` around the build, and defaults to `false` — the
 * safe direction, since every caller except {@link prime} expects the model already cached and
 * must never touch the network. Without this, a cache-hit build can still reach `huggingface.co`:
 * transformers.js's `_get_file_metadata` fetches a file's size for progress reporting whenever the
 * cached `Response` lacks a `content-length` header, with no timeout on that fetch. On a network
 * that black-holes the request instead of failing it outright (rather than one that's simply
 * absent), that single metadata call hangs forever, and with it the whole pipeline build — even
 * though every byte it needs is already local. `env.allowRemoteModels = false` turns that into an
 * immediate, loud `local_files_only` error instead of a silent, permanent hang, which is the
 * correct failure mode for a path that (per this file's header) must never download outside an
 * explicit, human-initiated {@link prime} call.
 *
 * `env` is a mutable global transformers.js singleton, shared by every call site in this worker —
 * so this flag is set immediately before the build it governs, on every call, rather than relying
 * on the library's default. Leaving prime's build to fall back on that default would leave it
 * silently `false` (and priming unable to download anything) the first time it runs after any warm
 * build has set it, since both share the same `env` object for the life of the worker.
 */
function getPipeline(
  config: PrimeConfig,
  onProgress?: (progress: PrimeProgress) => void,
  allowDownload = false,
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
    env.allowRemoteModels = allowDownload;

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

/** Construct the pipelines for their download side effect, relaying progress (Task 2's `prime`). */
async function prime(
  config: PrimeConfig,
  onProgress: (progress: PrimeProgress) => void,
): Promise<void> {
  await getPipeline(config, onProgress, true);
  // The VAD model is a quality upgrade, not a prerequisite: long audio falls back to fixed windows
  // without it. So a failure here must NOT fail the prime and strand a user whose ASR weights
  // downloaded perfectly well.
  if (config.vadModelId !== undefined) {
    try {
      await getVad(config, onProgress, true);
    } catch {
      /* fallback covers it */
    }
  }
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
 * full-length mel spectrogram ourselves, which is more work than `planChunks`.
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

/** The error thrown when the batch loop observes a cancellation. */
function cancelledError(): Error {
  return new Error(
    "on-device transcription was aborted by the caller's signal — stopping at the next chunk boundary",
  );
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
/**
 * Run the batch inference. `requestId` correlates the caller's cancellation:
 * the loop checks the registry before starting work and between chunks, so a
 * cancelled request either never runs inference at all (still queued behind
 * `serialize` when the cancel arrived) or stops at the next chunk boundary —
 * at most one ≤30 s pass late, never a full-length zombie keeping the shared
 * worker (and every live session and queued batch behind it) busy.
 */
async function transcribe(
  config: PrimeConfig,
  request: TranscribeWorkerRequest,
  isCancelled: () => boolean,
): Promise<string> {
  return serialize(async () => {
    if (isCancelled()) throw cancelledError();
    const pipeline = await getPipeline(config);
    const { samples } = request;
    const chunks = await planChunks(config, samples);
    if (chunks.length === 0) return "";
    if (isCancelled()) throw cancelledError();

    const prefix = request.prompt ? buildDecoderPrefix(pipeline, request.prompt) : [];

    const texts: string[] = [];
    for (const { start, end } of chunks) {
      if (isCancelled()) throw cancelledError();
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
// uses. ASR (refresh, commit, and close transcriptions) goes through the `serialize`
// chain so it never interleaves with a batch `transcribe` call — transformers.js does
// not support simultaneous inference in one worker, and this worker already serialises
// its batch passes. The VAD feed deliberately does NOT go through `serialize` — see
// the comment on `feedLiveFrame` for why that is load-bearing for load shedding.

/** Concatenate two `Float32Array`s into a new buffer. Used to coalesce queued commit samples. */
function concatSamples(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Transcribe `samples` through `transcribe`, splitting into model-window-sized chunks first so no
 * single call receives more than the model's receptive field.
 *
 * Reuses the batch path's `planFallbackChunks` — the same fixed-window march `transcribe` uses when
 * VAD is unavailable. The live path's `session.transcribe` calls `transcribeChunk` directly (one
 * inference pass over at most 30 s), which is correct for a single region but not for a **coalesced**
 * commit buffer: `pendingCommitSamples` grows by unbounded concatenation, so on a slow device with
 * sustained dictation three backed-up 30 s regions become a single 90 s call that exceeds the model's
 * input window. Moonshine's reference caps at 30 s (`MAX_BUFFER_DURATION = 30`); behaviour beyond
 * that is untested, and this model is already known to return empty text under conditions not fully
 * understood.
 *
 * **The cap** is `WHISPER_WINDOW_SECONDS` (30 s) × `WHISPER_SAMPLE_RATE` (16 000) = 480 000 samples,
 * matching `planFallbackChunks`'s window. When the coalesced buffer reaches the cap,
 * `planFallbackChunks` splits it into overlapping windows (10 s overlap) and each is transcribed
 * separately; the texts are joined with a space.
 *
 * **What the user sees:** all the text, as a single commit segment, with some duplicated words at
 * chunk boundaries from the 10 s overlap. The duplication is the safe direction — a repeated phrase
 * is harmless, a deleted one is not — and the live preview is provisional: the batch pass after
 * `stop()` produces the final transcript without duplication. No audio's text is dropped.
 *
 * Not applied to the tail or close paths: those transcribe a single region bounded by
 * `VAD_REGION_CAP_SECONDS` (30 s), so they never exceed the window.
 */
async function transcribeBounded(
  transcribe: (samples: Float32Array) => Promise<string>,
  samples: Float32Array,
): Promise<string> {
  const chunks = planFallbackChunks(samples.length, WHISPER_SAMPLE_RATE);
  const texts: string[] = [];
  for (const { start, end } of chunks) {
    const text = await transcribe(samples.subarray(start, end));
    if (text.length > 0) texts.push(text);
  }
  return texts.join(" ").trim();
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
      commitInFlight: false,
      pendingCommitSamples: null,
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
 * What is guaranteed: `serialize` chains ASR-with-ASR and ASR-with-batch calls,
 * which share one ORT session and must not interleave. `RegionVad`'s internal
 * promise chain serializes VAD-with-VAD calls, protecting the recurrent state
 * tensor.
 *
 * What is assumed, not guaranteed: VAD (Silero) and ASR (Moonshine) do not
 * overlap. Their JS promise chains are independent, and the argument for safety
 * rests on ORT WASM inference being synchronous and blocking — which is true for
 * the WASM backend today. But this is a property of the backend, not of the
 * runtime: `onnxruntime-web` can run asynchronously under WebGPU or threaded
 * WASM, and `createSileroDetector` does not receive a `device` parameter, so it
 * may select a different backend than the ASR pipeline (which can be configured
 * for WebGPU). If both backends dispatch asynchronously, a VAD feed and an ASR
 * call could be in flight simultaneously. This is a known risk, not a current
 * bug: both pipelines use the WASM backend today, where inference blocks.
 * Restructuring the concurrency model to make this guarantee explicit is
 * deferred until a non-WASM backend is actually in use.
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
        //
        // ## Bounding the commit queue (the fix for unbounded backlog)
        //
        // `serialize` is a single unbounded promise chain. Without coalescing,
        // every commit enqueues a separate closure that captures its region's
        // `Float32Array` and waits behind every earlier commit. On a slow device
        // (5–10 s per region) with continuous dictation (a commit every 15–30 s),
        // the backlog compounds and the newest commit waits for the sum of all
        // earlier durations — a ~10 s preview lag observed in the field.
        //
        // **The bound:** at most ONE commit transcription is in-flight or queued
        // at a time. When a commit arrives while `commitInFlight` is already
        // `true`, its samples are merged into `pendingCommitSamples` instead of
        // enqueuing a new `serialize` call. The in-flight transcription drains
        // `pendingCommitSamples` before it starts (merging anything that arrived
        // while it was queued) and re-queues itself after it finishes if more
        // commits arrived while it was running.
        //
        // **What the user loses:** individual commit boundaries. Two regions that
        // would have been separate commit segments become one larger segment whose
        // text is the transcription of their concatenated audio. The text is all
        // there — consecutive regions are contiguous audio, so transcribing them
        // together is equivalent to transcribing each separately and joining. The
        // user would know this is happening because commit segments arrive less
        // frequently and contain more text per segment during sustained dictation
        // on a slow device.
        //
        // **Why this beats the alternatives:**
        //   - **Shedding commits like refreshes** would silently lose real text —
        //     this feature has produced that exact bug four separate times.
        //   - **Back-pressuring the producer** would block the VAD feed, which
        //     could lose audio — the exact failure this revision exists to
        //     eliminate.
        //   - **A cap that surfaces `liveError` when exceeded** would make the loss
        //     visible, but the text is still lost. Coalescing loses nothing.
        if (session.commitInFlight) {
          session.pendingCommitSamples = session.pendingCommitSamples
            ? concatSamples(session.pendingCommitSamples, result.transcriptionSamples)
            : result.transcriptionSamples;
        } else {
          session.commitInFlight = true;
          void transcribeAsCommit(sessionId, result.transcriptionSamples, post);
        }
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
 * ## Coalescing drain (the bounded-queue mechanism)
 *
 * Before transcribing, this function drains `pendingCommitSamples` — commits
 * that arrived while this call was queued behind `serialize`. Their samples are
 * concatenated onto the initial samples (they are contiguous audio, so the
 * order is initial → pending) and transcribed in one pass.
 *
 * After transcribing, if more commits arrived during the `await`, the function
 * re-queues itself through `serialize` with those samples. This keeps each
 * commit transcription as a separate `serialize` entry (refreshes and batch
 * transcribes can interleave between them) while never letting the queue grow
 * beyond one pending entry. `commitInFlight` stays `true` across the re-queue
 * so new commits continue to coalesce rather than starting parallel calls.
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
  initialSamples: Float32Array,
  post: (message: WorkerToMainMessage) => void,
): void {
  void serialize(async () => {
    const session = liveSessions.get(sessionId);
    if (!session) return;
    // Drain commits that coalesced while we were queued behind serialize.
    // Order: initialSamples (the triggering commit) precedes pending (later commits).
    let samples = initialSamples;
    if (session.pendingCommitSamples) {
      samples = concatSamples(samples, session.pendingCommitSamples);
      session.pendingCommitSamples = null;
    }
    try {
      const text = await transcribeBounded(session.transcribe, samples);
      post({ type: "liveSegment", sessionId, kind: "commit", text });
    } catch (error) {
      // Per-region: skip this commit's text, surface the error, keep the session
      // alive. The audio is durable — the batch pass after `stop()` recovers it.
      post({ type: "liveError", sessionId, message: errorMessage(error) });
    }
    // If more commits arrived while we were transcribing, re-queue. This keeps
    // the queue bounded at one pending entry while ensuring no commit is lost.
    // commitInFlight stays true so new commits continue to coalesce into
    // pendingCommitSamples rather than starting a parallel transcribeAsCommit.
    const next = liveSessions.get(sessionId);
    if (!next) return;
    if (next.pendingCommitSamples) {
      const more = next.pendingCommitSamples;
      next.pendingCommitSamples = null;
      void transcribeAsCommit(sessionId, more, post);
    } else {
      next.commitInFlight = false;
    }
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
    // Register before the serialize queue can even look at the request, so a
    // cancel that arrives while the request is still queued (behind a live
    // session's transcription, say) is honoured the moment its turn comes —
    // the entry is what a queued-but-unstarted request checks first.
    cancelledTranscribes.set(requestId, { aborted: false });
    try {
      const text = await transcribe(
        config,
        request,
        () => cancelledTranscribes.get(requestId)?.aborted === true,
      );
      post({ type: "transcribed", requestId, text });
    } catch (error) {
      post({ type: "error", requestId, message: errorMessage(error) });
    } finally {
      // Settled — a late `cancelTranscribe` for this id must be a no-op, not
      // a registry leak.
      cancelledTranscribes.delete(requestId);
    }
    return;
  }
  if (message.type === "cancelTranscribe") {
    // Only mark entries that are actually outstanding: an unknown id is a
    // request that already settled (or never existed here), and marking it
    // would leak the entry.
    const entry = cancelledTranscribes.get(message.requestId);
    if (entry) entry.aborted = true;
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

// Wire the handler to the worker's message loop — but only inside a real worker. Guarding on
// `WorkerGlobalScope` keeps this module importable in node (the unit tests read WORKER_ENTRY_NAME
// and normalizeProgress without a worker present), where `self` is not a worker scope.
declare const WorkerGlobalScope: { prototype: object } | undefined;
if (typeof WorkerGlobalScope !== "undefined" && self instanceof (WorkerGlobalScope as never)) {
  self.addEventListener("message", (event: MessageEvent<MainToWorkerMessage>) => {
    void handleMessage(event.data, (message) => self.postMessage(message));
  });
}
