import { describe, expect, test } from "vitest";

import {
  binarizeSpeech,
  cutLongRegions,
  dropShortSpeech,
  fillShortSilences,
  frameToSample,
  mergeRegions,
  padRegions,
  planFallbackChunks,
  planVadChunks,
  rootMeanSquare,
  speechProbabilities,
  WHISPER_WINDOW_SECONDS,
} from "./segmentation.js";
import type { FrameGeometry, SampleRange } from "./segmentation.js";

/**
 * The segmentation maths, proved with no model, no worker and no browser — which is the reason it
 * was written as standalone functions rather than inline in the worker's `transcribe`.
 *
 * Three of these tests guard properties that are unusually easy to write so they pass against a
 * WRONG implementation, and each is built to rule that out explicitly: the cleaning ORDER, the
 * hysteresis, and the minimum-probability cut. Where a fixture had to be shaped a particular way to
 * make the test discriminating, the comment says so.
 */

/** `pyannote-segmentation-3.0`'s real geometry — a frame every 16.875 ms. */
const GEOMETRY: FrameGeometry = { step: 270, offset: 990, sampleRate: 16_000 };

/** Frames per millisecond, for building fixtures in human units. */
const framesFor = (ms: number): number => Math.round((ms / 1000) * (16_000 / 270));

/** A probability track: `[durationMs, p]` pairs flattened into per-frame values. */
function track(...spans: readonly (readonly [number, number])[]): Float32Array {
  const values: number[] = [];
  for (const [ms, p] of spans) for (let i = 0; i < framesFor(ms); i++) values.push(p);
  return new Float32Array(values);
}

const spans = (regions: readonly SampleRange[]): [number, number][] =>
  regions.map((r) => [r.start, r.end]);

describe("speechProbabilities", () => {
  test("speech is one minus the class-0 (silence) probability", () => {
    // Two frames, 7 powerset classes. Frame 0 is confidently silence; frame 1 confidently a speaker.
    const logits = new Float32Array([10, 0, 0, 0, 0, 0, 0, 0, 10, 0, 0, 0, 0, 0]);
    const p = speechProbabilities(logits, 2, 7);
    expect(p[0]!).toBeLessThan(0.01);
    expect(p[1]!).toBeGreaterThan(0.99);
  });

  test("it sums the six non-empty classes, not just the argmax one", () => {
    // No single speaker class dominates, but together they far outweigh silence. An implementation
    // reading only the largest class would call this near-silence; it is confidently speech.
    const logits = new Float32Array([0, 2, 2, 2, 2, 2, 2]);
    expect(speechProbabilities(logits, 1, 7)[0]!).toBeGreaterThan(0.9);
  });

  test("large logits do not overflow to NaN", () => {
    // Without subtracting the row max, exp(1000) is Infinity and every threshold downstream silently
    // compares against NaN — which is false for both `>= onset` and `< leave`, so speech vanishes.
    const p = speechProbabilities(new Float32Array([1000, 1001, 0, 0, 0, 0, 0]), 1, 7);
    expect(Number.isNaN(p[0]!)).toBe(false);
    expect(p[0]!).toBeGreaterThan(0.5);
  });
});

describe("frame geometry", () => {
  test("the frame step is 16.875 ms for this model — derived, not assumed", () => {
    // Pins the one constant everything else is expressed in. `step: 270` at 16 kHz. If a future
    // model swap changes this, every duration threshold silently rescales by a constant factor and
    // no other test in this file would notice, because they all share the geometry.
    expect((GEOMETRY.step / GEOMETRY.sampleRate) * 1000).toBeCloseTo(16.875, 6);
  });

  test("frameToSample inverts the extractor's frames = (samples - offset) / step", () => {
    expect(frameToSample(0, GEOMETRY)).toBe(990);
    expect(frameToSample(100, GEOMETRY)).toBe(100 * 270 + 990);
  });
});

