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
import type {
  MainToWorkerMessage,
  OnnxDtype,
  PrimeConfig,
  PrimeProgress,
  TranscribeWorkerRequest,
  WorkerToMainMessage,
} from "./protocol.js";

export {
  buildHintPrompt,
  DEFAULT_MODEL_ID,
  DEFAULT_WORKER_TIMEOUT_MS,
  MODEL_DOWNLOAD_BYTES,
  modelSupportsHints,
  VAD_MODEL_ID,
  VAD_DOWNLOAD_BYTES,
  estimateDownloadBytes,
} from "./config.js";
export type { OnDeviceTranscriberOptions, TranscribeHints } from "./config.js";
export { decodeTo16kMono } from "./decode.js";
export { TRANSFORMERS_CACHE_NAME, isModelCached } from "./model-cache.js";
export type { PrimeConfig, PrimeProgress, TranscribeWorkerRequest } from "./protocol.js";

/**
 * `Transcriber.engine` this implementation stamps onto every {@link Transcript} it produces. Short
 * and stable across versions — it rides into the outbox document, so the on-device/managed engine
 * mix is readable straight off `Outbox.list()`. Matches `docs/implementation/03` and `transcript.ts`.
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
  readonly engine = ONDEVICE_WHISPER_ENGINE;

  readonly #modelId: string;
  readonly #wasmPaths: string;
  readonly #device?: "webgpu" | "wasm";
  readonly #dtype?: OnnxDtype;
  readonly #revision?: string;
  readonly #hints?: TranscribeHints;
  readonly #downloadBytes: number;
  readonly #cacheStorage?: CacheStorage;
  readonly #createWorker: () => Worker;
  readonly #timeoutMs: number;

  /** Constructed lazily on the first {@link prime}, then reused. */
  #worker?: Worker;

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
    this.#createWorker = options.createWorker ?? defaultCreateWorker;
    this.#timeoutMs = options.workerTimeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS;
  }

  /**
   * What this engine can do right now, judged from the Cache API alone (no download, cheap enough to
   * call often per the `Transcriber` contract).
   *
   * - No `CacheStorage` at all → `unavailable`/`unsupported-platform`: without it the model cannot be
   *   persisted for offline use, which is the entire premise. Permanent, so `firstCapable` stops
   *   re-probing it.
   * - Model weights already in `transformers-cache` → `ready`.
   * - Otherwise → `needs-download`, carrying the byte estimate (weights **plus** the ORT runtime) for
   *   the consent screen. `firstCapable` deliberately never auto-selects this — the fetch needs a
   *   human's say-so, which {@link prime} is where it happens.
   *
   * Task-2 honest: this reflects cache state, not a measured throughput verdict. The `too-slow`
   * real-time-factor gate and the WebGPU probe are Task 3/4.
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
    // `ready` is judged on the ASR weights ALONE. The voice-activity model is a quality upgrade for
    // recordings past 30 s, and its absence is covered by the fixed-window fallback — so reporting
    // `needs-download` without it would be actively harmful: `firstCapable` selects only `ready`
    // transcribers and skips `needs-download`, so a user who primed before VAD shipped would
    // silently switch to a managed transcriber, or get nothing at all offline.
    if (await isModelCached(this.#modelId, cacheStorage)) {
      return { status: "ready" };
    }
    return { status: "needs-download", downloadBytes: this.#downloadBytes, detail: this.#modelId };
  }

  /**
   * Download and cache the model, streaming per-file progress to `onProgress`. Resolves once the
   * pipeline has constructed (weights fetched, ORT initialized, everything in `transformers-cache`);
   * rejects if the worker reports an error. Explicit and user-initiated — never call this on a timer
   * or a queue drain.
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
    return this.#awaitReply(worker, message, "primed", "priming", onProgress).then(() => undefined);
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
    message: MainToWorkerMessage,
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
        if (reply.requestId !== requestId) return;
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
