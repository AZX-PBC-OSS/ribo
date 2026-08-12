/**
 * @file Streaming voice-activity detection — the live frame loop.
 *
 * Where {@link ./segmentation.ts} runs pyannote over the whole recording after `stop()`, this
 * module runs Silero VAD one 512-sample frame at a time **during** recording, carrying the
 * model's recurrent state tensor forward. It decides where an utterance starts and ends; a later
 * task feeds the closed buffers to an ASR model.
 *
 * **This is a pure, testable unit.** It takes frames in and emits utterance buffers out. The
 * model is not the thing under test — a {@link ProbabilityDetector} seam lets the frame-loop
 * logic run in a node unit test against a fake probability source, while the real Silero detector
 * (`createSileroDetector`) is exercised only by a manual browser test that downloads the model.
 *
 * ## The frame loop
 *
 * Per 512-sample frame (32 ms at 16 kHz), in order:
 *
 * 1. Run the detector, passing the previous state; keep the state it returns and feed it into the
 *    next call. **This is the entire streaming-state problem, solved by the model rather than by
 *    us** — Silero hands back its own recurrent state, so there is nothing to reconstruct.
 * 2. Hysteresis on the returned probability: enter speech at 0.3, leave below 0.1.
 * 3. While in speech, accumulate frames into a buffer capped at 30 s.
 * 4. When a region opens, prepend a FIFO of the preceding 80 ms of frames, so the consonant
 *    before the frame that *detected* speech is not clipped off.
 * 5. Close and emit the utterance after 400 ms of trailing silence.
 * 6. On the 30 s cap, emit and carry the overflow into the next buffer.
 *
 * Every constant above is adopted from `transformers.js-examples/moonshine-web` deliberately
 * rather than re-derived. Discard regions shorter than 250 ms of speech as noise.
 */

import { STREAMING_VAD_MODEL_ID } from "./config.js";

// ── Adopted constants ────────────────────────────────────────────────────────
//
// Every value below comes from the reference implementation
// (`transformers.js-examples/moonshine-web`). They are adopted, not derived — do not tune them
// without a measured reason, and read the design's frame-loop section before changing any.

/** Silero's frame size — 512 samples at 16 kHz = 32 ms per frame. */
export const VAD_FRAME_SIZE = 512;

/** The sample rate Silero expects. Matches Whisper's ({@link ./decode.ts}). */
export const VAD_SAMPLE_RATE = 16_000;

/** Probability at which a frame ENTERS speech. */
export const VAD_ENTER_THRESHOLD = 0.3;

/** Probability below which a frame LEAVES speech. Lower than the enter threshold — that gap is the hysteresis. */
export const VAD_EXIT_THRESHOLD = 0.1;

/** Pre-speech FIFO: keep this many ms of frames before the detection point. */
export const VAD_PRE_SPEECH_PAD_MS = 80;

/** Trailing silence that closes an utterance. */
export const VAD_MIN_SILENCE_MS = 400;

/** Buffer cap — emit and carry overflow past this. */
export const VAD_MAX_SPEECH_SECONDS = 30;

/** Speech shorter than this is noise, not an utterance. */
export const VAD_MIN_SPEECH_MS = 250;

/** One frame's duration in milliseconds (512 / 16000 × 1000). */
const FRAME_DURATION_MS = (VAD_FRAME_SIZE / VAD_SAMPLE_RATE) * 1000;

/** Pre-speech FIFO depth in frames — `ceil` so we pad at least 80 ms. */
const PRE_SPEECH_PAD_FRAMES = Math.ceil(VAD_PRE_SPEECH_PAD_MS / FRAME_DURATION_MS);

/** Trailing silence to close, in frames — `ceil` so we wait at least 400 ms. */
const MIN_SILENCE_FRAMES = Math.ceil(VAD_MIN_SILENCE_MS / FRAME_DURATION_MS);

/** Minimum speech frames for a region to survive the noise filter — `ceil` so at least 250 ms. */
const MIN_SPEECH_FRAMES = Math.ceil(VAD_MIN_SPEECH_MS / FRAME_DURATION_MS);