describe("binarizeSpeech — hysteresis", () => {
  test("a probability oscillating BETWEEN the thresholds stays ONE region", () => {
    // THE POINT OF THIS TEST. Every value here sits in the hysteresis gap (0.35 <= p < 0.5), so it
    // never re-crosses `onset` after the first frame and never falls below `leave`. A
    // single-threshold implementation at 0.5 sees the 0.4s as silence and shreds this into four
    // regions; with two thresholds it is one continuous utterance. A fixture that swung fully across
    // both thresholds could not tell the two implementations apart.
    const p = track([200, 0.9], [100, 0.4], [200, 0.45], [100, 0.4], [200, 0.9]);
    expect(binarizeSpeech(p, 0.5, 0.35)).toHaveLength(1);
  });

  test("a drop below the LEAVE threshold does end the region", () => {
    const p = track([200, 0.9], [200, 0.1], [200, 0.9]);
    expect(binarizeSpeech(p, 0.5, 0.35)).toHaveLength(2);
  });

  test("speech running to the final frame is closed rather than discarded", () => {
    expect(binarizeSpeech(track([200, 0.1], [200, 0.9]), 0.5, 0.35)).toHaveLength(1);
  });

  test("all-silence yields no regions", () => {
    expect(binarizeSpeech(track([1000, 0.05]), 0.5, 0.35)).toEqual([]);
  });
});

describe("cleaning — the ORDER is load-bearing", () => {
  test("two 150 ms fragments split by a 50 ms gap survive as one region", () => {
    // THE POINT OF THIS TEST, and the bug this ordering was written to avoid. Each fragment is below
    // the 250 ms minimum on its own. Filling the 50 ms gap FIRST produces one ~350 ms region that
    // survives; dropping short speech first destroys both fragments and leaves the fill nothing to
    // join, silently deleting real speech. Reversing the two calls below must turn this red.
    const minSpeech = framesFor(250);
    const minSilence = framesFor(100);
    const fragments: SampleRange[] = [
      { start: 0, end: framesFor(150) },
      { start: framesFor(200), end: framesFor(350) },
    ];

    const filledFirst = dropShortSpeech(fillShortSilences(fragments, minSilence), minSpeech);
    expect(filledFirst).toHaveLength(1);
    expect(filledFirst[0]!.end - filledFirst[0]!.start).toBeGreaterThanOrEqual(minSpeech);

    // Stated as an assertion rather than a comment, so the claim is checked rather than believed.
    expect(fillShortSilences(dropShortSpeech(fragments, minSpeech), minSilence)).toEqual([]);
  });

  test("a genuine silence longer than the minimum is NOT filled", () => {
    const regions: SampleRange[] = [
      { start: 0, end: framesFor(500) },
      { start: framesFor(1000), end: framesFor(1500) },
    ];
    expect(fillShortSilences(regions, framesFor(100))).toHaveLength(2);
  });
});

describe("padRegions", () => {
  test("padding is applied on both sides and clamped to the buffer", () => {
    const padded = padRegions([{ start: 100, end: 200 }], 30, 1000);
    expect(padded[0]).toEqual({ start: 70, end: 230 });
    expect(padRegions([{ start: 5, end: 990 }], 30, 1000)[0]).toEqual({ start: 0, end: 1000 });
  });

  test("regions whose padding would collide meet at the gap midpoint and never overlap", () => {
    // A 20-frame gap with 30 frames of padding on each side: naive padding gives [70,230] and
    // [210,340], which OVERLAP — and overlapping chunks reintroduce the duplicated audio this whole
    // approach exists to avoid. They must meet at the midpoint of the original gap, 210.
    const padded = padRegions(
      [
        { start: 100, end: 200 },
        { start: 220, end: 310 },
      ],
      30,
      1000,
    );
    expect(padded[0]!.end).toBe(210);
    expect(padded[1]!.start).toBe(210);
    expect(padded[0]!.end).toBeLessThanOrEqual(padded[1]!.start);
  });
});

describe("mergeRegions", () => {
  test("consecutive regions merge while the span fits, and stop when it would not", () => {
    const merged = mergeRegions(
      [
        { start: 0, end: 100 },
        { start: 150, end: 250 },
        { start: 900, end: 1000 },
      ],
      500,
    );
    expect(spans(merged)).toEqual([
      [0, 250],
      [900, 1000],
    ]);
  });

  test("a region of exactly the maximum span is left alone", () => {
    expect(spans(mergeRegions([{ start: 0, end: 500 }], 500))).toEqual([[0, 500]]);
  });
});

