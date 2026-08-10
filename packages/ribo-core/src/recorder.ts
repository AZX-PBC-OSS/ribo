import { baseRecordingSchema, type Recording } from "./recording.js";

/**
 * @file Microphone capture: `MediaRecorder` in, a {@link Recording} plus its audio `Blob` out.
 *
 * Two things here are load-bearing beyond "record some audio".
 *
 * **1. The container is negotiated, not assumed.** `MediaRecorder` emits a different container per
 * browser — Opus-in-WebM on Chromium, MP4/AAC on Safari — and if the `mimeType` written onto the
 * `Recording` does not match the bytes, Phase 3's decoder fails on one browser only, far from the
 * line that caused it. {@link negotiateMimeType} probes `MediaRecorder.isTypeSupported` against an
 * ordered preference list, and the recorder then records the type the live `MediaRecorder`
 * *reports*, not the one that was requested.
 *
 * **2. The stream is released on stop.** Leaving tracks live keeps the microphone open and the
 * browser's recording indicator lit after the user thinks capture ended. In a field tool that is a
 * privacy problem, not a resource leak. Every exit path from {@link Recorder.start} and
 * {@link Recorder.stop} — including the failing ones — goes through `#teardown()`. {@link
 * Recorder.pause} deliberately does **not** follow this rule: `MediaRecorder.resume()` requires
 * the same stream, so pausing cannot release the tracks, and the recording indicator stays lit
 * until {@link Recorder.stop}. See the note on `pause` for why that is surfaced, not hidden.
 *
 * **3. A mid-capture failure is surfaced, not banked.** `MediaRecorder` can raise `error` at any
 * point while running. When it does, the recorder moves to `failed` and emits immediately — so a
 * UI stops showing a live capture and a contractor stops dictating into a dead recorder. The
 * failure is also exposed on {@link RecorderState}.error, so a host can render *why* rather than
 * just that something stopped. `stop()` still rejects with the same error and still tears down;
 * the existing behaviour is right, it was just too late.
 *
 * `ribo-core` is headless: `navigator.mediaDevices`, `MediaRecorder` and `AudioContext` are fair
 * game, `document`/`window` are not (AGENTS.md §4). Nothing here needs an element, so nothing here
 * takes one.
 */

/**
 * Container preference, best first.
 *
 * - `audio/webm;codecs=opus` — Chromium and Firefox. Opus is the right codec for speech at low
 *   bitrate, and WebM/Opus is what the Whisper tooling in Phase 3 expects to be handed.
 * - `audio/ogg;codecs=opus` — same codec, the container Firefox has historically preferred.
 * - `audio/mp4;codecs=opus` — Opus in MP4, accepted by recent Safari; still Opus, so still the
 *   preferred codec, just a different wrapper.
 * - `audio/mp4` — Safari's AAC fallback. Lossy-to-lossy transcoding is not free, but a recording
 *   in a container we can decode beats no recording at all.
 * - `audio/webm` — bare container, no codecs parameter. Last resort: the browser picks the codec,
 *   and {@link Recorder} reports back whatever the live `MediaRecorder` says it actually chose.
 *
 * Order is codec first, container second: everything Opus outranks everything AAC.
 *
 * Measured in the Playwright Chromium this repo tests against (2026-07-23):
 * `audio/webm;codecs=opus` true, `audio/ogg;codecs=opus` **false**, `audio/mp4;codecs=opus` true,
 * `audio/mp4` true, `audio/webm` true — and a recorder asked for `audio/webm;codecs=opus` reports
 * exactly that back. The Ogg entry earns its place on Firefox, not here; it is listed second so a
 * browser without WebM still gets Opus.
 */
export const DEFAULT_MIME_TYPE_PREFERENCES: readonly string[] = [
  "audio/webm;codecs=opus",
  "audio/ogg;codecs=opus",
  "audio/mp4;codecs=opus",
  "audio/mp4",
  "audio/webm",
];

/** Why capture failed. Stable strings — a UI may switch on these. */
export type RecorderErrorCode =
  /** No entry in the preference list is supported by this browser. */
  | "unsupported-mime-type"
  /** The user (or policy) denied microphone access. */
  | "permission-denied"
  /** There is no microphone to record from. */
  | "no-input-device"
  /** `start()` while already recording. */
  | "already-recording"
  /** `stop()` with nothing in flight. */
  | "not-recording"
  /** Anything else the browser threw while setting up or running the capture. */
  | "capture-failed";

/**
 * A capture failure with a machine-readable {@link RecorderErrorCode}.
 *
 * The original `DOMException` is kept as `cause` — the code is for branching, the cause is for
 * diagnosing.
 */