/** Maximum frames in the speech buffer before the cap emits — `floor` so we never exceed 30 s. */
const MAX_SPEECH_FRAMES = Math.floor((VAD_MAX_SPEECH_SECONDS * VAD_SAMPLE_RATE) / VAD_FRAME_SIZE);

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * A closed utterance — the PCM samples ready for ASR. Includes the pre-speech FIFO and the
 * trailing silence that closed it; both are harmless to the decoder and trimming them would add
 * complexity for no gain.
 */
export interface Utterance {
  /** 16 kHz mono PCM for this utterance — the concatenated frame buffers. */
  readonly samples: Float32Array;
}

/**
 * The probability source the frame loop drives. Injecting this keeps the model out of the frame
 * loop's unit tests: a fake detector returns deterministic probabilities, and the real Silero
 * detector (created by {@link createSileroDetector}) is exercised only by the manual test.
 *
 * The state tensor is an opaque `Float32Array` at this seam — its shape and semantics are the
 * model's concern. The frame loop's only responsibility is to **carry it forward**: feed the
 * state returned by call N into call N+1, never the initial zero state twice.
 */
export interface ProbabilityDetector {
  /** The initial recurrent state — zero-filled, shaped by the model. The frame loop starts here. */
  readonly initialState: Float32Array;
  /**
   * Run inference on one frame, threading the recurrent state. Returns the speech probability and
   * the **new** state to feed into the next call. The frame loop keeps the returned state and
   * passes it to the next `detect` — never the initial state, never a copy.
   */
  detect(
    frame: Float32Array,
    state: Float32Array,
  ): Promise<{ readonly probability: number; readonly state: Float32Array }>;
}

// ── The frame loop ───────────────────────────────────────────────────────────

/**
 * Concatenate an array of frames into a single PCM buffer. Each frame is a `Float32Array` of
 * {@link VAD_FRAME_SIZE} samples; the output is the unrolled utterance.
 */
function concatenateFrames(frames: readonly Float32Array[]): Float32Array {
  const total = frames.reduce((sum, f) => sum + f.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const f of frames) {
    out.set(f, offset);
    offset += f.length;
  }
  return out;
}

/**
 * The streaming VAD — turns a flow of 512-sample frames into closed utterances.
 *
 * Feed frames via {@link feed}; each call returns zero or more completed utterances. Most frames
 * return `[]` — an utterance only appears when trailing silence closes a region or the 30 s cap
 * overflows. The class is the entire state machine: recurrent state, hysteresis, the pre-speech
 * FIFO, the speech buffer, and the silence counter.
 *
 * `feed` serializes through an internal promise chain so the recurrent state is never raced —
 * two concurrent feeds would read and write the same state tensor. The fake detectors in tests
 * resolve instantly, so this is invisible there; against the real model it is the same
 * "one inference at a time" constraint the batch worker already lives under.
 */
export class StreamingVad {
  readonly #detector: ProbabilityDetector;

  // ── Recurrent state ──
  // The model's state tensor, threaded from one frame to the next. Starts at the detector's
  // initial state and is replaced with whatever `detect` returns after each frame.
  #state: Float32Array;

  // ── Hysteresis + buffers ──
  #inSpeech = false;
  // Frames accumulated while in speech (including the pre-speech FIFO at the start and the
  // trailing silence at the end).
  #speechFrames: Float32Array[] = [];
  // Running FIFO of recent non-speech frames, prepended when a region opens.
  #preSpeechFifo: Float32Array[] = [];
  // Consecutive silence frames while in speech — reaches MIN_SILENCE_FRAMES to close.
  #silenceFrameCount = 0;
  // Speech frames (probability ≥ exit) in the current region — drives the 250 ms noise filter.
  // Distinct from `speechFrames.length`, which includes FIFO padding and trailing silence.
  #speechFrameCount = 0;

  // Serializes feed calls so the recurrent state is never raced.
  #chain: Promise<readonly Utterance[]> = Promise.resolve([]);

  constructor(detector: ProbabilityDetector) {
    this.#detector = detector;
    this.#state = new Float32Array(detector.initialState);
  }