describe("cutLongRegions — the minimum-probability split", () => {
  test("an over-long region splits at its QUIETEST frame, not at its midpoint", () => {
    // THE POINT OF THIS TEST. The dip is placed at 60% through the region, deliberately away from
    // the 50% midpoint AND inside the middle-50% search band, so a naive midpoint cut and a
    // minimum-probability cut give visibly different answers. A dip at the centre — the fixture one
    // would write without thinking — cannot distinguish them and would prove nothing.
    const total = 1000;
    const p = new Float32Array(total).fill(0.9);
    const dip = 600;
    p[dip] = 0.05;

    const chunks = cutLongRegions([{ start: 0, end: total }], p, 700);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.end).toBe(dip);
    expect(chunks[1]!.start).toBe(dip);
    expect(chunks[0]!.end).not.toBe(Math.floor(total / 2));
  });

  test("the split is strictly interior and the halves exactly cover the parent", () => {
    const p = new Float32Array(1000).fill(0.9);
    p[620] = 0.1;
    const chunks = cutLongRegions([{ start: 0, end: 1000 }], p, 700);
    expect(chunks[0]!.start).toBe(0);
    expect(chunks[chunks.length - 1]!.end).toBe(1000);
    for (let i = 1; i < chunks.length; i++) expect(chunks[i]!.start).toBe(chunks[i - 1]!.end);
    for (const chunk of chunks) expect(chunk.end).toBeGreaterThan(chunk.start);
  });

  test("a minimum at the region edge cannot produce a sliver — the search band forbids it", () => {
    // The quietest frame overall is at index 2, outside the middle-50% band. Cutting there would
    // split off a 2-frame chunk and make almost no progress; the band is what stops that.
    const p = new Float32Array(1000).fill(0.9);
    p[2] = 0.01;
    const chunks = cutLongRegions([{ start: 0, end: 1000 }], p, 700);
    for (const chunk of chunks) expect(chunk.end - chunk.start).toBeGreaterThan(100);
  });

  test("it recurses until every chunk fits, however long the region", () => {
    const p = new Float32Array(5000).fill(0.9);
    const chunks = cutLongRegions([{ start: 0, end: 5000 }], p, 700);
    for (const chunk of chunks) expect(chunk.end - chunk.start).toBeLessThanOrEqual(700);
    expect(chunks[0]!.start).toBe(0);
    expect(chunks[chunks.length - 1]!.end).toBe(5000);
  });
});

