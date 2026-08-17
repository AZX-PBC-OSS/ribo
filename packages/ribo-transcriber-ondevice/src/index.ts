/**
 * @file The public surface of `@azx/ribo-transcriber-ondevice`.
 *
 * On-device Whisper, implementing `@azx/ribo-core`'s {@link Transcriber} so it is substitutable for
 * `FakeTranscriber` and composes through `firstCapable` with no queue changes. This is a **separate
 * package** from `ribo-core` because `@huggingface/transformers` pulls `onnxruntime-node` and
 * `sharp` (with postinstall scripts) as hard dependencies — costs every `ribo-core` consumer must
 * not inherit.
 *
 * {@link OnDeviceTranscriber.prime} downloads and caches the model with visible progress;
 * {@link OnDeviceTranscriber.capability} tells `needs-download` from `ready` by reading the Cache
 * API; and {@link OnDeviceTranscriber.transcribe} runs real Whisper inference — decoding the queue's
 * `Blob` to 16 kHz mono PCM on the main thread (doc 11), transferring it to the worker, biasing the
 * decoder with the configured domain-jargon hints, and returning a stamped {@link Transcript}.
 */
import type { Recording, Transcript, Transcriber, TranscriberCapability } from "@azx/ribo-core";

import { measureRtf } from "./calibration.js";
import { ondeviceEngineId } from "./engine-id.js";
import {
  buildHintPrompt,
  DEFAULT_MODEL_ID,
  modelSupportsHints,
  DEFAULT_WORKER_TIMEOUT_MS,
  defaultCreateWorker,
  estimateDownloadBytes,
  VAD_MODEL_ID,
  type OnDeviceTranscriberOptions,
  type TranscribeHints,
} from "./config.js";
import { decodeTo16kMono } from "./decode.js";
import { isModelCached } from "./model-cache.js";
import { DEFAULT_RTF_THRESHOLD, readRtfVerdict } from "./rtf-verdict.js";
import type {
  MainToWorkerMessage,
  OnnxDtype,
  PrimeConfig,
  PrimeProgress,
  TranscribeWorkerRequest,
  WorkerToMainMessage,
} from "./protocol.js";

/** Messages that carry a `requestId` — the batch path's correlation key. */
type RequestMessage = Extract<MainToWorkerMessage, { requestId: string }>;

export {
  buildHintPrompt,
  DEFAULT_MODEL_ID,
  DEFAULT_WORKER_TIMEOUT_MS,
  MODEL_DOWNLOAD_BYTES,
  modelSupportsHints,
  VAD_MODEL_ID,
  VAD_DOWNLOAD_BYTES,
  estimateDownloadBytes,
  STREAMING_VAD_MODEL_ID,
  STREAMING_VAD_DOWNLOAD_BYTES,
} from "./config.js";
export type { OnDeviceTranscriberOptions, TranscribeHints } from "./config.js";
export { decodeTo16kMono } from "./decode.js";
export { ONDEVICE_ENGINE_PREFIX, ondeviceEngineId, shortModelName } from "./engine-id.js";
export type { EngineIdentity } from "./engine-id.js";
export { TRANSFORMERS_CACHE_NAME, isModelCached } from "./model-cache.js";
export {
  DEFAULT_RTF_THRESHOLD,
  RTF_VERDICT_CACHE_NAME,
  readRtfVerdict,
  writeRtfVerdict,
} from "./rtf-verdict.js";
export type { PrimeConfig, PrimeProgress, TranscribeWorkerRequest } from "./protocol.js";

// Live transcription: the streaming seam implementation.
export { DEFAULT_LIVE_OPEN_TIMEOUT_MS, OnDeviceLiveTranscriber } from "./live.js";
export type { OnDeviceLiveTranscriberOptions } from "./live.js";