  /**
   * Process one 512-sample frame. Returns any utterances that closed on this frame (zero, one, or
   * rarely two — the 30 s cap and the silence close can both fire on the same frame). Awaited
   * sequentially: the next `feed` does not begin inference until this one's state is settled.
   */
  feed(frame: Float32Array): Promise<readonly Utterance[]> {
    const next = this.#chain.then(() => this.#processFrame(frame));
    // Swallow rejections on the chain only — the caller still sees them through `next`.
    this.#chain = next.then(
      () => [],
      () => [],
    );
    return next;
  }

  /**
   * The frame loop itself. Separated from {@link feed} so the serialization wrapper is testable
   * as a plain method — the tests call this directly against a fake detector.
   */
  async #processFrame(frame: Float32Array): Promise<readonly Utterance[]> {
    const { probability, state: newState } = await this.#detector.detect(frame, this.#state);
    // Keep the state the model returns and feed it into the next call. This is the whole
    // streaming-state mechanism — see the file header and the spike's Q2 evidence.
    this.#state = newState;

    const utterances: Utterance[] = [];

    if (!this.#inSpeech) {
      if (probability >= VAD_ENTER_THRESHOLD) {
        // A region opens: start the speech buffer with the pre-speech FIFO plus the detection
        // frame, so the consonant before the frame that *detected* speech is not clipped.
        this.#inSpeech = true;
        this.#speechFrames = [...this.#preSpeechFifo, frame];
        this.#preSpeechFifo = [];
        this.#silenceFrameCount = 0;
        // The detection frame is speech (probability ≥ enter > exit); FIFO frames are not.
        this.#speechFrameCount = 1;
      } else {
        // Not speech: maintain the FIFO for the next region's pre-speech padding.
        this.#preSpeechFifo.push(frame);
        if (this.#preSpeechFifo.length > PRE_SPEECH_PAD_FRAMES) this.#preSpeechFifo.shift();
      }
      return utterances;
    }

    // ── In speech ──

    // Cap check: if adding this frame would exceed 30 s, emit the current buffer and carry the
    // overflow into a fresh one. The emitted utterance is 30 s — far above the 250 ms noise
    // filter — so it always survives.
    if (this.#speechFrames.length + 1 > MAX_SPEECH_FRAMES) {
      utterances.push({ samples: concatenateFrames(this.#speechFrames) });
      this.#speechFrames = [];
      this.#speechFrameCount = 0;
    }

    this.#speechFrames.push(frame);

    if (probability < VAD_EXIT_THRESHOLD) {
      this.#silenceFrameCount++;
      if (this.#silenceFrameCount >= MIN_SILENCE_FRAMES) {
        // Close: emit if the speech was long enough, discard as noise if not.
        if (this.#speechFrameCount >= MIN_SPEECH_FRAMES) {
          utterances.push({ samples: concatenateFrames(this.#speechFrames) });
        }
        this.#inSpeech = false;
        this.#speechFrames = [];
        this.#silenceFrameCount = 0;
        this.#speechFrameCount = 0;
        this.#preSpeechFifo = [];
      }
    } else {
      // Still speech: reset the silence counter and count this frame toward the min-speech filter.
      this.#silenceFrameCount = 0;
      this.#speechFrameCount++;
    }

    return utterances;
  }
}

// ── The real Silero detector ─────────────────────────────────────────────────

/**
 * Minimal structural view of the Silero model and transformers.js's `Tensor`. Loosely typed at
 * the seam for the same reason {@link ./worker.ts}'s `AsrPipeline` is: importing transformers.js
 * types into the static graph would pull `onnxruntime-node` into the node-side unit tests.
 */
interface SileroModelLike {
  (inputs: Record<string, unknown>): Promise<Record<string, { readonly data: unknown }>>;
}
interface TransformersEnvLike {
  readonly backends?: {
    readonly onnx?: {
      readonly wasm?: { wasmPaths: string };
    };
  };
}

/**
 * The Silero ONNX graph's state shape — `[2, 1, 128]` = 256 floats, zero-initialised. Discovered
 * in the spike (see `live-spike-findings.md` §Q1): the input/output names are `input`, `sr`,
 * `state` / `output`, `stateN`, not the Hugging Face reference snippet's names.
 */
const SILERO_STATE_SIZE = 2 * 1 * 128;

/**
 * Create a {@link ProbabilityDetector} backed by the real Silero VAD model. Loads
 * `onnx-community/silero-vad` through the same `@huggingface/transformers` the ASR path uses
 * (`AutoModel` with `config: { model_type: "custom" }`, not raw `onnxruntime-web`), under the
 * same same-origin `wasmPaths` config.
 *
 * The import of `@huggingface/transformers` is **dynamic** — inside this factory, not at module
 * top level — for the same reason {@link ./worker.ts} defers it: the Node entry pulls
 * `onnxruntime-node`, which would break the node-side unit tests that import this module for the
 * frame-loop logic alone. Only the manual browser test calls this factory.
 *
 * Measured in the spike: 2.14 MB fp32 weights, 0.20 ms per frame, 0.6 % of the 32 ms frame
 * budget. The state contract is load-bearing — see {@link ProbabilityDetector} and the spike's
 * Q2 ("312 of 313 frames differ, max ΔP 0.29 — larger than the 0.3/0.1 hysteresis gap").
 */
export async function createSileroDetector(config: {
  /** Same-origin base URL for the ORT `.wasm`/`.mjs` runtime — assigned to `env.backends.onnx.wasm.wasmPaths`. */
  readonly wasmPaths: string;
  /** Optional HuggingFace Hub revision to pin the model weights. */
  readonly revision?: string;
}): Promise<ProbabilityDetector> {
  const { AutoModel, env, Tensor } = await import("@huggingface/transformers");
  const wasm = (env as TransformersEnvLike).backends?.onnx?.wasm;
  if (wasm) wasm.wasmPaths = config.wasmPaths;

  // `config: { model_type: "custom" }` makes `AutoModel` fall through to its `BASE_IF_FAIL` base
  // class — the spike confirmed this is the loading path for Silero (see live-spike-findings.md
  // §Q1). Cast through `unknown` because the `config` field's declared type demands a full
  // `PretrainedConfig`, which we do not have and do not need for a custom-model fallback.
  const model = (await AutoModel.from_pretrained(STREAMING_VAD_MODEL_ID, {
    config: { model_type: "custom" } as unknown as never,
    dtype: "fp32",
    ...(config.revision ? { revision: config.revision } : {}),
  })) as unknown as SileroModelLike;

  const initialState = new Float32Array(SILERO_STATE_SIZE);

  return {
    initialState,
    async detect(
      frame: Float32Array,
      state: Float32Array,
    ): Promise<{ readonly probability: number; readonly state: Float32Array }> {
      // The spike established the exact input contract: `input` must be `[1, 512]` (auto-dims
      // `[512]` is rejected), `sr` is int64 `[1]`, `state` is float32 `[2, 1, 128]`.
      const inputTensor = new Tensor("float32", frame, [1, frame.length]);
      const srTensor = new Tensor("int64", BigInt64Array.from([BigInt(VAD_SAMPLE_RATE)]), [1]);
      const stateTensor = new Tensor("float32", state, [2, 1, 128]);
      const output = await model({
        input: inputTensor as unknown,
        sr: srTensor as unknown,
        state: stateTensor as unknown,
      });

      const probData = output["output"]?.data as number[] | Float32Array | undefined;
      const stateData = output["stateN"]?.data as Float32Array | undefined;
      if (probData === undefined || !stateData) {
        throw new Error(
          "silero-vad: model output missing `output` or `stateN`. The ONNX graph's output names " +
            "may have changed — see live-spike-findings.md §Q1 for the discovered contract.",
        );
      }
      const probability = probData[0] as number;
      // Copy the returned state so the next call owns its own buffer — the Tensor's data may be
      // a view into WASM heap that the next inference overwrites.
      const newState = new Float32Array(stateData);
      return { probability, state: newState };
    },
  };
}
