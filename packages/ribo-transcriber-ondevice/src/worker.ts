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

import type {
  MainToWorkerMessage,
  PrimeConfig,
  PrimeProgress,
  TranscribeWorkerRequest,
  WorkerToMainMessage,
} from "./protocol.js";

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
  processor(audio: Float32Array): Promise<{ input_features: unknown }>;
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
  return `${config.modelId}|${config.device ?? "auto"}|${config.dtype ?? "default"}`;
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

/** Construct the pipeline for its download side effect, relaying progress (Task 2's `prime`). */
async function prime(
  config: PrimeConfig,
  onProgress: (progress: PrimeProgress) => void,
): Promise<void> {
  await getPipeline(config, onProgress);
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
 * Run inference on the decoded samples. Bypasses the pipeline's `_call_whisper` decode/merge on
 * purpose: it decodes the *whole* generated sequence including our injected prefix, which would
 * prepend the jargon to the transcript. Driving `model.generate` directly lets us slice the known
 * prefix off before decoding, so priming biases without leaking.
 *
 * Long-audio chunking is out of scope (plan: batch, short clips): the feature extractor truncates to
 * Whisper's 30 s window, so audio beyond that is silently clipped — a known PoC limitation, not a
 * bug to hide.
 */
async function transcribe(config: PrimeConfig, request: TranscribeWorkerRequest): Promise<string> {
  const pipeline = await getPipeline(config);
  const { input_features } = await pipeline.processor(request.samples);

  const prefix = request.prompt ? buildDecoderPrefix(pipeline, request.prompt) : [];
  const output = await pipeline.model.generate({
    inputs: input_features,
    ...(prefix.length > 0 ? { decoder_input_ids: prefix } : {}),
  });

  // Slice our injected prefix off; the model's own init tokens (sot/notimestamps, when we did not
  // inject a prefix) are special and fall out under `skip_special_tokens`.
  const generated = toTokenIds(output).slice(prefix.length);
  return pipeline.tokenizer.decode(generated, { skip_special_tokens: true }).trim();
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