/**
 * **Superseded.** The `Transcriber.engine` value is now derived per configuration by
 * {@link ondeviceEngineId} — see `engine-id.ts` for why a shared constant was wrong in three
 * ways, the sharpest being that it made a two-configuration roster throw at construction.
 *
 * Kept only as the historical value: transcripts written before 2026-08-17 carry this string,
 * and it names Whisper on a package whose default model has been Moonshine since the
 * live-transcription work — which is exactly the provenance defect the derived id fixes.
 *
 * @deprecated Read `transcriber.engine`, or build one with {@link ondeviceEngineId}.
 */
export const ONDEVICE_WHISPER_ENGINE = "ondevice-whisper";

/** Callback invoked for each download-progress datum while {@link OnDeviceTranscriber.prime} runs. */
export type PrimeProgressListener = (progress: PrimeProgress) => void;

/**
 * Whisper on the device, via `@huggingface/transformers` running in a Web Worker.
 *
 * ## Priming is explicit and user-initiated (plan Task 2)
 *
 * There is **no** background or automatic download. {@link prime} is called only when the user asks
 * — a ~314 MB fp32 fetch (measured, Task 4) over what may be cellular data is a decision the product
 * makes deliberately, not a surprise. Progress is relayed from the worker (where the pipeline lives)
 * to the callback so the
 * UI can show a real bar.
 *
 * ## The audio seam (doc 11 §4)
 *
 * The public contract stays **`Blob` in** — `transcribe(recording, audio: Blob)` — because the queue
 * stores audio as an RxDB `Blob` attachment and every other `Transcriber` speaks that language. The
 * `Float32Array` Whisper consumes is an internal detail: Task 3's `transcribe` decodes on the main
 * thread and transfers the samples to the worker.
 */
export class OnDeviceTranscriber implements Transcriber {
  /**
   * Derived from (model, device, dtype) rather than a module constant — see `engine-id.ts` for
   * the three defects that shared constant caused. Assigned in the constructor because it
   * depends on the options.
   */
  readonly engine: string;

  readonly #modelId: string;
  readonly #wasmPaths: string;
  readonly #device?: "webgpu" | "wasm";
  readonly #dtype?: OnnxDtype;
  readonly #revision?: string;
  readonly #hints?: TranscribeHints;
  readonly #downloadBytes: number;
  readonly #cacheStorage?: CacheStorage;
  readonly #rtfThreshold: number;
  readonly #createWorker: () => Worker;
  readonly #timeoutMs: number;
  readonly #now: () => number;

  /** Constructed lazily on the first {@link prime}, then reused. */
  #worker?: Worker;

  /** Memoized WebGPU adapter probe — see {@link #executionProviderAvailable}. */
  #webgpuAvailable?: Promise<boolean>;

