/**
 * @file On-device implementation of `@azx/ribo-core`'s {@link LiveTranscriber} seam.
 *
 * Live (utterance-level) transcription over the same worker that runs batch inference.
 * The worker runs Silero VAD per frame (Task 2's {@link StreamingVad}) and, when an
 * utterance closes, transcribes it with the same ASR pipeline the batch path uses.
 * This file is the main-thread half: it owns the worker, posts frames synchronously,
 * and routes segment replies back through a `Subject` — the `Observable` the host
 * subscribes to.
 *
 * ## `feed()` is synchronous — the whole point
 *
 * `feed()` is called from an audio callback. If it awaited the model, the audio thread
 * would stall and capture would degrade. The implementation posts the frame to the
 * worker with `postMessage` (synchronous) and returns immediately. Inference runs
 * asynchronously in the worker; the resulting text arrives on `segments$` when it
 * completes.
 *
 * ## Late replies are dropped by `sessionId`, not by "no subscribers"
 *
 * `close()` marks the session closed but does **not** complete the `Subject` or remove
 * the message listener. A reply from a closed session (the worker was mid-inference
 * when `close()` arrived) hits the listener, which checks `#closed` and drops it. This
 * is the session-id guard the design requires — completing the `Subject` instead would
 * make the test pass against no guard at all.
 */

import { Subject } from "rxjs";
import type { Observable } from "rxjs";

import type {
  LiveSession,
  LiveTranscriber,
  Recording,
  TranscriberCapability,
} from "@azx/ribo-core";

import {
  DEFAULT_MODEL_ID,
  STREAMING_VAD_DOWNLOAD_BYTES,
  STREAMING_VAD_MODEL_ID,
  defaultCreateWorker,
  estimateDownloadBytes,
} from "./config.js";
import type { OnnxDtype } from "./protocol.js";
import { isModelCached, TRANSFORMERS_CACHE_NAME } from "./model-cache.js";
import type { PrimeConfig, WorkerToMainMessage } from "./protocol.js";

/**
 * Is the streaming VAD (Silero) cached? A simpler check than {@link isModelCached}: Silero
 * is a single ONNX file, not an encoder-decoder pair, so the "both encoder and decoder"
 * guard that protects the batch ASR cache does not apply here. Any `.onnx` file under the
 * model's cache path means the weights are present.
 */
async function isStreamingVadCached(cacheStorage: CacheStorage): Promise<boolean> {
  if (!(await cacheStorage.has(TRANSFORMERS_CACHE_NAME))) return false;
  const cache = await cacheStorage.open(TRANSFORMERS_CACHE_NAME);
  const keys = await cache.keys();
  const marker = `${STREAMING_VAD_MODEL_ID}/`;
  return keys.some((request) => request.url.includes(marker) && request.url.includes(".onnx"));
}

/**
 * A live session backed by a Web Worker. The main-thread half of the live conversation:
 * `feed()` posts frames synchronously, and the message listener routes `liveSegment`
 * replies into the `Subject` — unless the session is closed, in which case the reply is
 * dropped by the `#closed` guard (not by Subject completion or listener removal).
 */
class OnDeviceLiveSession implements LiveSession {
  readonly sessionId: string;
  readonly #subject = new Subject<string>();
  #closed = false;
  readonly #worker: Worker;
  readonly #onMessage: (event: MessageEvent<WorkerToMainMessage>) => void;

  constructor(sessionId: string, worker: Worker) {
    this.sessionId = sessionId;
    this.#worker = worker;

    this.#onMessage = (event: MessageEvent<WorkerToMainMessage>): void => {
      const reply = event.data;
      // Live replies carry `sessionId`, not `requestId` — skip batch replies on the same channel.
      if (!("sessionId" in reply) || reply.sessionId !== this.sessionId) return;
      if (reply.type !== "liveSegment") return;
      // THE GUARD: a closed session's late reply is dropped here, by sessionId — not by
      // "the observable has no subscribers" or Subject completion. See the file header.
      if (this.#closed) return;
      this.#subject.next(reply.text);
    };
    worker.addEventListener("message", this.#onMessage);
  }

  feed(frame: Float32Array): void {
    if (this.#closed) return;
    // Synchronous — postMessage queues the message in the worker's event loop and returns
    // before the worker processes it. This is the entire non-blocking property: the audio
    // callback that called `feed` is free to continue immediately.
    this.#worker.postMessage({ type: "liveFeed", sessionId: this.sessionId, frame }, [
      frame.buffer,
    ]);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#worker.postMessage({ type: "liveClose", sessionId: this.sessionId });
    // Intentionally do NOT remove the listener or complete the Subject here. The listener
    // stays so late replies are received and checked against `#closed` — removing it would
    // drop them by listener removal, which passes the test without the guard. The Subject
    // stays open so the guard is `#closed`, not Subject completion.
  }