export class RecorderError extends Error {
  override readonly name = "RecorderError";
  readonly code: RecorderErrorCode;

  constructor(code: RecorderErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}

/**
 * Returns the first supported type in `preferences`.
 *
 * @throws {RecorderError} `unsupported-mime-type` if none is supported. Deliberately louder than
 * falling back to the browser default: a `Recording` whose `mimeType` does not describe its bytes
 * is worse than a capture that refused to start, because it fails later and somewhere else.
 */
export const negotiateMimeType = (
  preferences: readonly string[] = DEFAULT_MIME_TYPE_PREFERENCES,
): string => {
  const supported = preferences.find((type) => MediaRecorder.isTypeSupported(type));
  if (supported !== undefined) return supported;

  throw new RecorderError(
    "unsupported-mime-type",
    `This browser supports none of the audio container types Ribo can record: ${preferences.join(
      ", ",
    )}. Pass \`mimeTypes\` with a type this browser reports from MediaRecorder.isTypeSupported.`,
  );
};

/**
 * Idle → recording ⇄ paused → stopping → idle, with `failed` as the honest
 * phase for a capture that died mid-stream.
 *
 * `MediaRecorder` can raise `error` at any point while running. When it does,
 * the recorder moves to `failed` — not back to `idle`, because the microphone
 * is still open and `stop()` has not torn down yet, and not stuck at
 * `recording`, because that would lie to a UI that keeps showing a live
 * capture. `failed` is a **new member of this union**, not an alias of
 * `stopping`: a consumer that switches on `phase` must account for it or its
 * default branch fires. The recorder transitions `failed → stopping → idle`
 * through `stop()`, which still rejects with the failure and still tears down —
 * the existing behaviour is right, it was just too late.
 *
 * `paused` keeps the microphone **open**: `MediaRecorder.resume()` requires the
 * same stream, so pause cannot stop the tracks, and the browser's recording
 * indicator stays lit. That is consumer-visible and documented rather than
 * discovered — see the note on {@link Recorder.pause}.
 */
export type RecorderPhase = "idle" | "recording" | "paused" | "stopping" | "failed";

/**
 * What a capture UI needs to paint, and nothing more.
 *
 * Phase 5 draws an elapsed-time readout and a level meter; those are the two values that change
 * many times a second, so they are pushed rather than polled.
 */
export interface RecorderState {
  readonly phase: RecorderPhase;
  /** Milliseconds since `start()`. Zero whenever idle; frozen while paused or failed. */
  readonly elapsedMs: number;
  /**
   * Normalized input level in `[0, 1]` — RMS of the most recent analyser frame.
   * Zero whenever idle, paused, or failed.
   */
  readonly level: number;
  /**
   * The capture failure that ended this recording, if any. Set the moment
   * `MediaRecorder` raises `error` mid-capture — not held back until `stop()` —
   * so a host can render *why* the capture died instead of just watching the
   * phase change to `failed`. Cleared on teardown, so a fresh `start()` begins
   * with no inherited failure.
   */
  readonly error: RecorderError | undefined;
}

/** Drops a {@link Recorder.subscribe} listener. Safe to call more than once. */
export type Unsubscribe = () => void;

/** The metadata record plus the bytes it describes. */
export interface Capture<C = EmptyContext> {
  readonly recording: Omit<Recording, "ctx"> & { ctx: C };
  readonly audio: Blob;
}

/** The honest shape of "this host has no context to attach" — an empty object, not `undefined`. */
export type EmptyContext = Record<string, never>;

export interface RecorderOptions<C = EmptyContext> {
  /**
   * Host association copied onto every `Recording` this recorder produces (see `recording.ts`).
   * Defaults to `{}` so the key always exists — "no context" stays distinguishable from "forgot".
   */
  readonly ctx?: C;
  /** Container preference list. Defaults to {@link DEFAULT_MIME_TYPE_PREFERENCES}. */
  readonly mimeTypes?: readonly string[];
  /** How often {@link Recorder.subscribe} listeners are notified while recording, in ms. */
  readonly tickMs?: number;
  /** Constraints for the audio track. `true` takes the browser default device. */
  readonly audio?: boolean | MediaTrackConstraints;
  /** Recording id factory. Defaults to `crypto.randomUUID()`. */
  readonly createId?: () => string;
  /**
   * Seam for the microphone. Defaults to `navigator.mediaDevices.getUserMedia`. Injectable so the
   * failure paths (denied permission, no device) can be tested for real without a browser that
   * has neither.
   */
  readonly getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  /** Seam for the recorder itself, for the same reason. */
  readonly createRecorder?: (stream: MediaStream, options: MediaRecorderOptions) => MediaRecorder;
}

/** Everything that exists only for the duration of one capture. */
interface Session {
  readonly stream: MediaStream;
  readonly recorder: MediaRecorder;
  readonly chunks: Blob[];
  readonly audioContext: AudioContext | undefined;
  readonly analyser: AnalyserNode | undefined;
  readonly samples: Uint8Array<ArrayBuffer> | undefined;
  readonly ticker: ReturnType<typeof setInterval>;
}

/**
 * Maps a `getUserMedia` rejection onto a {@link RecorderErrorCode}.
 *
 * The names come from the Media Capture spec; a browser that invents its own falls through to
 * `capture-failed` rather than being mislabeled.
 */
type GetUserMediaErrorCode = "permission-denied" | "no-input-device" | "capture-failed";

const classifyGetUserMediaError = (error: unknown): GetUserMediaErrorCode => {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "permission-denied";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "no-input-device";
  return "capture-failed";
};

const GET_USER_MEDIA_MESSAGES: Record<GetUserMediaErrorCode, string> = {
  "permission-denied":
    "Microphone access was denied. The user (or a permissions policy) must allow it before recording can start.",
  "no-input-device":
    "No microphone was found. Connect an input device, or pass `audio` constraints matching a device that exists.",
  "capture-failed": "The microphone could not be opened.",
};

/**
 * Captures one dictation at a time.
 *
 * ```ts
 * const recorder = new Recorder({ ctx: { jobId } });
 * const stopWatching = recorder.subscribe(({ elapsedMs, level }) => paint(elapsedMs, level));
 * await recorder.start();
 * const { recording, audio } = await recorder.stop(); // mic is released here
 * ```
 *
 * Reusable: after `stop()` resolves the instance is idle and can `start()` again, producing a new
 * id each time.
 */
export class Recorder<C = EmptyContext> {
  readonly #ctx: C;
  readonly #mimeTypes: readonly string[];
  readonly #tickMs: number;
  readonly #audio: boolean | MediaTrackConstraints;
  readonly #createId: () => string;
  readonly #getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  readonly #createRecorder: (stream: MediaStream, options: MediaRecorderOptions) => MediaRecorder;