  constructor(options: OnDeviceTranscriberOptions) {
    this.#modelId = options.modelId ?? DEFAULT_MODEL_ID;
    this.#wasmPaths = options.wasmPaths;
    this.#device = options.device;
    this.#dtype = options.dtype;
    this.#revision = options.revision;
    // Refuse at construction, not at transcribe time. Applying a prefix to a model without a
    // trained prior-context token does not degrade the transcript, it REPLACES it — Moonshine echoes
    // the jargon and stops (`moonshine-priming.manual.ts`). Ignoring the hints silently would be no
    // better: a caller who asked for domain biasing and got none should hear about it, not discover
    // it in a review queue full of misheard ACH50 readings.
    if (options.hints && !modelSupportsHints(this.#modelId)) {
      throw new Error(
        `ondevice: hints were supplied but "${this.#modelId}" cannot be primed. Domain-jargon ` +
          `priming works by injecting a decoder prefix, which needs a trained prior-context token ` +
          `(Whisper's <|startofprev|>); models without one transcribe the prefix instead of the ` +
          `audio. Either use a whisper-* model, or drop \`hints\`.`,
      );
    }
    this.#hints = options.hints;
    this.#downloadBytes = options.downloadBytes ?? estimateDownloadBytes(this.#modelId);
    // `?? undefined` so an explicit override still wins but the default is read lazily at probe time.
    this.#cacheStorage = options.cacheStorage;
    this.#rtfThreshold = options.rtfThreshold ?? DEFAULT_RTF_THRESHOLD;
    this.#createWorker = options.createWorker ?? defaultCreateWorker;
    this.#timeoutMs = options.workerTimeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS;
    this.#now = options.now ?? (() => performance.now());
    this.engine = ondeviceEngineId({
      modelId: this.#modelId,
      device: this.#device,
      dtype: this.#dtype,
    });
  }

  /**
   * Is the configured execution provider actually present?
   *
   * `capability()` used to answer purely from the Cache API, which meant an instance configured
   * `device: "webgpu"` on a machine with no adapter reported `ready` and then failed inside the
   * worker — as an *ordinary* error, which `firstCapable` rule 5 propagates rather than falling
   * through. That produced a hard failure at exactly the point a fallback was wanted.
   *
   * Memoized, because `capability()` is contractually cheap and called on every queue drain
   * while `requestAdapter()` is neither. Caching is safe in both directions: a GPU does not
   * appear or vanish mid-session, which is the same reasoning that puts `unsupported-platform`
   * in the permanent set.
   */
  async #executionProviderAvailable(): Promise<boolean> {
    if (this.#device !== "webgpu") return true;
    this.#webgpuAvailable ??= (async () => {
      const gpu = (navigator as { gpu?: { requestAdapter: () => Promise<unknown> } }).gpu;
      if (!gpu) return false;
      try {
        return (await gpu.requestAdapter()) !== null;
      } catch {
        // A throwing adapter request is an absent adapter for our purposes.
        return false;
      }
    })();
    return this.#webgpuAvailable;
  }

  /**
   * What this engine can do right now, judged from the Cache API and a persisted RTF
   * verdict (no download, no inference — cheap enough to call often per the `Transcriber`
   * contract).
   *
   * - No `CacheStorage` at all → `unavailable`/`unsupported-platform`: without it the model
   *   cannot be persisted for offline use, which is the entire premise. Permanent, so
   *   `firstCapable` stops re-probing it.
   * - A stored RTF above threshold → `unavailable`/`too-slow`, carrying the measured value
   *   in `detail`. This **outranks the cache check**: a device known to be too slow must
   *   report unavailable even with the weights cached, because the weights being present is
   *   exactly the situation the old code mistook for readiness. Permanent, so `firstCapable`
   *   stops re-probing a fact about the hardware.
   * - Model weights already in `transformers-cache` → `ready`.
   * - Otherwise → `needs-download`, carrying the byte estimate (weights **plus** the ORT
   *   runtime) for the consent screen. `firstCapable` deliberately never auto-selects this —
   *   the fetch needs a human's say-so, which {@link prime} is where it happens.
   *
   * When there is no stored RTF verdict — a device that primed but never calibrated, or
   * never primed at all — the verdict check is skipped and today's behaviour is preserved.
   */
  async capability(): Promise<TranscriberCapability> {
    const cacheStorage = this.#cacheStorage ?? globalThis.caches;
    if (!cacheStorage) {
      return {
        status: "unavailable",
        reason: "unsupported-platform",
        detail: "Cache API unavailable — the model cannot be cached for offline use here.",
      };
    }
    // The configured execution provider has to exist before anything else is worth asking.
    // Permanent: a GPU adapter does not appear mid-session.
    if (!(await this.#executionProviderAvailable())) {
      return {
        status: "unavailable",
        reason: "unsupported-platform",
        detail: "WebGPU was requested but no GPU adapter is available on this device.",
      };
    }
    // A stored too-slow verdict outranks the cache check: a device known to be too slow
    // must report unavailable even with the weights cached. `readRtfVerdict` returns
    // `undefined` when no verdict is stored, which falls through to the cache check —
    // preserving today's behaviour for devices that never calibrated.
    //
    // Keyed by ENGINE id, not model id: a verdict measured on one operating point must not
    // demote another. fp32 and q8 of the same model are different speeds, and `too-slow` is
    // permanent, so inheriting it across them would be unrecoverable.
    const rtf = await readRtfVerdict(this.engine, cacheStorage);
    if (rtf !== undefined && rtf > this.#rtfThreshold) {
      return {
        status: "unavailable",
        reason: "too-slow",
        detail: `measured real-time factor ${rtf} exceeds threshold ${this.#rtfThreshold}`,
      };
    }
    // `ready` is judged on the ASR weights ALONE. The voice-activity model is a quality upgrade for
    // recordings past 30 s, and its absence is covered by the fixed-window fallback — so reporting
    // `needs-download` without it would be actively harmful: `firstCapable` selects only `ready`
    // transcribers and skips `needs-download`, so a user who primed before VAD shipped would
    // silently switch to a managed transcriber, or get nothing at all offline.
    // Dtype-aware: the cache probe used to match any dtype's weights, which was right for one
    // configuration and wrong for two. With fp32 cached and q8 not, a q8 instance would have
    // reported `ready` and then downloaded mid-drain — defeating the consent gate that
    // `needs-download` exists to enforce.
    if (await isModelCached(this.#modelId, cacheStorage, this.#dtype)) {
      return { status: "ready" };
    }
    return { status: "needs-download", downloadBytes: this.#downloadBytes, detail: this.#modelId };
  }

  /**
   * The measured real-time factor for this instance's model, or `undefined` before
   * calibration.
   *
   * Task 6's hedge delay policy reads this through a host-supplied accessor —
   * `ribo-core` never learns what an RTF is, only that a function returns
   * milliseconds. Returns `undefined` (not a sentinel number) when no verdict is
   * stored, so the delay policy can distinguish "never measured" from "measured and
   * fast" and fall back to a default prediction rather than computing one from a
   * meaningless zero.
   */
  async measuredRtf(): Promise<number | undefined> {
    return readRtfVerdict(this.engine, this.#cacheStorage ?? globalThis.caches);
  }

  /**
   * Download and cache the model, streaming per-file progress to `onProgress`. Resolves once the
   * pipeline has constructed (weights fetched, ORT initialized, everything in `transformers-cache`)
   * and the RTF calibration has run; rejects if the worker reports an error during priming.
   * Explicit and user-initiated — never call this on a timer or a queue drain.
   *
   * After the pipeline is warm, one calibration inference runs over the committed
   * clip to measure this device's real-time factor (design §5.1). The pipeline is
   * already constructed at that point, so the measurement covers inference rather
   * than model load — measuring the load instead would produce a number that says
   * more about the disk than the device. A calibration failure is swallowed: it
   * leaves no verdict stored, which `capability()` treats as "unknown, therefore
   * ready", so the device degrades to today's behaviour instead of a broken prime.
   *
   * Safe to call again: a warm cache re-reads rather than re-downloads, and `onProgress` then sees no
   * `"progress"` byte events — which is exactly how a caller can confirm the second load hit cache.
   */
  prime(onProgress?: PrimeProgressListener): Promise<void> {
    const worker = this.#ensureWorker();
    const requestId = crypto.randomUUID();
    const message: MainToWorkerMessage = {
      type: "prime",
      requestId,
      config: this.#pipelineConfig(),
    };
    return this.#awaitReply(worker, message, "primed", "priming", onProgress).then(() =>
      this.#calibrate(),
    );
  }

  /**
   * Run one calibration transcription over the committed clip and persist the
   * measured real-time factor. Called after `prime()` has warmed the pipeline,
   * so the measurement covers decode + inference, not model load. Errors are
   * swallowed inside `measureRtf` — a calibration failure must not fail `prime()`.
   */
  async #calibrate(): Promise<void> {
    await measureRtf(
      (recording, audio) => this.transcribe(recording, audio),
      this.engine,
      this.#cacheStorage ?? globalThis.caches,
      this.#now,
    );
  }

  /** Terminate the worker, if one was created. The next {@link prime} constructs a fresh one. */
  dispose(): void {
    this.#worker?.terminate();
    this.#worker = undefined;
  }

  /**
   * Transcribe one recording. **`Blob` in**, per the `ribo-core` contract and doc 11 §4.
   *
   * The decode step runs **on this (main) thread**: `AudioContext`/`decodeAudioData` are Window-only,
   * so the queue's `Blob` is decoded and resampled to a 16 kHz mono `Float32Array` here
   * ({@link decodeTo16kMono}) and **transferred** to the worker (samples move, not copy). The worker
   * runs Whisper on the `Float32Array`, biased by the configured hints (turned into a decoder prefix
   * there). The returned {@link Transcript} is stamped with this transcriber's {@link engine}, so
   * provenance flows into the outbox.
   */
  async transcribe(recording: Recording, audio: Blob): Promise<Transcript> {
    const worker = this.#ensureWorker();
    const samples = await decodeTo16kMono(audio);
    const prompt = buildHintPrompt(this.#hints);
    const request: TranscribeWorkerRequest = { samples, ...(prompt ? { prompt } : {}) };
    const requestId = crypto.randomUUID();

    const message: MainToWorkerMessage = {
      type: "transcribe",
      requestId,
      config: this.#pipelineConfig(),
      request,
    };
    // Transfer the samples' backing buffer so the ~N MB of PCM moves rather than copies (doc 11 §2).
    const text = await this.#awaitReply(worker, message, "transcribed", "transcribing", undefined, [
      samples.buffer,
    ]);
    return { recordingId: recording.id, text: text ?? "", engine: this.engine };
  }

  /** The pipeline construction config the worker needs — the consumer's model/runtime choices. */
  #pipelineConfig(): PrimeConfig {
    return {
      modelId: this.#modelId,
      vadModelId: VAD_MODEL_ID,
      wasmPaths: this.#wasmPaths,
      ...(this.#device ? { device: this.#device } : {}),
      ...(this.#dtype ? { dtype: this.#dtype } : {}),
      ...(this.#revision ? { revision: this.#revision } : {}),
    };
  }

  /**
   * Post a request and resolve on its correlated terminal reply. Shared by prime and transcribe: the
   * worker multiplexes both conversations over one message channel, keyed by `requestId`, so a single
   * listener that filters on it and relays `progress` covers both. `transferable` moves the request's
   * backing buffers instead of copying them.
   */
  #awaitReply(
    worker: Worker,
    message: RequestMessage,
    done: "primed" | "transcribed",
    verb: string,
    onProgress?: PrimeProgressListener,
    transfer: Transferable[] = [],
    timeoutMs: number = this.#timeoutMs,
  ): Promise<string | undefined> {
    const requestId = message.requestId;
    return new Promise<string | undefined>((resolve, reject) => {
      // Without this, a worker that dies WITHOUT firing `error` — the shape an
      // out-of-memory kill takes, and the likeliest failure on a long recording —
      // leaves this promise pending forever. The relay drains serially and has no
      // timeout of its own, so that one silent death strands every capture behind
      // it for the rest of the day: no `failed` status, no backoff, no surface. A
      // timeout converts the worst outcome available (a bricked queue) into an
      // ordinary attempt failure the existing retry machinery already handles.
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `on-device transcription worker did not reply while ${verb} within ${timeoutMs} ms — ` +
              `it may have been killed (out of memory is the usual cause on long audio)`,
          ),
        );
      }, timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onError);
      };
      const onMessage = (event: MessageEvent<WorkerToMainMessage>): void => {
        const reply = event.data;
        // Live replies carry `sessionId`, not `requestId` — skip them so they do not
        // crosstalk with a batch conversation on the same worker channel.
        if (!("requestId" in reply) || reply.requestId !== requestId) return;
        if (reply.type === "progress") {
          onProgress?.(reply.progress);
          return;
        }
        if (reply.type === "error") {
          cleanup();
          reject(new Error(reply.message));
          return;
        }
        if (reply.type === done) {
          cleanup();
          resolve(reply.type === "transcribed" ? reply.text : undefined);
        }
      };
      const onError = (event: ErrorEvent): void => {
        cleanup();
        reject(new Error(event.message || `on-device transcription worker failed while ${verb}`));
      };
      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", onError);
      worker.postMessage(message, transfer);
    });
  }

  #ensureWorker(): Worker {
    this.#worker ??= this.#createWorker();
    return this.#worker;
  }
}
