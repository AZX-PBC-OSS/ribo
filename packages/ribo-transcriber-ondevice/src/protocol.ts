/**
 * @file The **private** main↔worker message contract for `@azx/ribo-transcriber-ondevice`.
 *
 * This is *not* `ribo-core`'s `Transcriber` boundary (that speaks `Blob`, doc 11 §4). It is the
 * internal protocol this package owns between the main thread ({@link ../index.ts}) and the
 * inference worker ({@link ../worker.ts}). Both ends import these types so a change to the wire
 * shape is a compile error on the other side.
 *
 * Two conversations flow over it. **Priming** (Phase 3 Task 2 — model download + cache, defined
 * here) and **transcription** (Task 3 — the `Float32Array` in, text out described on
 * {@link TranscribeWorkerRequest} in `worker.ts`). Only priming is wired up in Task 2.
 */

/**
 * Everything the worker needs to construct the Whisper pipeline. Supplied by the main thread on
 * every prime because the worker holds no configuration of its own — the consumer's choices
 * (which model, where the ORT runtime is served) live on the main-thread `OnDeviceTranscriber`.
 */
/**
 * Weight quantization values transformers.js accepts for `dtype`. Mirrors the ORT `DataType` union
 * so our public options constrain to valid values without importing transformers types at the seam.
 */
export type OnnxDtype =
  | "auto"
  | "fp32"
  | "fp16"
  | "q8"
  | "int8"
  | "uint8"
  | "q4"
  | "bnb4"
  | "q4f16"
  | "q2"
  | "q2f16"
  | "q1"
  | "q1f16";

export interface PrimeConfig {
  /** HuggingFace repo id of the ASR model, e.g. `"Xenova/whisper-base.en"`. */
  readonly modelId: string;
  /**
   * HuggingFace repo id of the voice-activity model used to segment audio longer than Whisper's
   * 30 s receptive field. Everything downstream assumes **this** model's frame geometry, sampling
   * rate and powerset class map, so it is not a general substitution point — it exists so a
   * consumer can pin a revision or mirror the weights, not so they can swap in a different
   * architecture. Absent means long audio takes the fixed-window fallback instead.
   */
  readonly vadModelId?: string;
  /**
   * Same-origin base URL the ONNX Runtime `.wasm`/`.mjs` files are served from — assigned to
   * `env.backends.onnx.wasm.wasmPaths` in the worker. Must end in `/`. The default is a jsDelivr
   * CDN URL, which breaks the offline guarantee and trips strict host CSPs; the consumer supplies
   * this so the bytes come from their own origin. See {@link ../config.ts} and doc 01.
   */
  readonly wasmPaths: string;
  /**
   * ONNX Runtime execution provider. Omitted lets transformers.js auto-select (WebGPU where the
   * shipped build has it, WASM otherwise). Priming loads the backend either way, so this mostly
   * matters for Task 3's inference.
   */
  readonly device?: "webgpu" | "wasm";
  /** Optional weight quantization (`"q8"`, `"fp16"`, …). Omitted uses the model default. */
  readonly dtype?: OnnxDtype;
  /**
   * HuggingFace Hub revision to fetch — a branch name, tag, or (recommended for reproducibility) a
   * full commit hash. Forwarded verbatim to transformers.js's `pipeline()`, which defaults to
   * `"main"` when omitted. Pinning a hash means an upstream push to the model repo cannot silently
   * change what gets downloaded and run — the same property `pnpm-workspace.yaml`'s exact (no-caret)
   * catalog pins buy for this workspace's own dependencies, applied to a model repo instead of an
   * npm package. `scripts/pack-and-consume/` pins this for exactly that reason: see its header.
   */
  readonly revision?: string;
}

/**
 * One download-progress datum, normalized from transformers.js's `progress_callback`.
 *
 * Granular enough to drive a real bar: the `"progress"` stage carries per-file `loaded`/`total`
 * bytes. transformers.js emits these per file (config, tokenizer, each `.onnx` weight shard), so
 * a consumer aggregates across files to show one overall percentage.
 */
export type PrimeProgress =
  | { readonly stage: "initiate"; readonly file: string }
  | { readonly stage: "download"; readonly file: string }
  | {
      readonly stage: "progress";
      readonly file: string;
      /** Bytes fetched so far for this file. */
      readonly loaded: number;
      /** Total bytes for this file, when the response advertised a length. */
      readonly total: number;
      /** transformers.js's own 0–100 figure for this file. */
      readonly progress: number;
    }
  | { readonly stage: "done"; readonly file: string };

