/**
 * @file Streaming voice-activity detection — the live frame loop.
 *
 * Where {@link ./segmentation.ts} runs pyannote over the whole recording after `stop()`, this
 * module runs Silero VAD one 512-sample frame at a time **during** recording, carrying the
 * model's recurrent state tensor forward. Revision 7 demotes the VAD from a filter to a
 * trigger: it decides **when** to transcribe and where a commit boundary falls, never **what**
 * gets transcribed. Every frame is appended to a contiguous region buffer; the probability
 * drives only timing — a pause triggers a refresh, a long-enough pause or the region cap
 * triggers a commit.
 *
 * **This is a pure, testable unit.** It takes frames in and reports refresh/commit events out.
 * The model is not the thing under test — a {@link ProbabilityDetector} seam lets the frame-loop
 * logic run in a node unit test against a fake probability source, while the real Silero detector
 * (`createSileroDetector`) is exercised only by a manual browser test that downloads the model.
 *
 * ## The frame loop
 *
 * Per 512-sample frame (32 ms at 16 kHz), in order:
 *
 * 1. **Append the frame to the region buffer, unconditionally.** Every frame, speech or not,
 *    contiguous and in order. No classification stands between the microphone and the model,
 *    so no word can be lost before transcription. At 16 kHz float32 the buffer costs 64 KB/s —
 *    under 2 MB for a 30-second region.
 * 2. Run the detector, passing the previous state; keep the state it returns and feed it into the
 *    next call. **This is the entire streaming-state problem, solved by the model rather than by
 *    us** — Silero hands back its own recurrent state, so there is nothing to reconstruct.
 * 3. Hysteresis on the returned probability: enter speech at 0.3, leave below 0.1. The result
 *    drives _timing only_ — it selects refresh and commit points and never filters audio.
 * 4. On a pause (silence past the refresh threshold), report a **refresh** — the caller
 *    re-transcribes the region. The buffer does not advance.
 * 5. On a long-enough pause (past the commit threshold) — but only once the region has reached
 *    the minimum region duration — or when the region reaches its cap, report a **commit** —
 *    the text becomes permanent and the buffer advances past the committed audio. Below the
 *    minimum, a qualifying pause triggers a refresh instead and the region keeps growing.
 *    Because the boundary is a position in the audio rather than a position in the text, the
 *    advance is exact and needs no timestamps.
 * 6. On reaching the region cap without a pause, commit at the cap and carry the remainder
 *    forward.
 *
 * The 250 ms min-speech filter survives only as a guard against transcribing a region that
 * contains no speech at all; it no longer gates emission, and it never removes audio from a
 * region.
 */

import { STREAMING_VAD_MODEL_ID } from "./config.js";

// ── Adopted constants ────────────────────────────────────────────────────────
//
// The hysteresis thresholds and frame geometry come from the reference implementation
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

/**
 * Trailing silence that triggers a **refresh** — re-transcribe the region buffer.
 *
 * **The refresh cadence is an open question** (`docs/roadmap/design/live-transcription-design.md`
 * §Open questions). At a measured peak duty cycle of 0.093 the budget allows refreshing far more
 * often than once per pause; whether more frequent refreshing reads as _responsive_ or as
 * _flickering_ is a UI question no measurement here answers. This value is a placeholder until
 * that measurement exists, and is injectable through the constructor so tests can pin their own
 * threshold.
 */
export const VAD_REFRESH_SILENCE_MS = 400;

/**
 * Trailing silence that triggers a **commit** — the text becomes permanent and the buffer
 * advances.
 *
 * **800 ms, not the reference implementation's 400.** `moonshine-web` is built for voice *commands*,
 * where a short burst is the whole input and closing fast is the point. This is continuous dictation,
 * and at 400 ms every breath inside a sentence closed an utterance — so the model saw fragments
 * starting mid-clause, with nothing to disambiguate against, and guessed. Measured against a real
 * dictation: "see what it captures" came back as "Head captures", "sentence detection" as "sentence
 * section", "not capturing individual words" as "not capturing in the room". The batch pass, which
 * sees the whole recording, got all three right.
 *
 * The design predicted exactly this and named 500–700 ms as the conversational range; Task 2 adopted
 * the reference's value anyway, which is how it got measured rather than assumed. 800 ms sits just
 * past that range because a dictating auditor pauses to look at something, not to yield a turn.
 *
 * **The cost is latency, and it is the whole of the cost.** Text now appears ~0.8 s after you stop
 * speaking rather than ~0.4 s. Longer regions also carry more context into each call, so quality
 * improves twice over — but a threshold long enough to catch a whole paragraph would make the preview
 * useless as feedback, which is the other end of this trade.
 */