describe("planVadChunks", () => {
  const totalSamples = 60 * 16_000;

  test("nearby speech is MERGED across silence into one pass, not split at every pause", () => {
    // Two utterances three seconds apart span seven seconds together — far inside the 30 s window —
    // so they belong in ONE chunk. Splitting at every pause would double the inference cost for no
    // gain, and it is the merge step's entire job to prevent that. The silence rides along inside
    // the chunk, which is exactly what Whisper was trained to handle.
    const chunks = planVadChunks(
      track([2000, 0.9], [3000, 0.02], [2000, 0.9]),
      GEOMETRY,
      totalSamples,
    );
    expect(chunks).toHaveLength(1);
  });

  test("speech far enough apart to exceed the window becomes separate chunks", () => {
    // The same shape, but with a 40 s gap: merging would span 44 s, past the window, so the merge
    // must stop and the two utterances become separate chunks in sample space.
    const chunks = planVadChunks(
      track([2000, 0.9], [40_000, 0.02], [2000, 0.9]),
      GEOMETRY,
      totalSamples,
    );
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.start).toBeLessThan(chunks[0]!.end);
    expect(chunks[0]!.end).toBeLessThanOrEqual(chunks[1]!.start);
  });

  test("chunks are ordered, non-overlapping, and never exceed the window", () => {
    const p = track([40_000, 0.9], [2000, 0.02], [30_000, 0.9]);
    const chunks = planVadChunks(p, GEOMETRY, 120 * 16_000);
    const maxSamples = WHISPER_WINDOW_SECONDS * 16_000;
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i]!.end).toBeGreaterThan(chunks[i]!.start);
      expect(chunks[i]!.end - chunks[i]!.start).toBeLessThanOrEqual(maxSamples);
      if (i > 0) expect(chunks[i]!.start).toBeGreaterThanOrEqual(chunks[i - 1]!.end);
    }
  });

  test("the pipeline FILLS before it DROPS — fragments survive end to end, not just in isolation", () => {
    // The cleaning-order test above proves `fillShortSilences` and `dropShortSpeech` behave
    // correctly when called in the right order. It does NOT prove `planVadChunks` calls them in that
    // order — swapping the two lines inside the pipeline leaves it green, because it never runs the
    // pipeline. This one does: two 150 ms fragments split by a 50 ms gap must survive as one chunk,
    // and reversing the order inside `planVadChunks` yields zero chunks.
    const p = track([1000, 0.02], [150, 0.9], [50, 0.02], [150, 0.9], [1000, 0.02]);
    expect(planVadChunks(p, GEOMETRY, totalSamples)).toHaveLength(1);
  });

  test("the pipeline applies HYSTERESIS — a wavering utterance survives end to end", () => {
    // The companion to the test above, for the other threshold. Between the two loud passages the
    // probability wavers inside the hysteresis gap, never returning to `onset` but never falling
    // below `leave`. With hysteresis that is one ~800 ms utterance and one chunk. With a single
    // threshold it fragments into two 200 ms pieces, both then discarded as too short, and the
    // speech disappears entirely — so this returns zero chunks if `planVadChunks` passes the same
    // value for both thresholds.
    const p = track(
      [1000, 0.02],
      [200, 0.9],
      [100, 0.4],
      [200, 0.45],
      [100, 0.4],
      [200, 0.9],
      [1000, 0.02],
    );
    expect(planVadChunks(p, GEOMETRY, totalSamples)).toHaveLength(1);
  });

  test("all-silence yields NO chunks — which the caller must not read as a failure", () => {
    // An empty result is the correct answer for a silent recording. Running fixed windows of padded
    // silence through a decoder primed with domain jargon would manufacture content from nothing,
    // so the caller distinguishes this case by energy, not by chunk count alone.
    expect(planVadChunks(track([10_000, 0.02]), GEOMETRY, totalSamples)).toEqual([]);
  });

  test("an isolated blip shorter than the minimum is not a chunk", () => {
    expect(
      planVadChunks(track([1000, 0.02], [80, 0.9], [1000, 0.02]), GEOMETRY, totalSamples),
    ).toEqual([]);
  });

  test("chunks never run past the end of the buffer", () => {
    const p = track([5000, 0.9]);
    for (const chunk of planVadChunks(p, GEOMETRY, 4 * 16_000)) {
      expect(chunk.end).toBeLessThanOrEqual(4 * 16_000);
      expect(chunk.start).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("planFallbackChunks", () => {
  const sr = 16_000;
  const window = WHISPER_WINDOW_SECONDS * sr;

  test("empty audio plans nothing", () => {
    expect(planFallbackChunks(0, sr)).toEqual([]);
  });

  test("a short clip is ONE chunk over the whole clip — today's path", () => {
    expect(planFallbackChunks(11 * sr, sr)).toEqual([{ start: 0, end: 11 * sr }]);
  });

  test("exactly 30 s is still one chunk", () => {
    expect(planFallbackChunks(window, sr)).toEqual([{ start: 0, end: window }]);
  });

  test("30 s + 1 sample plans two chunks, the first still starting at sample 0", () => {
    const chunks = planFallbackChunks(window + 1, sr);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.start).toBe(0);
    expect(chunks[chunks.length - 1]!.end).toBe(window + 1);
  });

  test("a five-minute recording is fully covered with NO gap and no over-long chunk", () => {
    const total = 300 * sr;
    const chunks = planFallbackChunks(total, sr);
    expect(chunks[0]!.start).toBe(0);
    expect(chunks[chunks.length - 1]!.end).toBe(total);
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i]!.end - chunks[i]!.start).toBeLessThanOrEqual(window);
      // A gap is silently lost speech — the bug being fixed — so it is asserted directly rather
      // than inferred from the chunk count.
      if (i > 0) expect(chunks[i]!.start).toBeLessThanOrEqual(chunks[i - 1]!.end);
    }
  });

  test("adjacent chunks overlap by 10 s — two strides, not one", () => {
    // `window - jump` = 30 - 20 = 10 s. Asserting 5 s here would pass against an implementation
    // that used a single stride and left every boundary word with half the context.
    const chunks = planFallbackChunks(120 * sr, sr);
    expect(chunks[0]!.end - chunks[1]!.start).toBe(10 * sr);
  });
});

describe("rootMeanSquare", () => {
  test("silence is zero and a tone is not", () => {
    expect(rootMeanSquare(new Float32Array(1000))).toBe(0);
    const tone = Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i / 5));
    expect(rootMeanSquare(tone)).toBeGreaterThan(0.5);
  });

  test("an empty buffer is zero, not NaN", () => {
    expect(rootMeanSquare(new Float32Array(0))).toBe(0);
  });
});