  get segments$(): Observable<string> {
    return this.#subject.asObservable();
  }
}

/**
 * Options for {@link OnDeviceLiveTranscriber}. A subset of `OnDeviceTranscriberOptions` —
 * live has no hints (Moonshine cannot be primed) and no batch-timeout concerns. The same
 * `wasmPaths` and `createWorker` constraints apply: see {@link OnDeviceTranscriberOptions}.
 */
export interface OnDeviceLiveTranscriberOptions {
  /** Required — same-origin ORT runtime path. See `OnDeviceTranscriberOptions.wasmPaths`. */
  readonly wasmPaths: string;
  /** Factory for the inference worker. See `OnDeviceTranscriberOptions.createWorker`. */
  readonly createWorker?: () => Worker;
  /**
   * How long to wait for the worker to report the session open. Defaults to
   * {@link DEFAULT_LIVE_OPEN_TIMEOUT_MS}. Exists so a stalled model load fails as "no preview"
   * rather than pending forever — see the comment in `openSession`.
   */
  readonly openTimeoutMs?: number;
  /** ASR model repo id. Defaults to {@link DEFAULT_MODEL_ID}. */
  readonly modelId?: string;
  /** ORT execution provider. Omitted lets transformers.js auto-select. */
  readonly device?: "webgpu" | "wasm";
  /** Optional weight quantization passed through to the pipeline. */
  readonly dtype?: OnnxDtype;
  /** HuggingFace Hub revision to pin model weights. */
  readonly revision?: string;
  /** Injectable `CacheStorage` for `liveCapability()` — defaults to `globalThis.caches`. */
  readonly cacheStorage?: CacheStorage;
}

/**
 * On-device live transcription, implementing `@azx/ribo-core`'s {@link LiveTranscriber}.
 *
 * Creates a Web Worker that runs the Task 2 streaming VAD (Silero) per frame and transcribes
 * closed utterances with the same ASR pipeline the batch path uses. The worker is separate
 * from `OnDeviceTranscriber`'s — sharing one worker across live and batch is a host wiring
 * concern (Task 5), not a property of this class.
 */
/**
 * How long {@link OnDeviceLiveTranscriber.openSession} waits for the worker to report the session
 * open, before giving up and leaving the caller with no preview.
 *
 * **Much shorter than the batch `DEFAULT_WORKER_TIMEOUT_MS` (600 s), and deliberately so.** That one
 * bounds transcribing a long recording; this bounds loading a 2.14 MB VAD model, measured at ~2.4 s
 * cold in the spike. A minute is generous for a slow uplink and still short enough that a stalled
 * open fails while the auditor is on their first sentence rather than their last.
 */
export const DEFAULT_LIVE_OPEN_TIMEOUT_MS = 60_000;

export class OnDeviceLiveTranscriber implements LiveTranscriber {
  readonly #modelId: string;
  readonly #wasmPaths: string;
  readonly #device?: "webgpu" | "wasm";
  readonly #dtype?: OnnxDtype;
  readonly #revision?: string;
  readonly #cacheStorage?: CacheStorage;
  readonly #createWorker: () => Worker;
  readonly #timeoutMs: number;

  /** Constructed lazily on the first `openSession`, then reused. */
  #worker?: Worker;

  constructor(options: OnDeviceLiveTranscriberOptions) {
    this.#modelId = options.modelId ?? DEFAULT_MODEL_ID;
    this.#wasmPaths = options.wasmPaths;
    this.#device = options.device;
    this.#dtype = options.dtype;
    this.#revision = options.revision;
    this.#cacheStorage = options.cacheStorage;
    this.#createWorker = options.createWorker ?? defaultCreateWorker;
    this.#timeoutMs = options.openTimeoutMs ?? DEFAULT_LIVE_OPEN_TIMEOUT_MS;
  }