export const VAD_COMMIT_SILENCE_MS = 800;

/**
 * Region cap — commit and carry the remainder past this.
 *
 * **The cap is a quality parameter, not just a memory bound** (`docs/roadmap/design/live-transcription-design.md`
 * §Open questions). Longer regions give the model more context, at the cost of a tail that churns
 * for longer before it settles. 15 s and 30 s were both measured on the TTS fixture; neither has
 * been measured on the stuttering, pause-heavy delivery that motivated revision 7. This value is
 * a placeholder until that measurement exists.
 */
export const VAD_REGION_CAP_SECONDS = 30;

/**
 * Minimum region duration before a pause may commit.
 *
 * A pause — silence past {@link VAD_COMMIT_SILENCE_MS} — only commits once the region has reached
 * this duration. Below it, the pause triggers a refresh (the tail is re-transcribed and replaced)
 * and the region keeps growing. The cap still forces a commit regardless, and `drain` still
 * returns whatever remains at close.
 *
 * **Why this exists.** Real dictation is short phrases separated by pauses longer than 800 ms.
 * Without a minimum, every phrase committed immediately, regions stayed 2–5 seconds long, and the
 * model was handed short fragments with no context — precisely the failure revision 7 was written
 * to eliminate. The design's intent is long commit regions for accuracy, refreshed on every pause
 * for responsiveness. The refresh half worked; the commit half did not.
 *
 * **The commit boundary is the pause, not the minimum.** When a qualifying pause arrives and the
 * region is already past the minimum, the commit boundary is _that_ pause — the committed audio
 * is the whole region up to and including the pause's trailing silence, exactly as before. The
 * minimum is a gate on _when_ a pause may commit, not a trigger for committing at a fixed
 * duration. A region that reaches the minimum mid-speech with no pause for a long time afterwards
 * simply keeps growing — which is the design's intent (long regions for accuracy). The cap is the
 * only backstop if no qualifying pause ever arrives.
 *
 * **15 s is a placeholder pending measurement on real speech.** The design lists the region cap
 * and refresh cadence as open questions; this belongs with them. Injectable through the
 * constructor so tests pin their own.
 */
export const VAD_MIN_REGION_SECONDS = 15;

/**
 * Speech shorter than this is noise — a region with less speech is not worth transcribing.
 *
 * **Revision 7 changes this filter's role.** It was an emission gate that discarded regions;
 * now it is a guard that suppresses refreshes and pause-commits on regions containing no speech
 * at all, while never removing audio from the region buffer. A region that never accumulates
 * 250 ms of speech simply waits — the cap will eventually force a commit regardless.
 */
export const VAD_MIN_SPEECH_MS = 250;

/**
 * Padding added to each side of the speech span when trimming the transcription input.
 *
 * **Taken from the batch path deliberately** — `segmentation.ts`'s `DEFAULTS.padMs` uses the same
 * 200 ms so a consonant onset or a trailing fricative is not clipped at a speech boundary. The
 * batch path pads every VAD-cut region; the live path must do the same for the same reason, or
 * the two paths would clip different onsets and produce different text from the same audio.
 * Injectable through the constructor so tests pin their own.
 */
export const VAD_PAD_MS = 200;

/** One frame's duration in milliseconds (512 / 16000 × 1000). */
const FRAME_DURATION_MS = (VAD_FRAME_SIZE / VAD_SAMPLE_RATE) * 1000;

