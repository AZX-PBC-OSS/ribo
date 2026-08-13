import { describe, expect, test } from "vitest";

import {
  RegionVad,
  VAD_FRAME_SIZE,
  type ProbabilityDetector,
  type RegionFrameResult,
} from "./vad-stream.js";

/**
 * The frame loop, proved with no model, no worker and no browser — which is the reason it was
 * written behind a {@link ProbabilityDetector} seam. A fake detector returns deterministic
 * probabilities, and the frame loop's state-carrying, region retention, refresh and commit logic
 * are all exercised here.
 *
 * **These tests pin their own thresholds through constructor options** (`refreshSilenceMs`,
 * `commitSilenceMs`, `regionCapSeconds`, `minRegionSeconds`) rather than using the production
 * defaults. Their frame sequences are literal, with silence runs sized to sit either side of the
 * refresh or commit boundary, so they are coupled to whatever thresholds they run against. The
 * production values are product decisions that will be tuned against real dictation, and a tuning
 * change should not turn passing behaviour tests red.
 */

/** One frame's worth of samples, each set to `index` so the region's origin is inspectable. */
function makeFrame(index: number): Float32Array {
  const frame = new Float32Array(VAD_FRAME_SIZE);
  frame.fill(index);
  return frame;
}

/** Feed a sequence of frames sequentially, collecting every frame result. */
async function feedAll(vad: RegionVad, frames: Float32Array[]): Promise<RegionFrameResult[]> {
  const results: RegionFrameResult[] = [];
  for (const frame of frames) {
    const result = await vad.feed(frame);
    results.push(result);
  }
  return results;
}

// ── Shared fake detectors ────────────────────────────────────────────────────