/**
 * The **private** transcribe request payload (doc 11 §4). Not `ribo-core`'s `Transcriber` boundary
 * (that is `Blob` in) — this is the message the worker receives once decode has happened on the main
 * thread.
 *
 * ## Why a `prompt` **string**, not `promptIds: number[]`
 *
 * The wire shape was pinned as `promptIds` in Task 2 on the assumption that the decoder priming
 * would ride transformers.js's `prompt_ids` generation-config field. Task 3 found two things that
 * flip that:
 *
 * 1. **`prompt_ids` is inert in `@huggingface/transformers` 4.2.0.** The field is declared on
 *    `WhisperGenerationConfig` but never read by `_retrieve_init_tokens`/`generate` — grep the src:
 *    it appears only in the class declaration and a commented-out line. Passing it does nothing.
 *    The mechanism that *does* bias decoding is `decoder_input_ids` (the pipeline forwards it and
 *    `generate` uses it verbatim as the decoder prefix).
 * 2. **Only the worker can tokenize.** Building the `decoder_input_ids` prefix needs the model's
 *    tokenizer and its special-token ids (`<|startofprev|>`, `<|startoftranscript|>`,
 *    `<|notimestamps|>`), which live in the worker's warm pipeline. The main thread has no tokenizer
 *    (loading one just to tokenize would drag transformers.js onto the main thread). So the main
 *    thread cannot produce token ids — it can only ship the **text**, and the worker turns it into a
 *    prefix.
 *
 * Hence the seam carries the hint text; {@link ../worker.ts} owns the text → `decoder_input_ids`
 * step. See the worker for the exact prompt construction and the prefix-stripping that keeps the
 * jargon out of the returned transcript.
 */
export interface TranscribeWorkerRequest {
  /**
   * 16 kHz mono PCM. Produced by a main-thread `decodeAudioData` at a 16 kHz `AudioContext`. Its
   * backing `ArrayBuffer` is passed in `postMessage`'s transfer list, so the samples move rather
   * than copy (~38 MB for a 20-minute clip).
   */
  readonly samples: Float32Array;
  /**
   * Domain-jargon priming text, assembled on the main thread from `ribo-core`'s `TranscribeHints`
   * (`vocabulary` + `prompt`). The worker tokenizes it into the Whisper decoder prefix — the biasing
   * that is the reason Whisper was chosen. Optional; absent means no priming.
   */
  readonly prompt?: string;
}

/** Main → worker. `"prime"` downloads+caches; `"transcribe"` runs batch inference;
 * `"liveOpen"`/`"liveFeed"`/`"liveClose"` are the live conversation (Task 3 live seam). */
export type MainToWorkerMessage =
  | {
      readonly type: "prime";
      /** Correlates the reply, so one worker can serve concurrent/queued requests without crosstalk. */
      readonly requestId: string;
      readonly config: PrimeConfig;
    }
  | {
      readonly type: "transcribe";
      readonly requestId: string;
      /** Same pipeline config as prime — the worker holds no config of its own (Task 2). */
      readonly config: PrimeConfig;
      readonly request: TranscribeWorkerRequest;
    }
  | {
      readonly type: "liveOpen";
      /** Correlates the `liveOpened` reply and stamps all subsequent segment replies for this session. */
      readonly sessionId: string;
      readonly config: PrimeConfig;
    }
  | {
      readonly type: "liveFeed";
      readonly sessionId: string;
      /** One 512-sample frame (16 kHz mono PCM). Transferred, not copied. */
      readonly frame: Float32Array;
    }
  | {
      readonly type: "liveClose";
      readonly sessionId: string;
    };

/** Worker → main. */
export type WorkerToMainMessage =
  | { readonly type: "progress"; readonly requestId: string; readonly progress: PrimeProgress }
  | { readonly type: "primed"; readonly requestId: string }
  | { readonly type: "transcribed"; readonly requestId: string; readonly text: string }
  | { readonly type: "error"; readonly requestId: string; readonly message: string }
  | { readonly type: "liveOpened"; readonly sessionId: string }
  | { readonly type: "liveSegment"; readonly sessionId: string; readonly text: string }
  | { readonly type: "liveError"; readonly sessionId: string; readonly message: string };