/** Minimum speech frames for a region to be worth transcribing — `ceil` so at least 250 ms. */
const MIN_SPEECH_FRAMES = Math.ceil(VAD_MIN_SPEECH_MS / FRAME_DURATION_MS);

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * The result of feeding one frame to {@link RegionVad}. Reports whether the caller should
 * re-transcribe the region (a pause occurred) and whether a commit boundary was reached (the
 * text becomes permanent and the buffer has advanced).
 *
 * `refresh` and `commit` are mutually exclusive on a single frame: a commit clears the buffer
 * and resets the silence counter, so a refresh cannot also be due. A cap-driven commit happens
 * before the detector runs, so the pause logic sees a fresh region and cannot fire. A pause-driven
 * commit requires the region to have reached the minimum duration; below that, the pause produces
 * a refresh (fired earlier at the refresh threshold) and the region keeps growing.
 */
export interface RegionFrameResult {
  /** A refresh is due: a pause occurred. Re-transcribe the region; the buffer has NOT advanced. */
  readonly refresh: boolean;
  /** A commit boundary was reached: a long-enough pause or the region cap. The buffer has advanced. */
  readonly commit: boolean;
  /**
   * The committed audio — the full region's samples, every frame from the last commit point to
   * this one. Non-null only when `commit` is true. The buffer advances past this exact audio;
   * the next region starts where this one ended. **This is not what gets transcribed** — see
   * {@link transcriptionSamples}.
   */
  readonly committedSamples: Float32Array | null;
  /**
   * The transcription input — the committed region **trimmed to its speech span** (first speech
   * frame through last, padded by {@link VAD_PAD_MS} on each side, clamped to the region bounds).
   * Null when the committed region contained no speech at all (the caller skips the transcription
   * call rather than sending noise to the model) or when no commit occurred on this frame.
   *
   * **Why the committed text boundary and the buffer advance are still exact when the transcribed
   * audio was trimmed.** The trimmed audio is a strict subset of the committed region — no speech
   * is excluded, only non-speech at the leading and trailing edges. The commit boundary is a
   * position in the audio (the pause or the cap), not a position in the text, so the buffer
   * advances past the whole region regardless of what is transcribed. The text corresponds to the
   * speech within that region, all of which is inside the trimmed span. The next region begins
   * where the committed region ended — no gap, no overlap — because the advance is driven by the
   * full region, not by the trimmed input. A reader who wonders "if we transcribed less than we
   * committed, is the boundary still exact?" can stop here: yes, because nothing that was trimmed
   * away was speech.
   */
  readonly transcriptionSamples: Float32Array | null;
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
 * {@link VAD_FRAME_SIZE} samples; the output is the unrolled region.
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
 * The region VAD — turns a flow of 512-sample frames into refresh and commit events over a
 * contiguous, unfiltered region buffer.
 *
 * Feed frames via {@link feed}; each call returns whether a refresh is due and whether a commit
 * boundary was reached. Every frame is appended to the region buffer unconditionally — speech or
 * silence, no frame is dropped. The current region's samples are available through {@link samples}
 * at any time; after a commit, `samples` returns the _new_ region (the buffer has advanced).
 *
 * `feed` serializes through an internal promise chain so the recurrent state is never raced —
 * two concurrent feeds would read and write the same state tensor. The fake detectors in tests
 * resolve instantly, so this is invisible there; against the real model it is the same
 * "one inference at a time" constraint the batch worker already lives under.
 *
 * `drain` returns and clears the current region — the close-time safety net. In the new
 * model this is not "rescuing discarded audio" (nothing is discarded); it is simply
 * returning the region that never saw a commit boundary.
 */
export class RegionVad {
  readonly #detector: ProbabilityDetector;

  // ── Recurrent state ──
  // The model's state tensor, threaded from one frame to the next. Starts at the detector's
  // initial state and is replaced with whatever `detect` returns after each frame.
  #state: Float32Array;

  // ── Hysteresis ──
  #inSpeech = false;
  // Consecutive silence frames while in speech — reaches `#commitSilenceFrames` to commit,
  // `#refreshSilenceFrames` to refresh.
  #silenceFrameCount = 0;
  // Speech frames (probability ≥ exit) in the current region — drives the 250 ms noise filter.
  #speechFrameCount = 0;

