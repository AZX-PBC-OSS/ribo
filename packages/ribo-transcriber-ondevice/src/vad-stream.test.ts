import { describe, expect, test } from "vitest";

import {
  StreamingVad,
  VAD_FRAME_SIZE,
  type ProbabilityDetector,
  type Utterance,
} from "./vad-stream.js";

/**
 * The frame loop, proved with no model, no worker and no browser — which is the reason it was
 * written behind a {@link ProbabilityDetector} seam. A fake detector returns deterministic
 * probabilities, and the frame loop's state-carrying, FIFO padding, and silence-close logic are
 * all exercised here.
 *
 * Three tests guard properties that are unusually easy to write so they pass against a WRONG
 * implementation, and each is built to rule that out explicitly: the state-carrying (the bug is
 * silent — speech still broadly detects on clean audio), the pre-speech FIFO (without it the
 * first transcribed frame is the detection frame and the consonant is gone), and the
 * silence-close threshold (a silence shorter than the threshold must not split an utterance).
 *
 * **These tests pin `minSilenceMs: 400` rather than using the production default.** Their frame
 * sequences are literal, with silence runs sized to sit either side of the close boundary, so they
 * are coupled to whatever threshold they run against. The production value is a product decision
 * that gets tuned against real dictation — it moved from 400 to 800 the first time anyone listened
 * to the output — and a tuning change should not turn three passing behaviour tests red.
 */

/** One frame's worth of samples, each set to `index` so the utterance's origin is inspectable. */
function makeFrame(index: number): Float32Array {
  const frame = new Float32Array(VAD_FRAME_SIZE);
  frame.fill(index);
  return frame;
}

/** Feed a sequence of frames sequentially, collecting every emitted utterance. */
async function feedAll(vad: StreamingVad, frames: Float32Array[]): Promise<Utterance[]> {
  const all: Utterance[] = [];
  for (const frame of frames) {
    const utterances = await vad.feed(frame);
    all.push(...utterances);
  }
  return all;
}

// ── Test A: the returned state is carried into the next frame ──────────────
//
// The trap (from the design): feeding the initial zero state every time still broadly detects
// speech on clean audio, so a test that only checks "speech was detected" passes against the bug.
// The bug is silent and shows up as clipped onsets in noise.
//
// The spike measured that carrying state changes 312 of 313 frames, with a maximum probability
// difference of 0.29 — larger than the 0.3/0.1 hysteresis gap. So a wrong state genuinely flips
// hysteresis decisions, and we assert on BEHAVIOUR (different segmentation), not merely on
// tensor identity.
//
// The fake detector below accumulates a counter in state[0]. With carried state, the probability
// ramps up (0.15, 0.9, 0.95, …) and crosses the 0.3 enter threshold on the second speech frame.
// With a fresh zero state every call (the bug), probability stays at 0.15 and never crosses 0.3
// — no speech is detected, no utterance is emitted. The test asserts an utterance IS emitted,
// which fails against the bug.

/**
 * A detector whose probability depends on whether the recurrent state was carried forward.
 *
 * During the speech phase (frames 5–20): with carried state, `state[0]` holds the previous call's
 * index, so `probability = state[0] * 0.15` ramps up and crosses 0.3. With a zero state (the bug),
 * probability is always 0.15 — below the enter threshold.
 *
 * During silence (frames 0–4 and 21+): probability is 0, and the state is reset to zeros —
 * mimicking Silero's behavior on silence.
 */
function makeStateAccumulatingDetector(): ProbabilityDetector & {
  readonly statesReceived: Float32Array[];
} {
  let callIdx = 0;
  const statesReceived: Float32Array[] = [];
  return {
    initialState: new Float32Array(128),
    statesReceived,
    async detect(
      frame: Float32Array,
      state: Float32Array,
    ): Promise<{ readonly probability: number; readonly state: Float32Array }> {
      statesReceived.push(new Float32Array(state));
      const idx = callIdx++;

      // Silence phases: probability 0, state reset.
      if (idx < 5 || idx >= 21) {
        return { probability: 0, state: new Float32Array(128) };
      }

      // Speech phase: probability depends on whether state was carried.
      // With carried state: state[0] = previous call's (idx), so prob = idx * 0.15 — ramps up.
      // With zero state (the bug): state[0] = 0, so prob = 0.15 — never crosses 0.3.
      const carried = (state[0] ?? 0) > 0;
      const probability = carried ? Math.min(0.95, (state[0] ?? 0) * 0.15) : 0.15;
      const newState = new Float32Array(128);
      newState[0] = idx + 1;
      return { probability, state: newState };
    },
  };
}