  readonly #listeners = new Set<(state: RecorderState) => void>();
  #phase: RecorderPhase = "idle";
  #level = 0;
  #session: Session | undefined;
  #failure: RecorderError | undefined;
  /** Recorded duration banked by previous run-segments, excluding pauses. */
  #accumulatedMs = 0;
  /** `performance.now()` when the current run-segment began (start, or resume). */
  #resumedAt = 0;

  constructor(options: RecorderOptions<C> = {}) {
    this.#ctx = options.ctx ?? ({} as C);
    this.#mimeTypes = options.mimeTypes ?? DEFAULT_MIME_TYPE_PREFERENCES;
    this.#tickMs = options.tickMs ?? 100;
    this.#audio = options.audio ?? true;
    this.#createId = options.createId ?? (() => crypto.randomUUID());
    this.#getUserMedia =
      options.getUserMedia ?? ((constraints) => navigator.mediaDevices.getUserMedia(constraints));
    this.#createRecorder =
      options.createRecorder ??
      ((stream, recorderOptions) => new MediaRecorder(stream, recorderOptions));
  }

  get phase(): RecorderPhase {
    return this.#phase;
  }

  /**
   * Milliseconds of **recorded** audio; zero when idle.
   *
   * Sums banked segments with the live one, so a paused span is not counted. A
   * naive `now - startedAt` would keep running through a pause and hand a wrong
   * `durationMs` to every `Recording` that was ever paused.
   */
  get elapsedMs(): number {
    if (this.#session === undefined) return 0;
    if (this.#phase === "paused" || this.#phase === "failed")
      return Math.round(this.#accumulatedMs);
    return Math.round(this.#accumulatedMs + (performance.now() - this.#resumedAt));
  }

  /** Most recent normalized input level in `[0, 1]`; zero when idle. */
  get level(): number {
    return this.#level;
  }

  get state(): RecorderState {
    return {
      phase: this.#phase,
      elapsedMs: this.elapsedMs,
      level: this.#level,
      error: this.#failure,
    };
  }

  /**
   * Observes {@link RecorderState}.
   *
   * The listener is called **immediately** with the current state, then on every tick while
   * recording, and once more on each phase change — so a UI never has to poll and never renders a
   * blank frame before the first tick. Returns the unsubscribe handle; the recorder holds no
   * strong opinion about how many listeners there are.
   */
  subscribe(listener: (state: RecorderState) => void): Unsubscribe {
    this.#listeners.add(listener);
    listener(this.state);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Opens the microphone and starts recording.
   *
   * @throws {RecorderError} `already-recording`, `permission-denied`, `no-input-device`,
   * `unsupported-mime-type` or `capture-failed`. On every failure the stream is released and the
   * recorder is left idle, so a retry starts from a clean state.
   */
  async start(): Promise<void> {
    if (this.#phase !== "idle") {
      throw new RecorderError(
        "already-recording",
        "This Recorder is already capturing. Call stop() before starting again, or use a second Recorder.",
      );
    }

    // Negotiate before touching the microphone: an unsupported-container failure should not light
    // the recording indicator on the way to throwing.
    const mimeType = negotiateMimeType(this.#mimeTypes);
    const stream = await this.#openMicrophone();

    try {
      this.#session = this.#beginSession(stream, mimeType);
    } catch (error) {
      releaseStream(stream);
      throw new RecorderError("capture-failed", "The MediaRecorder could not be started.", {
        cause: error,
      });
    }

    this.#failure = undefined;
    this.#accumulatedMs = 0;
    this.#resumedAt = performance.now();
    this.#phase = "recording";
    this.#emit();
  }

  /**
   * Suspends recording without ending it.
   *
   * **The microphone stays open.** `MediaRecorder.resume()` must be handed the
   * same stream, so the tracks cannot be stopped here — which means the browser's
   * recording indicator stays lit while paused. In a field tool that is worth
   * saying out loud: a user who pauses may reasonably believe the mic is off. Call
   * {@link stop} to actually release it.
   *
   * `level` reads zero while paused, and `elapsedMs` stops advancing.
   *
   * @throws {RecorderError} `not-recording` if nothing is capturing.
   */
  pause(): void {
    const session = this.#session;
    if (session === undefined || this.#phase !== "recording") {
      throw new RecorderError(
        "not-recording",
        "This Recorder is not capturing, so there is nothing to pause. Call start() first.",
      );
    }
    session.recorder.pause();
    this.#accumulatedMs += performance.now() - this.#resumedAt;
    // A paused analyser still reads the live stream, so a meter driven by it would
    // bounce while nothing is being recorded — which reads as broken.
    this.#level = 0;
    this.#phase = "paused";
    this.#emit();
  }

  /**
   * Resumes a paused capture on the same stream and the same `Recording`.
   *
   * @throws {RecorderError} `already-recording` if capture is already running,
   * `not-recording` if there is nothing paused.
   */
  resume(): void {
    if (this.#phase === "recording") {
      throw new RecorderError(
        "already-recording",
        "This Recorder is already capturing. resume() is only for a paused capture.",
      );
    }
    const session = this.#session;
    if (session === undefined || this.#phase !== "paused") {
      throw new RecorderError(
        "not-recording",
        "This Recorder has nothing paused to resume. Call start() first.",
      );
    }
    session.recorder.resume();
    this.#resumedAt = performance.now();
    this.#phase = "recording";
    this.#emit();
  }

  /**
   * Stops recording, releases the microphone, and returns the metadata plus the bytes.
   *
   * The returned `recording.mimeType` is what the live `MediaRecorder` reported, which is not
   * always what was requested — that is the whole point of reading it back.
   *
   * @throws {RecorderError} `not-recording` if nothing is in flight, `capture-failed` if the
   * browser raised an error mid-capture (the recorder is `failed` by then, and `stop()` rethrows
   * the same failure that the observable state already carries).
   */
  async stop(): Promise<Capture<C>> {
    const session = this.#session;
    if (
      session === undefined ||
      (this.#phase !== "recording" && this.#phase !== "paused" && this.#phase !== "failed")
    ) {
      throw new RecorderError(
        "not-recording",
        "This Recorder is not capturing. Call start() before stop().",
      );
    }

    const durationMs = this.elapsedMs;
    // `MediaRecorder.mimeType` is only meaningful once it is live, and the container must be read
    // before teardown.
    const mimeType = session.recorder.mimeType || negotiateMimeType(this.#mimeTypes);
    this.#phase = "stopping";
    this.#emit();

    try {
      await stopRecorder(session.recorder);
      if (this.#failure !== undefined) throw this.#failure;
      const audio = new Blob(session.chunks, { type: mimeType });
      const recording = baseRecordingSchema.parse({
        id: this.#createId(),
        capturedAt: new Date().toISOString(),
        durationMs,
        mimeType,
        ctx: this.#ctx,
      });

      return { recording: { ...recording, ctx: this.#ctx }, audio };
    } finally {
      this.#teardown(session);
    }
  }

  async #openMicrophone(): Promise<MediaStream> {
    try {
      return await this.#getUserMedia({ audio: this.#audio });
    } catch (error) {
      const code = classifyGetUserMediaError(error);
      throw new RecorderError(code, GET_USER_MEDIA_MESSAGES[code], { cause: error });
    }
  }

  /** Wires the recorder, the level analyser and the tick timer for one capture. */
  #beginSession(stream: MediaStream, mimeType: string): Session {
    const recorder = this.#createRecorder(stream, { mimeType });
    const chunks: Blob[] = [];

    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    });
    recorder.addEventListener("error", (event) => {
      // Bank the elapsed segment so elapsedMs freezes here, not at the next
      // tick. pause() already banked it, so only top up from a recording phase.
      if (this.#phase === "recording") {
        this.#accumulatedMs += performance.now() - this.#resumedAt;
      }
      this.#failure = new RecorderError("capture-failed", "Recording failed mid-capture.", {
        cause: event,
      });
      // Surface the failure the moment it happens: move to a phase that is
      // honestly not "recording", zero the level (the analyser is still tapping
      // a live stream), and push so subscribers see it. Without this the UI
      // keeps showing a live capture while the contractor dictates into a dead
      // recorder for fifteen minutes — the failure only surfaces at stop().
      this.#level = 0;
      this.#phase = "failed";
      this.#emit();
    });
    recorder.start();

    const meter = createLevelMeter(stream);
    const session: Session = {
      stream,
      recorder,
      chunks,
      ...meter,
      ticker: setInterval(() => this.#tick(), this.#tickMs),
    };
    return session;
  }

  /** One sample of the input level, then a push to every listener. */
  #tick(): void {
    if (this.#phase === "paused" || this.#phase === "failed") return;
    const session = this.#session;
    if (session?.analyser === undefined || session.samples === undefined) return;
    session.analyser.getByteTimeDomainData(session.samples);
    this.#level = rootMeanSquare(session.samples);
    this.#emit();
  }

  #teardown(session: Session): void {
    clearInterval(session.ticker);
    releaseStream(session.stream);
    void session.audioContext?.close().catch(() => undefined);
    this.#session = undefined;
    this.#level = 0;
    this.#accumulatedMs = 0;
    this.#resumedAt = 0;
    this.#failure = undefined;
    this.#phase = "idle";
    this.#emit();
  }

  #emit(): void {
    const state = this.state;
    for (const listener of this.#listeners) listener(state);
  }
}

/**
 * Ends every track on the stream.
 *
 * `MediaRecorder.stop()` does **not** do this: it stops recording but leaves the tracks live, so
 * the microphone stays open and the browser keeps showing "recording". Stopping the tracks is the
 * only thing that turns the indicator off.
 */
const releaseStream = (stream: MediaStream): void => {
  for (const track of stream.getTracks()) track.stop();
};

/** Resolves once the recorder has flushed its final `dataavailable` and fired `stop`. */
const stopRecorder = (recorder: MediaRecorder): Promise<void> =>
  new Promise<void>((resolve) => {
    if (recorder.state === "inactive") {
      resolve();
      return;
    }
    recorder.addEventListener("stop", () => resolve(), { once: true });
    recorder.stop();
  });

/**
 * An analyser tapped off the live stream, for the level meter.
 *
 * Best-effort by design: the level is a UI affordance, so a browser that refuses to start an
 * `AudioContext` (autoplay policy, exhausted contexts) must degrade to a flat zero rather than
 * fail the capture that the user actually cares about.
 */
const createLevelMeter = (
  stream: MediaStream,
): Pick<Session, "audioContext" | "analyser" | "samples"> => {
  try {
    const audioContext = new AudioContext();
    void audioContext.resume().catch(() => undefined);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    audioContext.createMediaStreamSource(stream).connect(analyser);
    return { audioContext, analyser, samples: new Uint8Array(analyser.fftSize) };
  } catch {
    return { audioContext: undefined, analyser: undefined, samples: undefined };
  }
};

/**
 * RMS of one 8-bit time-domain frame, normalized to `[0, 1]`.
 *
 * Byte samples are unsigned with silence at 128, so each is re-centered before squaring. RMS
 * rather than peak: a meter driven by peaks flickers on every transient and reads as broken.
 */
const rootMeanSquare = (samples: Uint8Array): number => {
  let sum = 0;
  for (const sample of samples) {
    const centered = (sample - 128) / 128;
    sum += centered * centered;
  }
  return Math.min(1, Math.sqrt(sum / samples.length));
};