  async liveCapability(): Promise<TranscriberCapability> {
    const cacheStorage = this.#cacheStorage ?? globalThis.caches;
    if (!cacheStorage) {
      return {
        status: "unavailable",
        reason: "unsupported-platform",
        detail: "Cache API unavailable — the models cannot be cached for offline use here.",
      };
    }
    const asrCached = await isModelCached(this.#modelId, cacheStorage);
    const vadCached = await isStreamingVadCached(cacheStorage);
    if (asrCached && vadCached) return { status: "ready" };
    if (!asrCached) {
      // ASR not cached: the user needs both. Include the streaming VAD alongside the ASR
      // download — `estimateDownloadBytes` counts the batch VAD (pyannote), not Silero.
      return {
        status: "needs-download",
        downloadBytes: estimateDownloadBytes(this.#modelId) + STREAMING_VAD_DOWNLOAD_BYTES,
        detail: this.#modelId,
      };
    }
    // ASR cached but streaming VAD not — a small download (2.14 MB) standing between the
    // user and a live preview. `liveCapability()` is separate from `capability()` precisely
    // so this state is expressible: batch is ready, live is not.
    return {
      status: "needs-download",
      downloadBytes: STREAMING_VAD_DOWNLOAD_BYTES,
      detail: STREAMING_VAD_MODEL_ID,
    };
  }

  async openSession(_recording: Recording): Promise<LiveSession> {
    const worker = this.#ensureWorker();
    const sessionId = crypto.randomUUID();

    // **A timeout and an `error` listener, for the same reason the batch path has both.**
    // `#awaitReply` in `index.ts` carries a long comment about it: a worker killed for memory often
    // dies WITHOUT firing `error`, so a promise waiting only on a reply waits forever. The live open
    // has the identical shape — the worker constructs fine, then the VAD model load stalls (a
    // service-worker misroute, a cache evicted between `liveCapability()` and here) and neither
    // `liveOpened` nor `liveError` ever arrives.
    //
    // Unbounded, that pends forever holding a session the caller believes is coming. A host that
    // AWAITS this on its record path would hang recording start — live degrading recording, the one
    // outcome this feature is forbidden from producing. Rejecting instead lands the caller on "no
    // preview for this recording", which the seam's own docs already name as the correct response.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `on-device live session did not open within ${String(this.#timeoutMs)} ms — the worker ` +
              `may have been killed, or the VAD model load stalled`,
          ),
        );
      }, this.#timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        worker.removeEventListener("message", onOpen);
        worker.removeEventListener("error", onError);
      };
      const onError = (): void => {
        cleanup();
        reject(new Error("on-device live worker failed before the session opened"));
      };
      const onOpen = (event: MessageEvent<WorkerToMainMessage>): void => {
        const reply = event.data;
        if (!("sessionId" in reply) || reply.sessionId !== sessionId) return;
        if (reply.type === "liveOpened") {
          cleanup();
          resolve();
        } else if (reply.type === "liveError") {
          cleanup();
          reject(new Error(reply.message));
        }
      };
      worker.addEventListener("message", onOpen);
      worker.addEventListener("error", onError);
      worker.postMessage({ type: "liveOpen", sessionId, config: this.#pipelineConfig() });
    });

    return new OnDeviceLiveSession(sessionId, worker);
  }

  /** Terminate the worker, if one was created. The next `openSession` constructs a fresh one. */
  dispose(): void {
    this.#worker?.terminate();
    this.#worker = undefined;
  }

  #ensureWorker(): Worker {
    this.#worker ??= this.#createWorker();
    return this.#worker;
  }

  /** The pipeline config for the worker — no `vadModelId` (that is the batch pyannote VAD). */
  #pipelineConfig(): PrimeConfig {
    return {
      modelId: this.#modelId,
      wasmPaths: this.#wasmPaths,
      ...(this.#device ? { device: this.#device } : {}),
      ...(this.#dtype ? { dtype: this.#dtype } : {}),
      ...(this.#revision ? { revision: this.#revision } : {}),
    };
  }
}