describe("StreamingVad — Test A: the returned state is carried into the next frame", () => {
  test("an utterance is emitted — speech is detected only when state is carried", async () => {
    const detector = makeStateAccumulatingDetector();
    const vad = new StreamingVad(detector, {
      minSilenceMs: 400,
      preSpeechPadMs: 80,
      minUtteranceSeconds: 0,
    });

    // 5 silence + 16 speech + 13 silence (13 × 32 ms = 416 ms > 400 ms, closes the utterance).
    const frames = Array.from({ length: 34 }, (_, i) => makeFrame(i));
    const utterances = await feedAll(vad, frames);

    // With carried state, speech is detected at frame 6 (state[0]=6 from frame 5, prob=0.9 ≥ 0.3).
    // Without carried state, probability stays at 0.15 and NO utterance is ever emitted.
    expect(utterances.length).toBeGreaterThan(0);

    // The utterance contains the detection frame (frame 6) — proof that speech was detected at
    // the point where carried state pushed probability above the enter threshold.
    const samples = utterances[0]!.samples;
    const hasFrame6 = Array.from(samples).some((s) => s === 6);
    expect(hasFrame6).toBe(true);
  });

  test("the state fed to call N+1 is the one returned by call N (direct check)", async () => {
    const detector = makeStateAccumulatingDetector();
    const vad = new StreamingVad(detector, {
      minSilenceMs: 400,
      preSpeechPadMs: 80,
      minUtteranceSeconds: 0,
    });

    const frames = Array.from({ length: 10 }, (_, i) => makeFrame(i));
    await feedAll(vad, frames);

    // Call 5 (first speech frame) returns newState[0] = 6. Call 6 should receive that state.
    // If the implementation feeds the initial zero state every time, statesReceived[6][0] is 0.
    const stateFedToCall6 = detector.statesReceived[6]!;
    expect(stateFedToCall6[0]).toBe(6);
  });
});

// ── Test B: a region opening includes the pre-speech FIFO ──────────────────
//
// Without the FIFO, the first frame transcribed is the one that *detected* speech, and the
// consonant before it is gone. The test fills each frame with its index so the utterance's
// origin is inspectable: the emitted buffer must start at a frame BEFORE the detection frame.

/**
 * A detector with a fixed probability pattern: silence for 5 frames, speech for 16, silence for
 * 13 (enough to close). State is threaded but does not affect probabilities — this test is about
 * the FIFO, not the state-carrying.
 */
function makeFixedPatternDetector(probabilities: readonly number[]): ProbabilityDetector {
  let callIdx = 0;
  return {
    initialState: new Float32Array(128),
    async detect(
      _frame: Float32Array,
      state: Float32Array,
    ): Promise<{ readonly probability: number; readonly state: Float32Array }> {
      const idx = callIdx++;
      const probability = probabilities[idx] ?? 0;
      const newState = new Float32Array(state);
      if (newState.length > 0) newState[0] = idx + 1;
      return { probability, state: newState };
    },
  };
}

describe("StreamingVad — Test B: a region opening includes the pre-speech FIFO", () => {
  test("the emitted buffer starts earlier than the detection frame", async () => {
    // Frame 5 is the detection frame (probability 0.5 ≥ 0.3). Frames 0–4 are silence (go into
    // the FIFO). The FIFO keeps the last ~3 frames (ceil(80/32) = 3), so the utterance should
    // start with frames 2, 3, 4 — BEFORE frame 5.
    const probabilities = [
      0,
      0,
      0,
      0,
      0, // silence → FIFO
      0.5,
      0.5,
      0.5,
      0.5,
      0.5,
      0.5,
      0.5,
      0.5,
      0.5,
      0.5,
      0.5,
      0.5,
      0.5,
      0.5,
      0.5,
      0.5, // speech
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0, // silence → close (13 frames = 416 ms)
    ];
    const detector = makeFixedPatternDetector(probabilities);
    const vad = new StreamingVad(detector, {
      minSilenceMs: 400,
      preSpeechPadMs: 80,
      minUtteranceSeconds: 0,
    });

    const frames = Array.from({ length: probabilities.length }, (_, i) => makeFrame(i));
    const utterances = await feedAll(vad, frames);

    expect(utterances.length).toBe(1);

    // The first sample of the utterance encodes the first frame's index. With the FIFO, that is
    // frame 2 (or earlier) — before the detection frame 5. Without the FIFO, it would be 5.
    const firstSample = utterances[0]!.samples[0]!;
    expect(firstSample).toBeLessThan(5);

    // The FIFO frames (2, 3, 4) are present at the start of the utterance — not just the
    // detection frame. This is the "consonant before the detection frame" the FIFO exists to
    // preserve.
    expect(utterances[0]!.samples[0]!).toBe(2);
    expect(utterances[0]!.samples[VAD_FRAME_SIZE]!).toBe(3);
    expect(utterances[0]!.samples[VAD_FRAME_SIZE * 2]!).toBe(4);
    expect(utterances[0]!.samples[VAD_FRAME_SIZE * 3]!).toBe(5);
  });
});