  // ── Speech span (for trimming the transcription input) ──
  // The first and last frame indices (into #regionFrames) that were classified as speech in the
  // current region. -1 means no speech has been seen yet. Used by #trimToSpeechSpan to cut the
  // leading and trailing non-speech before handing audio to the model — the same thing the batch
  // path does with planVadChunks, but driven by the per-frame decisions RegionVad already makes
  // rather than a second VAD pass.
  #firstSpeechFrame = -1;
  #lastSpeechFrame = -1;

  // ── The region buffer ──
  // Every frame fed, contiguous and in order. No frame is ever removed until a commit advances
  // past it.
  #regionFrames: Float32Array[] = [];

  // Serializes feed/drain calls so the recurrent state is never raced.
  #chain: Promise<unknown> = Promise.resolve();

  readonly #refreshSilenceFrames: number;
  readonly #commitSilenceFrames: number;
  readonly #regionCapFrames: number;
  readonly #minRegionFrames: number;
  readonly #padFrames: number;

  /**
   * `refreshSilenceMs`, `commitSilenceMs`, `regionCapSeconds`, `minRegionSeconds` and `padMs` are
   * injectable so a **test can pin its own thresholds**. The tests build literal probability
   * sequences whose silence runs have to cross the refresh or commit boundary; pinned to the
   * production constants, they broke the first time a threshold was tuned — tests failing while
   * still describing correct behaviour, which is noise between a reader and a real regression.
   * The thresholds are product decisions that will be tuned again; the frame loop's behaviour
   * is not.
   */
  constructor(
    detector: ProbabilityDetector,
    options: {
      refreshSilenceMs?: number;
      commitSilenceMs?: number;
      regionCapSeconds?: number;
      minRegionSeconds?: number;
      padMs?: number;
    } = {},
  ) {
    this.#detector = detector;
    this.#state = new Float32Array(detector.initialState);
    this.#refreshSilenceFrames = Math.ceil(
      (options.refreshSilenceMs ?? VAD_REFRESH_SILENCE_MS) / FRAME_DURATION_MS,
    );
    this.#commitSilenceFrames = Math.ceil(
      (options.commitSilenceMs ?? VAD_COMMIT_SILENCE_MS) / FRAME_DURATION_MS,
    );
    this.#regionCapFrames = Math.floor(
      ((options.regionCapSeconds ?? VAD_REGION_CAP_SECONDS) * VAD_SAMPLE_RATE) / VAD_FRAME_SIZE,
    );
    // `ceil` so the region must hold at least the named duration — conservative for quality
    // (the cap uses `floor` for the opposite reason: it is a maximum, and rounding down commits
    // slightly early, which is conservative for memory).
    this.#minRegionFrames = Math.ceil(
      ((options.minRegionSeconds ?? VAD_MIN_REGION_SECONDS) * VAD_SAMPLE_RATE) / VAD_FRAME_SIZE,
    );
    // `ceil` so we pad at least the named duration — clipping a consonant onset is the failure
    // this exists to prevent, and rounding down would give less padding than intended.
    this.#padFrames = Math.ceil((options.padMs ?? VAD_PAD_MS) / FRAME_DURATION_MS);
  }

  /**
   * Process one 512-sample frame. Returns whether a refresh is due and whether a commit boundary
   * was reached on this frame. Awaited sequentially: the next `feed` does not begin inference
   * until this one's state is settled.
   */
  feed(frame: Float32Array): Promise<RegionFrameResult> {
    const next = this.#chain.then(() => this.#processFrame(frame));
    // Swallow rejections on the chain only — the caller still sees them through `next`.
    this.#chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * The current region's samples — every frame from the last commit point to now, unfiltered.
   * After a commit, this is the _new_ region's samples (the buffer has advanced past the
   * committed audio).
   */
  get samples(): Float32Array {
    return concatenateFrames(this.#regionFrames);
  }

  /**
   * The current region trimmed to its speech span — first speech frame through last, padded by
   * `padMs` on each side, clamped to the region bounds. Returns `null` when the current region
   * contains no speech at all, so the caller can skip the transcription call rather than sending
   * noise to the model. **This is the refresh path's transcription input** — the region buffer
   * itself ({@link samples}) is unchanged; only what we hand the model is trimmed.
   *
   * The batch path does the same thing with `planVadChunks` in `segmentation.ts`: it cuts to
   * speech boundaries and pads by 200 ms. The live path cannot run a second VAD pass (Silero is
   * already running per frame), so it reuses the per-frame speech decisions {@link RegionVad}
   * already tracks — the first frame that entered speech through to the last — rather than
   * inventing a second detector.
   */
  speechSpanSamples(): Float32Array | null {
    return this.#trimToSpeechSpan(this.samples);
  }

  /**
   * Trim a region's samples to its speech span. The span is the first frame that entered speech
   * through the last frame that was still in speech, padded by `#padFrames` on each side and
   * clamped to `[0, samples.length]`. Internal pauses — silence between two speech segments —
   * are preserved; only leading and trailing non-speech is removed. Returns `null` when the
   * region contains no speech (`#firstSpeechFrame === -1`).
   *
   * `subarray`, not `slice`: a view over the samples already in memory — the caller does not
   * need an independent copy (the transcription call reads it once and does not retain it).
   */
  #trimToSpeechSpan(samples: Float32Array): Float32Array | null {
    if (this.#firstSpeechFrame === -1) return null;
    const frameCount = samples.length / VAD_FRAME_SIZE;
    const startFrame = Math.max(0, this.#firstSpeechFrame - this.#padFrames);
    const endFrame = Math.min(frameCount, this.#lastSpeechFrame + 1 + this.#padFrames);
    return samples.subarray(startFrame * VAD_FRAME_SIZE, endFrame * VAD_FRAME_SIZE);
  }

  /**
   * Return the current region's samples and reset the buffer. The close-time safety net —
   * the worker's `liveClose` handler drains whatever remains when the session closes, so
   * the last region is never lost. In the new model nothing is discarded, so this is simply
   * "return the region that never saw a commit boundary."
   *
   * Returns the **speech-span-trimmed** samples, or an empty `Float32Array` when the region
   * contained no speech — so a close on a noise-only region produces no transcription call
   * rather than sending noise to the model. The buffer is fully cleared either way.
   *
   * Serializes through the same chain as {@link feed} so a drain cannot race an in-flight feed
   * for the buffer state.
   */
  drain(): Promise<Float32Array> {
    const next = this.#chain.then(() => this.#drainBuffer());
    this.#chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * The frame loop itself. Separated from {@link feed} so the serialization wrapper is testable
   * as a plain method — the tests call `feed` directly against a fake detector.
   */
  async #processFrame(frame: Float32Array): Promise<RegionFrameResult> {
    let refresh = false;
    let committedSamples: Float32Array | null = null;
    let transcriptionSamples: Float32Array | null = null;

    // 1. Cap check: if the buffer is at the cap, commit before appending. The committed audio
    //    is exactly `#regionCapFrames` frames; the current frame starts the new region.
    //    The cap forces a commit regardless of the speech filter — it is a hard memory/quality
    //    bound, not a product decision about when text is worth keeping.
    if (this.#regionFrames.length >= this.#regionCapFrames) {
      committedSamples = concatenateFrames(this.#regionFrames);
      // Trim to the speech span BEFORE resetting the span indices — #trimToSpeechSpan reads
      // #firstSpeechFrame/#lastSpeechFrame, which are about to be cleared. Returns null when
      // the cap-committed region had no speech, so the worker skips the transcription call.
      transcriptionSamples = this.#trimToSpeechSpan(committedSamples);
      this.#regionFrames = [];
      this.#speechFrameCount = 0;
      this.#silenceFrameCount = 0;
      this.#inSpeech = false;
      this.#firstSpeechFrame = -1;
      this.#lastSpeechFrame = -1;
    }

    // 2. Append the frame to the region buffer, unconditionally. Every frame, speech or not.
    this.#regionFrames.push(frame);

    // 3. Run the detector, threading the recurrent state.
    const { probability, state: newState } = await this.#detector.detect(frame, this.#state);
    this.#state = newState;

    // 4. Hysteresis on the probability (timing only, never filters audio).
    if (!this.#inSpeech) {
      if (probability >= VAD_ENTER_THRESHOLD) {
        this.#inSpeech = true;
        this.#silenceFrameCount = 0;
        this.#speechFrameCount++;
        // Record the first speech frame in this region — the leading edge of the trim span.
        // #regionFrames.length - 1 is the frame just appended (step 2).
        const frameIdx = this.#regionFrames.length - 1;
        if (this.#firstSpeechFrame === -1) this.#firstSpeechFrame = frameIdx;
        this.#lastSpeechFrame = frameIdx;
      }
      // Not in speech: no pause to detect. The frame is already in the buffer.
      return { refresh, commit: committedSamples !== null, committedSamples, transcriptionSamples };
    }

    // ── In speech ──

    if (probability < VAD_EXIT_THRESHOLD) {
      this.#silenceFrameCount++;

      // 5. Commit check: a long-enough pause. The commit threshold is longer than the refresh
      //    threshold, so this is checked first — if reached, the buffer advances and the refresh
      //    never fires for this pause.
      if (this.#silenceFrameCount >= this.#commitSilenceFrames) {
        // The 250 ms filter guards against committing (and thus transcribing) a region with no
        // speech at all. The cap handles the all-silence case without this guard.
        if (this.#speechFrameCount >= MIN_SPEECH_FRAMES) {
          // The minimum-region-length gate: a pause may only commit once the region has reached
          // VAD_MIN_REGION_SECONDS. Below that, the pause is treated as a refresh opportunity
          // (the refresh already fired at the refresh threshold earlier in this silence run) and
          // the region keeps growing. This is the fix for the "every pause commits" bug: real
          // dictation is short phrases separated by >800 ms pauses, so without this gate every
          // phrase committed immediately and the model saw only fragments.
          //
          // The `>=` on the silence count means this check runs on every silence frame past the
          // commit threshold, not just the one that crossed it. That is correct: if the region is
          // still below the minimum when the commit threshold is reached, the silence continues
          // to accumulate in the buffer (every frame is appended unconditionally), and the commit
          // fires on the first frame where both conditions are met. If speech resumes before
          // that, the silence counter resets and the region carries the inter-phrase silence
          // forward — exactly the "region accumulates across pauses" behaviour the design wants.
          if (this.#regionFrames.length >= this.#minRegionFrames) {
            committedSamples = concatenateFrames(this.#regionFrames);
            // Trim to the speech span BEFORE resetting — see the cap commit above.
            transcriptionSamples = this.#trimToSpeechSpan(committedSamples);
            this.#regionFrames = [];
            this.#speechFrameCount = 0;
            this.#silenceFrameCount = 0;
            this.#inSpeech = false;
            this.#firstSpeechFrame = -1;
            this.#lastSpeechFrame = -1;
          }
        }
      } else if (this.#silenceFrameCount === this.#refreshSilenceFrames) {
        // 6. Refresh: a pause, but not long enough to commit. The buffer does NOT advance.
        //    `===` not `>=`: the refresh fires once per pause, on the frame that crosses the
        //    threshold. If the speech filter suppresses it (region has no speech), it does not
        //    retry on later frames — the region simply waits for more speech or the cap.
        if (this.#speechFrameCount >= MIN_SPEECH_FRAMES) {
          refresh = true;
        }
      }
    } else {
      // Still speech: reset the silence counter and count this frame toward the speech filter.
      this.#silenceFrameCount = 0;
      this.#speechFrameCount++;
      // Extend the trailing edge of the trim span to this frame.
      this.#lastSpeechFrame = this.#regionFrames.length - 1;
    }

    return { refresh, commit: committedSamples !== null, committedSamples, transcriptionSamples };
  }

  /**
   * The drain itself — synchronous because no detector call is needed, just buffer extraction.
   * Separated from {@link drain} so the serialization wrapper mirrors `feed`'s shape.
   */
  #drainBuffer(): Float32Array {
    const samples = concatenateFrames(this.#regionFrames);
    // Trim to the speech span BEFORE resetting the indices — a noise-only region returns empty,
    // so the worker skips the transcription call rather than sending noise to the model.
    const trimmed = this.#trimToSpeechSpan(samples);
    this.#regionFrames = [];
    this.#speechFrameCount = 0;
    this.#silenceFrameCount = 0;
    this.#inSpeech = false;
    this.#firstSpeechFrame = -1;
    this.#lastSpeechFrame = -1;
    return trimmed ?? new Float32Array(0);
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
