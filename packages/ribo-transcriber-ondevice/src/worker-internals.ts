/**
 * @file Internal machinery for the `./worker.ts` entry — not published.
 *
 * `worker.ts` is the published `./worker` subpath entry, and its public surface is only
 * `handleMessage` (plus the `TranscribeWorkerRequest` re-export). The pieces the package's own
 * tests drive directly — progress normalization, chunk planning, the inference queue, the
 * cancellation registry, the live-session map and their test seams — live here instead, imported
 * by relative path. The module-level state (`inferenceQueue`, `cancelledTranscribes`,
 * `liveSessions`, `pendingCloses`) is shared with `handleMessage` through these exports.
 */

import { WHISPER_SAMPLE_RATE } from "./decode.js";
import type { PrimeConfig, PrimeProgress, WorkerToMainMessage } from "./protocol.js";
import {
  planFallbackChunks,
  planVadChunks,
  rootMeanSquare,
  speechProbabilities,
  WHISPER_WINDOW_SECONDS,
} from "./segmentation.js";
import type { FrameGeometry, SampleRange } from "./segmentation.js";
import type { RegionFrameResult } from "./vad-stream.js";

/** The subpath this module is published under — the stable name of the worker entry. */
export const WORKER_ENTRY_NAME = "@azx/ribo-transcriber-ondevice/worker" as const;

/**
 * transformers.js's `progress_callback` payload. Loosely typed at the seam because it is untyped
 * upstream; {@link normalizeProgress} narrows it to our {@link PrimeProgress} wire type.
 */
export interface RawProgressItem {
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
 * Minimal structural view of the voice-activity model. Same reasoning as `AsrPipeline`: naming
 * only what we touch keeps transformers.js out of this module's static type graph, so the node-side
 * unit tests can import it without dragging in `onnxruntime-node`.
 */
export interface VadPipeline {
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
 * Get (or build) the voice-activity model. Same promise-caching shape as `getPipeline`, for
 * the same reasons: concurrent callers share one build, and a failed build is evicted so a transient
 * load error does not poison every later call.
 *
 * `allowDownload` carries the same meaning and the same default as `getPipeline`'s — see its
 * doc comment for why a warm build must gate `env.allowRemoteModels` closed rather than inherit
 * whatever a prior build left it as.
 */
export function getVad(
  config: PrimeConfig,
  onProgress?: (p: PrimeProgress) => void,
  allowDownload = false,
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
    env.allowRemoteModels = allowDownload;

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
 * Cancellation registry for batch transcriptions, keyed by `requestId`.
 *
 * The channel for `TranscribeOptions.signal` on this transport: the main thread
 * posts `cancelTranscribe` when its signal fires, the batch loop observes the
 * flag at its start and between chunks, and the entry is deleted when the
 * request settles — so a cancel for an unknown or already-settled id is a
 * no-op, never a leak. This is deliberately **not** `worker.terminate()`:
 * the worker is shared with the live conversation, and a terminate on a batch
 * abort would kill a user's in-flight dictation preview as well as the primed
 * model that `prime()` exists to avoid paying for twice.
 */
export const cancelledTranscribes = new Map<string, { aborted: boolean }>();

/** Test-only: drop every cancellation entry, so tests start from a clean registry. */
export function clearCancelledTranscribes(): void {
  cancelledTranscribes.clear();
}

/**
 * Worker-side state for one live session. Created on `liveOpen`, removed on
 * `liveClose` (or when a `liveFeed` finds it missing — the close may have arrived
 * while a feed was in flight).
 *
 * The `vad` field is a structural type matching `RegionVad`'s public
 * surface, not `RegionVad` itself, so a test can inject a fake VAD via
 * `injectLiveSession` without dynamic-importing transformers.js. The
 * `transcribe` field bundles the pipeline-load + inference step so the
 * per-region error boundary can catch a transcription failure without needing
 * to know whether the pipeline was warm or cold — and so a test can inject a
 * session with a fake `transcribe` without dynamic-importing transformers.js.
 *
 * `refreshInFlight` is the load-shedding flag: when `true`, a refresh
 * transcription is running and new refreshes are skipped (not queued). See
 * `feedLiveFrame` for why skipping a refresh is safe and skipping audio
 * is not.
 */
export interface LiveWorkerSession {
  /**
   * The region VAD — turns frames into refresh/commit events over a contiguous,
   * unfiltered region buffer. A structural type, not `RegionVad` itself, so a
   * test can inject a fake VAD via `injectLiveSession` without
   * dynamic-importing transformers.js.
   */
  readonly vad: {
    feed: (frame: Float32Array) => Promise<RegionFrameResult>;
    drain: () => Promise<Float32Array>;
    readonly samples: Float32Array;
    /** Trimmed speech-span samples for the refresh path's transcription input. Null = no speech. */
    speechSpanSamples: () => Float32Array | null;
  };
  /**
   * Transcribe one region's samples. Bundles `getPipeline` + `transcribeChunk`
   * so the caller's error boundary does not care which threw — both are
   * per-region failures.
   */
  readonly transcribe: (samples: Float32Array) => Promise<string>;
  /** Whether a refresh transcription is currently in flight — load shedding. */
  refreshInFlight: boolean;
  /**
   * True when a commit transcription is queued or in-flight. New commits that
   * arrive while this is `true` are **coalesced** into {@link pendingCommitSamples}
   * rather than enqueuing a separate `serialize` call — see `feedLiveFrame`'s
   * commit branch for why this bounds the queue without losing audio.
   */
  commitInFlight?: boolean;
  /**
   * Samples from commits that arrived while {@link commitInFlight} was `true`.
   * The in-flight (or queued) commit transcription drains this buffer before it
   * starts and after it finishes, so coalesced commits are transcribed together
   * with the audio that preceded them. Consecutive regions are contiguous audio,
   * so concatenating and transcribing once is equivalent to transcribing each
   * separately — no text is lost. `null`/`undefined` = no pending commit.
   */
  pendingCommitSamples?: Float32Array | null;
}

/** Active live sessions, keyed by `sessionId`. */
export const liveSessions = new Map<string, LiveWorkerSession>();

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
export const pendingCloses = new Set<string>();

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
 * `RegionVad` backed by a fake `ProbabilityDetector` and a fake `transcribe`
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
export function closeLiveSession(
  sessionId: string,
  post: (message: WorkerToMainMessage) => void,
): void {
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

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