/**
 * A detector with a fixed probability pattern. State is threaded but does not affect
 * probabilities — this detector is for testing the region buffer and timing logic, not the
 * state-carrying.
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

// ── Test A: the returned state is carried into the next frame ──────────────
//
// The trap (from the design): feeding the initial zero state every time still broadly detects
// speech on clean audio, so a test that only checks "speech was detected" passes against the bug.
// The bug is silent and shows up as clipped onsets in noise.
//
// The spike measured that carrying state changes 312 of 313 frames, with a maximum probability
// difference of 0.29 — larger than the 0.3/0.1 hysteresis gap. So a wrong state genuinely flips
// hysteresis decisions, and we assert on BEHAVIOUR (whether a refresh fires), not merely on
// tensor identity.
//
// The fake detector below accumulates a counter in state[0]. With carried state, the probability
// ramps up (0.15, 0.9, 0.95, …) and crosses the 0.3 enter threshold on the second speech frame.
// With a fresh zero state every call (the bug), probability stays at 0.15 and never crosses 0.3
// — no speech is detected, no refresh fires on the closing pause. The test asserts a refresh IS
// reported, which fails against the bug.

describe("RegionVad — Test A: the returned state is carried into the next frame", () => {
  test("a refresh fires on the closing pause — speech is detected only when state is carried", async () => {
    const detector = makeStateAccumulatingDetector();
    const vad = new RegionVad(detector, {
      refreshSilenceMs: 200, // ceil(200/32) = 7 frames
      commitSilenceMs: 400, // ceil(400/32) = 13 frames
      regionCapSeconds: 30,
      minRegionSeconds: 0, // disable the minimum — this test is about state-carrying, not region length
    });

    // 5 silence + 16 speech + 10 silence (10 × 32 ms = 320 ms > 200 ms refresh, < 400 ms commit).
    // The 10-frame silence crosses the 7-frame refresh threshold but not the 13-frame commit.
    const frames = Array.from({ length: 31 }, (_, i) => makeFrame(i));
    const results = await feedAll(vad, frames);

    // With carried state, speech is detected at frame 6 (state[0]=6 from frame 5, prob=0.9 ≥ 0.3).
    // The closing pause's silence count reaches 7 at frame 27 (21 + 7 - 1 = 27), firing a refresh.
    // Without carried state, probability stays at 0.15 and NO speech is ever detected — no refresh.
    const anyRefresh = results.some((r) => r.refresh);
    expect(anyRefresh).toBe(true);
  });

  test("the state fed to call N+1 is the one returned by call N (direct check)", async () => {
    const detector = makeStateAccumulatingDetector();
    const vad = new RegionVad(detector, {
      refreshSilenceMs: 200,
      commitSilenceMs: 400,
      regionCapSeconds: 30,
      minRegionSeconds: 0,
    });

    const frames = Array.from({ length: 10 }, (_, i) => makeFrame(i));
    await feedAll(vad, frames);

    // Call 5 (first speech frame) returns newState[0] = 6. Call 6 should receive that state.
    // If the implementation feeds the initial zero state every time, statesReceived[6][0] is 0.
    const stateFedToCall6 = detector.statesReceived[6]!;
    expect(stateFedToCall6[0]).toBe(6);
  });
});

// ── Test 1: no audio is ever dropped ─────────────────────────────────────────
//
// The test this whole revision exists for. The old StreamingVad retained only frames it classified
// as speech; everything else was discarded before transcription. A speaker whose delivery dips
// below the exit threshold — hesitation, trailing off, thinking aloud — had those words dropped
// permanently. This test feeds a stuttering pattern (speech interspersed with low-probability
// frames that dip below exit) and asserts the region contains every frame, including the
// low-probability ones. Reinstating speech-only retention turns this red.

test("no audio is ever dropped — the region contains every frame including low-probability ones", async () => {
  // Stuttering delivery: speech frames interspersed with low-probability frames that dip below
  // the exit threshold (0.1). The 3-frame silence dips (96 ms) are well below both the refresh
  // threshold (200 ms = 7 frames) and the commit threshold (400 ms = 13 frames), so no commit
  // happens and the region holds everything. In the old model these silence frames would have
  // been discarded; in the new model they are in the buffer.
  const speech = 0.9;
  const quiet = 0.0;
  const pattern = [
    ...Array<number>(5).fill(speech),
    ...Array<number>(3).fill(quiet), // dip below exit
    ...Array<number>(5).fill(speech),
    ...Array<number>(3).fill(quiet), // dip below exit
    ...Array<number>(5).fill(speech),
    ...Array<number>(3).fill(quiet), // dip below exit
    ...Array<number>(5).fill(speech),
  ];

  const vad = new RegionVad(makeFixedPatternDetector(pattern), {
    refreshSilenceMs: 200,
    commitSilenceMs: 400,
    regionCapSeconds: 30,
    minRegionSeconds: 0, // disable the minimum — this test is about audio retention, not region length
  });

  const frames = Array.from({ length: pattern.length }, (_, i) => makeFrame(i));
  await feedAll(vad, frames);

  const samples = Array.from(vad.samples);

  // Every frame is in the region — including the low-probability ones. Each frame is filled with
  // its index, so checking for the index proves the frame's samples are present.
  for (let i = 0; i < pattern.length; i++) {
    expect(samples).toContain(i);
  }

  // The region's total sample count is exactly frames × VAD_FRAME_SIZE — no frame was dropped.
  expect(samples.length).toBe(pattern.length * VAD_FRAME_SIZE);
});

// ── Test 2: a refresh does not advance the buffer ────────────────────────────
//
// A refresh tells the caller to re-transcribe the region, but the buffer stays where it is. After
// a refresh point the region still holds the audio from before it — the next refresh sees the
// same accumulated audio plus whatever arrived in between.

test("a refresh does not advance the buffer — the region still holds audio from before it", async () => {
  const speech = 0.9;
  const quiet = 0.0;
  // 10 speech frames, then 8 silence frames (8 × 32 ms = 256 ms > 200 ms refresh, < 400 ms commit).
  // The 8-frame silence crosses the 7-frame refresh threshold but not the 13-frame commit.
  const pattern = [...Array<number>(10).fill(speech), ...Array<number>(8).fill(quiet)];

  const vad = new RegionVad(makeFixedPatternDetector(pattern), {
    refreshSilenceMs: 200, // ceil(200/32) = 7 frames
    commitSilenceMs: 400, // ceil(400/32) = 13 frames
    regionCapSeconds: 30,
    minRegionSeconds: 0, // disable the minimum — this test is about refresh, not region length
  });

  const frames = Array.from({ length: pattern.length }, (_, i) => makeFrame(i));
  const results = await feedAll(vad, frames);

  // A refresh was reported — the 8-frame silence crossed the 7-frame refresh threshold.
  const anyRefresh = results.some((r) => r.refresh);
  expect(anyRefresh).toBe(true);

  // No commit — the silence did not reach the 13-frame commit threshold.
  const anyCommit = results.some((r) => r.commit);
  expect(anyCommit).toBe(false);

  // The region still holds all 18 frames — the refresh did not advance the buffer.
  const samples = Array.from(vad.samples);
  expect(samples).toContain(0); // first speech frame
  expect(samples).toContain(9); // last speech frame
  expect(samples).toContain(17); // last silence frame
  expect(samples.length).toBe(pattern.length * VAD_FRAME_SIZE);
});

// ── Test 3: a commit advances the buffer past exactly the committed audio ────
//
// A commit makes the text permanent and advances the buffer. The next region starts where the
// last ended — no gap, no overlap. The committed audio is available in the frame result so the
// caller can transcribe it.

test("a commit advances the buffer past exactly the committed audio — no gap, no overlap", async () => {
  const speech = 0.9;
  const quiet = 0.0;
  // 10 speech frames, then 15 silence frames (15 × 32 ms = 480 ms > 400 ms commit).
  // ceil(400/32) = 13: the commit fires when the silence count reaches 13, on frame 22
  // (silence starts at frame 10; 10 + 13 - 1 = 22). The committed audio is frames 0–22.
  // After the commit, the buffer is cleared. Frames 23–24 are fed into the new region.
  const pattern = [...Array<number>(10).fill(speech), ...Array<number>(15).fill(quiet)];

  const vad = new RegionVad(makeFixedPatternDetector(pattern), {
    refreshSilenceMs: 200,
    commitSilenceMs: 400, // ceil(400/32) = 13 frames
    regionCapSeconds: 30,
    minRegionSeconds: 0, // disable the minimum — this test is about the commit boundary, not region length
  });

  const frames = Array.from({ length: pattern.length }, (_, i) => makeFrame(i));
  let committedSamples: Float32Array | null = null;
  let commitFrame = -1;
  for (let i = 0; i < frames.length; i++) {
    const result = await vad.feed(frames[i]!);
    if (result.commit) {
      committedSamples = result.committedSamples;
      commitFrame = i;
    }
  }

  expect(committedSamples).not.toBeNull();
  expect(commitFrame).toBe(22); // frame 10 + 13 - 1

  const committedArray = Array.from(committedSamples!);
  // The committed audio includes frames 0 through 22 (the commit frame).
  expect(committedArray).toContain(0);
  expect(committedArray).toContain(22);
  expect(committedArray).not.toContain(23);
  expect(committedSamples!.length).toBe(23 * VAD_FRAME_SIZE);

  // The new region starts where the committed audio ended — no gap, no overlap.
  const newRegionSamples = Array.from(vad.samples);
  // The new region contains frames 23–24 (fed after the commit), not frames 0–22.
  expect(newRegionSamples).toContain(23);
  expect(newRegionSamples).toContain(24);
  for (let i = 0; i <= commitFrame; i++) {
    expect(newRegionSamples).not.toContain(i);
  }
  expect(newRegionSamples.length).toBe(2 * VAD_FRAME_SIZE);
});

// ── Test 4: the region cap forces a commit ───────────────────────────────────
//
// When no qualifying pause arrives, the region cap is the only commit trigger. It forces a commit
// regardless of the speech filter — it is a hard memory/quality bound, not a product decision.

test("the region cap forces a commit when no qualifying pause arrives", async () => {
  const speech = 0.9;
  // All speech, no silence — no pause-based commit. The cap forces one.
  // 1-second cap = floor(16000 / 512) = 31 frames. After 31 frames, the 32nd triggers the cap.
  const capSeconds = 1;
  const numFrames = 35;

  const pattern = Array<number>(numFrames).fill(speech);
  const vad = new RegionVad(makeFixedPatternDetector(pattern), {
    refreshSilenceMs: 200,
    commitSilenceMs: 400,
    regionCapSeconds: capSeconds,
    minRegionSeconds: 0, // disable the minimum — this test is about the cap, not region length
  });

  const frames = Array.from({ length: numFrames }, (_, i) => makeFrame(i));
  let commitCount = 0;
  let committedSamples: Float32Array | null = null;
  for (const frame of frames) {
    const result = await vad.feed(frame);
    if (result.commit) {
      commitCount++;
      committedSamples = result.committedSamples;
    }
  }

  // At least one commit was forced by the cap.
  expect(commitCount).toBeGreaterThanOrEqual(1);
  expect(committedSamples).not.toBeNull();

  // The committed audio is exactly the cap size — floor(1 × 16000 / 512) = 31 frames.
  const capFrames = Math.floor((capSeconds * 16_000) / VAD_FRAME_SIZE);
  expect(committedSamples!.length).toBe(capFrames * VAD_FRAME_SIZE);

  // The committed audio contains the first 31 frames (0–30). The remainder (frames 31–34)
  // carries forward into the new region.
  const committedArray = Array.from(committedSamples!);
  expect(committedArray).toContain(0);
  expect(committedArray).toContain(30);
  expect(committedArray).not.toContain(31);

  // The new region holds the carried-forward frames.
  const newRegionSamples = Array.from(vad.samples);
  expect(newRegionSamples).toContain(31);
  expect(newRegionSamples).toContain(34);
});

// ── Test 5: a pause below the minimum region length refreshes but does NOT commit ──
//
// The fix this change exists for. Without the minimum-region-length gate, every phrase committed
// immediately — a pause past the commit threshold was sufficient, regardless of how short the
// region was. This test feeds a short burst of speech followed by a silence run past the commit
// threshold, with the region still well below the minimum. The pause must trigger a refresh (the
// tail is re-transcribed) but NOT a commit — the region keeps growing.

test("a pause below the minimum region length refreshes but does NOT commit", async () => {
  const speech = 0.9;
  const quiet = 0.0;
  // 10 speech + 15 silence = 25 frames (25 × 32 ms = 800 ms). The 15-frame silence crosses both
  // the refresh threshold (7 frames) and the commit threshold (13 frames). But the region is only
  // 25 frames, well below the 2-second minimum (ceil(2 × 16000 / 512) = 63 frames), so the commit
  // must not fire.
  const pattern = [...Array<number>(10).fill(speech), ...Array<number>(15).fill(quiet)];

  const vad = new RegionVad(makeFixedPatternDetector(pattern), {
    refreshSilenceMs: 200, // ceil(200/32) = 7 frames
    commitSilenceMs: 400, // ceil(400/32) = 13 frames
    regionCapSeconds: 30,
    minRegionSeconds: 2, // ceil(2 × 16000 / 512) = 63 frames — region (25) is well below
  });

  const frames = Array.from({ length: pattern.length }, (_, i) => makeFrame(i));
  const results = await feedAll(vad, frames);

  // A refresh fired — the 15-frame silence crossed the 7-frame refresh threshold.
  const anyRefresh = results.some((r) => r.refresh);
  expect(anyRefresh).toBe(true);

  // No commit — the region was below the minimum, so the pause could not commit.
  const anyCommit = results.some((r) => r.commit);
  expect(anyCommit).toBe(false);

  // The region still holds all 25 frames — the refresh did not advance the buffer, and no commit
  // cleared it. The audio from before the pause is still in the region.
  const samples = Array.from(vad.samples);
  expect(samples).toContain(0); // first speech frame
  expect(samples).toContain(9); // last speech frame
  expect(samples).toContain(24); // last silence frame
  expect(samples.length).toBe(pattern.length * VAD_FRAME_SIZE);
});

// ── Test 6: a pause past the minimum region length commits the whole accumulated region ──
//
// The test that proves regions actually accumulate across pauses. Two phrases separated by a
// pause: the first phrase's pause reaches the commit threshold but the region is below the
// minimum, so it refreshes but does NOT commit. The second phrase's pause reaches the commit
// threshold with the region now past the minimum, so it commits — and the committed audio
// includes the first phrase's audio, proving the region grew across the intervening pause.

test("a pause past the minimum region length commits the whole accumulated region", async () => {
  const speech = 0.9;
  const quiet = 0.0;
  // Two phrases separated by a pause, with a minimum that the first phrase alone cannot reach:
  //
  //   frames 0–9:    speech (first phrase, 10 frames ≥ 8-frame min-speech filter)
  //   frames 10–24:  silence (15 frames > 13-frame commit threshold, but region is 25 < 32 min)
  //   frames 25–34:  speech (second phrase)
  //   frames 35–49:  silence (15 frames > 13-frame commit threshold, region is 48 ≥ 32 min → COMMIT)
  //
  // minRegionSeconds: 1 → ceil(1 × 16000 / 512) = 32 frames. The first phrase's commit threshold
  // is reached at frame 22 (10 + 13 - 1), with the region at 23 frames — below 32, no commit.
  // The second phrase's commit threshold is reached at frame 47 (35 + 13 - 1), with the region
  // at 48 frames — past 32, commit fires. The committed audio is frames 0–47, which includes
  // the first phrase's speech (frames 0–9).
  const pattern = [
    ...Array<number>(10).fill(speech),
    ...Array<number>(15).fill(quiet),
    ...Array<number>(10).fill(speech),
    ...Array<number>(15).fill(quiet),
  ];

  const vad = new RegionVad(makeFixedPatternDetector(pattern), {
    refreshSilenceMs: 200, // ceil(200/32) = 7 frames
    commitSilenceMs: 400, // ceil(400/32) = 13 frames
    regionCapSeconds: 30,
    minRegionSeconds: 1, // ceil(1 × 16000 / 512) = 32 frames
  });

  const frames = Array.from({ length: pattern.length }, (_, i) => makeFrame(i));
  let committedSamples: Float32Array | null = null;
  let commitFrame = -1;
  let refreshCount = 0;
  for (let i = 0; i < frames.length; i++) {
    const result = await vad.feed(frames[i]!);
    if (result.commit) {
      committedSamples = result.committedSamples;
      commitFrame = i;
    }
    if (result.refresh) {
      refreshCount++;
    }
  }

  // A commit fired on the second phrase's pause.
  expect(committedSamples).not.toBeNull();
  expect(commitFrame).toBe(47); // 35 + 13 - 1

  // The committed audio includes the FIRST phrase's speech (frames 0–9) — the region accumulated
  // across the intervening pause that did not commit. This is the assertion that fails without
  // the minimum-region-length gate: without it, the first pause would have committed at frame 22,
  // and the second commit's audio would start at frame 23, not frame 0.
  const committedArray = Array.from(committedSamples!);
  expect(committedArray).toContain(0); // first frame of the first phrase
  expect(committedArray).toContain(9); // last frame of the first phrase
  expect(committedArray).toContain(25); // first frame of the second phrase
  expect(committedArray).toContain(47); // the commit frame
  expect(committedArray).not.toContain(48);
  expect(committedSamples!.length).toBe(48 * VAD_FRAME_SIZE);

  // The first phrase's pause fired a refresh (at frame 16, the 7-frame refresh threshold) but no
  // commit. The second phrase's pause also fired a refresh (at frame 41). Two refreshes total.
  expect(refreshCount).toBe(2);

  // After the commit, the buffer has advanced — the new region holds only the frames fed after
  // the commit (frames 48–49).
  const newRegionSamples = Array.from(vad.samples);
  expect(newRegionSamples).toContain(48);
  expect(newRegionSamples).toContain(49);
  for (let i = 0; i <= commitFrame; i++) {
    expect(newRegionSamples).not.toContain(i);
  }
  expect(newRegionSamples.length).toBe(2 * VAD_FRAME_SIZE);
});

// ── Test 7: the cap still forces a commit with no qualifying pause at all ──────────
//
// The minimum region length gates pause-driven commits only — the cap is a hard bound that forces
// a commit regardless. This test sets a minimum so high that no pause-driven commit could ever
// fire, feeds all-speech input (no pauses at all), and asserts the cap still commits.

test("the cap still forces a commit with no qualifying pause at all", async () => {
  const speech = 0.9;
  // All speech, no silence — no pause-based commit. The minimum is set far above the cap so a
  // pause-driven commit is impossible. The cap must still force a commit.
  // 1-second cap = floor(16000 / 512) = 31 frames. 60-second minimum = ceil(60 × 16000 / 512) =
  // 1875 frames — unreachably high. After 31 frames, the 32nd triggers the cap.
  const capSeconds = 1;
  const numFrames = 35;

  const pattern = Array<number>(numFrames).fill(speech);
  const vad = new RegionVad(makeFixedPatternDetector(pattern), {
    refreshSilenceMs: 200,
    commitSilenceMs: 400,
    regionCapSeconds: capSeconds,
    minRegionSeconds: 60, // far above the cap — a pause-driven commit can never fire
  });

  const frames = Array.from({ length: numFrames }, (_, i) => makeFrame(i));
  let commitCount = 0;
  let committedSamples: Float32Array | null = null;
  for (const frame of frames) {
    const result = await vad.feed(frame);
    if (result.commit) {
      commitCount++;
      committedSamples = result.committedSamples;
    }
  }

  // At least one commit was forced by the cap.
  expect(commitCount).toBeGreaterThanOrEqual(1);
  expect(committedSamples).not.toBeNull();

  // The committed audio is exactly the cap size — floor(1 × 16000 / 512) = 31 frames.
  const capFrames = Math.floor((capSeconds * 16_000) / VAD_FRAME_SIZE);
  expect(committedSamples!.length).toBe(capFrames * VAD_FRAME_SIZE);

  // The committed audio contains the first 31 frames (0–30). The remainder (frames 31–34)
  // carries forward into the new region.
  const committedArray = Array.from(committedSamples!);
  expect(committedArray).toContain(0);
  expect(committedArray).toContain(30);
  expect(committedArray).not.toContain(31);

  // The new region holds the carried-forward frames.
  const newRegionSamples = Array.from(vad.samples);
  expect(newRegionSamples).toContain(31);
  expect(newRegionSamples).toContain(34);
});

// ── Test 8: leading and trailing non-speech are excluded from the transcription input ──
//
// The live path used to hand the model the whole clock-bounded region — including the silence
// or room noise at its edges. The batch path never does this: planVadChunks cuts to speech
// boundaries and pads by 200 ms. This test proves the live path now does the same: the
// transcription input (transcriptionSamples) excludes leading and trailing non-speech, while
// preserving the audio between the first and last speech frame in full — including the pauses
// between phrases. The region buffer (committedSamples) is unchanged: it still holds every
// frame.
//
// How this fails if the trim is removed: transcriptionSamples would equal committedSamples
// (the whole region), and the assertions that frame 0 and frame 57 are absent would go red.
//
// How this fails if the trim also drops internal pauses: the internal pause frames (30–34)
// would be missing from transcriptionSamples, and the length assertion would go red — the
// output would be shorter by the duration of the pauses between speech segments.

test("leading and trailing non-speech are excluded from the transcription input, internal pauses preserved", async () => {
  const speech = 0.9;
  const quiet = 0.0;
  // 20 silence (leading) + 10 speech (phrase 1) + 5 silence (internal pause) + 10 speech
  // (phrase 2) + 15 silence (trailing, > 13-frame commit threshold).
  //
  // With commitSilenceMs: 400 (13 frames) and minRegionSeconds: 0, the trailing silence
  // triggers a commit at frame 57 (45 + 13 - 1). The committed region is frames 0–57.
  //
  // Speech span: firstSpeechFrame = 20, lastSpeechFrame = 44.
  // With padMs: 200 (ceil(200/32) = 7 frames):
  //   startFrame = max(0, 20 - 7) = 13
  //   endFrame   = min(58, 44 + 1 + 7) = 52
  //   transcriptionSamples = frames 13–51 (39 frames)
  //
  // The internal pause (frames 30–34) is inside [13, 51] → preserved.
  // The leading silence (frames 0–12) is before 13 → excluded.
  // The trailing silence (frames 52–57) is after 51 → excluded.
  const pattern = [
    ...Array<number>(20).fill(quiet),
    ...Array<number>(10).fill(speech),
    ...Array<number>(5).fill(quiet), // internal pause — MUST be preserved
    ...Array<number>(10).fill(speech),
    ...Array<number>(15).fill(quiet),
  ];

  const vad = new RegionVad(makeFixedPatternDetector(pattern), {
    refreshSilenceMs: 200,
    commitSilenceMs: 400, // ceil(400/32) = 13 frames
    regionCapSeconds: 30,
    minRegionSeconds: 0, // disable the minimum — this test is about trimming, not region length
    padMs: 200, // ceil(200/32) = 7 frames — same as batch path's DEFAULTS.padMs
  });

  const frames = Array.from({ length: pattern.length }, (_, i) => makeFrame(i));
  let transcriptionSamples: Float32Array | null = null;
  for (let i = 0; i < frames.length; i++) {
    const result = await vad.feed(frames[i]!);
    if (result.commit) {
      transcriptionSamples = result.transcriptionSamples;
    }
  }

  expect(transcriptionSamples).not.toBeNull();
  const trimmed = Array.from(transcriptionSamples!);

  // Internal pause frames are preserved — the KEY assertion. If the trim dropped internal
  // pauses, frames 30–34 would be absent.
  expect(trimmed).toContain(30); // first frame of the internal pause
  expect(trimmed).toContain(32); // middle of the internal pause
  expect(trimmed).toContain(34); // last frame of the internal pause

  // Both speech segments are preserved.
  expect(trimmed).toContain(20); // first frame of phrase 1
  expect(trimmed).toContain(29); // last frame of phrase 1
  expect(trimmed).toContain(35); // first frame of phrase 2
  expect(trimmed).toContain(44); // last frame of phrase 2

  // Leading non-speech is excluded (frames 0–12, before the padding window starts at 13).
  expect(trimmed).not.toContain(0);
  expect(trimmed).not.toContain(12);

  // Trailing non-speech is excluded (frames 52–57, after the padding window ends at 51).
  expect(trimmed).not.toContain(52);
  expect(trimmed).not.toContain(57);

  // The exact trimmed length: 39 frames (13–51 inclusive) × 512 samples.
  expect(transcriptionSamples!.length).toBe(39 * VAD_FRAME_SIZE);
});

// ── Test 9: the region buffer is unchanged by trimming ────────────────────────
//
// The trim is about what we hand the model, not what we keep. The region buffer's own semantics
// must not change: committedSamples still holds every frame contiguously, and a commit still
// advances past exactly the audio that was committed. The next region begins where the last
// ended — no gap, no overlap.
//
// How this fails if the trim leaks into the buffer: committedSamples would be shorter than the
// full region, and the assertions that frame 0 and frame 57 are present would go red. The buffer
// advance assertions (new region starts at 58) would also fail if the advance used the trimmed
// length instead of the full region length.

test("the region buffer is unchanged by trimming — commit advances past the whole region", async () => {
  const speech = 0.9;
  const quiet = 0.0;
  // Same pattern as Test 8: 20 silence + 10 speech + 5 silence + 10 speech + 15 silence = 60 frames.
  // Commit at frame 57. Committed region = frames 0–57 (58 frames).
  const pattern = [
    ...Array<number>(20).fill(quiet),
    ...Array<number>(10).fill(speech),
    ...Array<number>(5).fill(quiet),
    ...Array<number>(10).fill(speech),
    ...Array<number>(15).fill(quiet),
  ];

  const vad = new RegionVad(makeFixedPatternDetector(pattern), {
    refreshSilenceMs: 200,
    commitSilenceMs: 400,
    regionCapSeconds: 30,
    minRegionSeconds: 0,
    padMs: 200,
  });

  const frames = Array.from({ length: pattern.length }, (_, i) => makeFrame(i));
  let committedSamples: Float32Array | null = null;
  let transcriptionSamples: Float32Array | null = null;
  let commitFrame = -1;
  for (let i = 0; i < frames.length; i++) {
    const result = await vad.feed(frames[i]!);
    if (result.commit) {
      committedSamples = result.committedSamples;
      transcriptionSamples = result.transcriptionSamples;
      commitFrame = i;
    }
  }

  expect(committedSamples).not.toBeNull();
  expect(transcriptionSamples).not.toBeNull();
  expect(commitFrame).toBe(57);

  // committedSamples holds the FULL region — every frame, including leading and trailing silence.
  // This is the assertion that proves the buffer is unchanged by trimming.
  const committedArray = Array.from(committedSamples!);
  expect(committedArray).toContain(0); // leading silence
  expect(committedArray).toContain(57); // trailing silence
  expect(committedSamples!.length).toBe(58 * VAD_FRAME_SIZE);

  // transcriptionSamples is the trimmed subset — strictly shorter than committedSamples.
  const trimmedArray = Array.from(transcriptionSamples!);
  expect(trimmedArray).not.toContain(0);
  expect(trimmedArray).not.toContain(57);
  expect(transcriptionSamples!.length).toBeLessThan(committedSamples!.length);

  // The buffer advanced past the FULL region — the new region starts at frame 58, not at the
  // trimmed span's end. No gap, no overlap.
  const newRegionSamples = Array.from(vad.samples);
  expect(newRegionSamples).toContain(58);
  expect(newRegionSamples).toContain(59);
  for (let i = 0; i <= commitFrame; i++) {
    expect(newRegionSamples).not.toContain(i);
  }
  expect(newRegionSamples.length).toBe(2 * VAD_FRAME_SIZE);
});

// ── Test 10: a region containing no speech produces no transcription call at all ──
//
// A region with no speech must transcribe nothing rather than sending noise to the model.
// transcriptionSamples is null when the region has no speech, so the worker skips the
// transcription call entirely. The commit still happens (the buffer advances), but there is
// nothing to transcribe.
//
// How this fails if the no-speech guard is removed: transcriptionSamples would be non-null
// (the full region or a zero-length subarray), and the null assertion would go red.

test("a region with no speech produces null transcriptionSamples — no transcription call", async () => {
  const quiet = 0.0;
  // All silence, no speech. The cap forces a commit (1-second cap = 31 frames; the 32nd frame
  // triggers it). The committed region has no speech, so transcriptionSamples must be null.
  const capSeconds = 1;
  const numFrames = 35;
  const pattern = Array<number>(numFrames).fill(quiet);

  const vad = new RegionVad(makeFixedPatternDetector(pattern), {
    refreshSilenceMs: 200,
    commitSilenceMs: 400,
    regionCapSeconds: capSeconds,
    minRegionSeconds: 0,
    padMs: 200,
  });

  const frames = Array.from({ length: numFrames }, (_, i) => makeFrame(i));
  let commitResult: RegionFrameResult | null = null;
  for (const frame of frames) {
    const result = await vad.feed(frame);
    if (result.commit) {
      commitResult = result;
    }
  }

  // The cap forced a commit — the buffer advanced.
  expect(commitResult).not.toBeNull();
  expect(commitResult!.commit).toBe(true);
  expect(commitResult!.committedSamples).not.toBeNull();

  // But there was no speech, so transcriptionSamples is null — no transcription call.
  expect(commitResult!.transcriptionSamples).toBeNull();
});

test("drain on a no-speech region returns empty — no transcription call on close", async () => {
  const quiet = 0.0;
  // Feed silence frames (not enough to trigger the cap), then drain. The drained region has
  // no speech, so drain returns an empty Float32Array — the worker skips transcription.
  const pattern = Array<number>(10).fill(quiet);

  const vad = new RegionVad(makeFixedPatternDetector(pattern), {
    refreshSilenceMs: 200,
    commitSilenceMs: 400,
    regionCapSeconds: 30,
    minRegionSeconds: 0,
    padMs: 200,
  });

  const frames = Array.from({ length: pattern.length }, (_, i) => makeFrame(i));
  await feedAll(vad, frames);

  const drained = await vad.drain();
  // No speech → drain returns empty — the worker's `if (samples.length === 0)` guard skips
  // the transcription call.
  expect(drained.length).toBe(0);
});