// ── Test C: a silence shorter than 400 ms does not split an utterance ──────
//
// 400 ms / 32 ms = 12.5 → 13 frames of silence to close. A 5-frame silence (160 ms) must NOT
// close. One utterance out, not two.

describe("StreamingVad — Test C: a silence shorter than 400 ms does not split", () => {
  test("one utterance out, not two", async () => {
    // Speech, then a 5-frame silence (160 ms < 400 ms — must not close), then speech again,
    // then a 15-frame silence (480 ms > 400 ms — closes).
    const probabilities = [
      0,
      0,
      0,
      0,
      0, // silence → FIFO
      0.5,
      0.5,
      0.5,
      0.5,
      0.5,
      0.5,
      0.5,
      0.5,
      0.5,
      0.5,
      0.5, // speech (frames 5–15, 11 frames)
      0,
      0,
      0,
      0,
      0, // short silence (frames 16–20, 5 frames = 160 ms < 400 ms)
      0.5,
      0.5,
      0.5,
      0.5,
      0.5,
      0.5,
      0.5,
      0.5,
      0.5,
      0.5, // speech resumes (frames 21–30, 10 frames)
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0, // long silence (15 frames = 480 ms > 400 ms → close)
    ];
    const detector = makeFixedPatternDetector(probabilities);
    const vad = new StreamingVad(detector, {
      minSilenceMs: 400,
      preSpeechPadMs: 80,
      minUtteranceSeconds: 0,
    });

    const frames = Array.from({ length: probabilities.length }, (_, i) => makeFrame(i));
    const utterances = await feedAll(vad, frames);

    // The 5-frame silence does not close — the silence counter resets when speech resumes at
    // frame 21. The utterance closes only after the 15-frame silence. One utterance, not two.
    expect(utterances.length).toBe(1);
  });
});

// ── Short utterances accumulate instead of emitting ──────────────────────────────────────────────
//
// The VAD finds speech boundaries; the ASR needs enough audio. Measured on a real dictation with
// deliberate short pauses: utterances of 1.44–2.56 s came back as fragments or, twice, as EMPTY TEXT
// that the worker then silently discarded — while a 8.96 s utterance in the same recording
// transcribed cleanly. So a close below `minUtteranceSeconds` holds its buffer and the next region
// appends to it.
//
// The trap this test avoids: asserting only "the short close emits nothing" passes against an
// implementation that simply THROWS the short buffer away, which loses the speech instead of
// deferring it — the exact bug being fixed, in a new place. The assertion that matters is that the
// held audio appears in the eventual emission.

test("a short utterance is held and merged into the next, not emitted and not lost", async () => {
  // Two speech bursts of 10 frames (~0.32 s each) separated by a closing silence, then a long
  // silence. Neither burst alone reaches the 1-second minimum used here; together they do.
  const speech = 0.9;
  const quiet = 0.0;
  const pattern = [
    ...Array<number>(10).fill(speech), // burst 1
    ...Array<number>(13).fill(quiet), // closes (13 × 32 ms > 400 ms)
    ...Array<number>(25).fill(speech), // burst 2 — together the buffer passes 1 s
    ...Array<number>(13).fill(quiet), // closes again
  ];
  const vad = new StreamingVad(makeFixedPatternDetector(pattern), {
    minSilenceMs: 400,
    preSpeechPadMs: 80,
    minUtteranceSeconds: 1,
  });

  const emitted: Float32Array[] = [];
  for (let i = 0; i < pattern.length; i++) {
    for (const u of await vad.feed(makeFrame(i))) emitted.push(u.samples);
  }

  // One emission, not two: the first close was held back.
  expect(emitted).toHaveLength(1);

  // **The held audio is in it.** Frame 0 belongs to the first burst; if the short close had
  // discarded its buffer rather than deferring it, that speech would be gone and this fails.
  const samples = Array.from(emitted[0]!);
  expect(samples).toContain(0);
  // And the second burst is there too — this is a merge, not a replacement.
  expect(samples).toContain(23);
});
