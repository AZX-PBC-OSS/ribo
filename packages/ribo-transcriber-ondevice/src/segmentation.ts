/**
 * @file Voice-activity segmentation — the arithmetic half of long-form transcription.
 *
 * Whisper's receptive field is 30 seconds. The feature extractor pads shorter audio and **truncates
 * anything longer** (`audio.slice(0, n_samples)` in `feature_extraction_whisper.js`), so a
 * five-minute walkthrough used to transcribe as a confident-looking account of its first 30 seconds,
 * with no error and nothing downstream able to tell.
 *
 * The fix is WhisperX's construction: segment the audio on speech boundaries into **non-overlapping**
 * chunks of at most 30 s, transcribe each, concatenate. The reason to prefer it over the obvious
 * overlapped sliding window is not only its lower error rate — it removes a class of bug instead of
 * mitigating one. A sliding window cuts mid-word, so it needs overlap, so it needs a step that merges
 * the duplicated text, and that merge is where speech gets silently deleted. Non-overlapping chunks
 * have nothing to merge.
 *
 * **This module is pure arithmetic over numbers.** No model, no worker, no browser. That is
 * deliberate: every subtle failure in this design lives in the maths below, and this way all of it is
 * provable in a node unit test. Loading pyannote and running it is a separate concern.
 *
 * The honest caveat, stated here because it belongs next to the code: VAD introduces its own
 * deletion path. Audio the model marks non-speech never reaches Whisper — quiet speech in a loud
 * basement is exactly the case — and nothing detects it. That is the same harm category as the bug
 * being fixed, so every threshold below is biased toward over-transcribing: a spurious speech region
 * costs one wasted inference pass, a missed one costs content.
 */

/** A half-open `[start, end)` range, in samples. */
export interface SampleRange {
  readonly start: number;
  readonly end: number;
}

/** A half-open `[start, end)` range, in VAD frames. */
interface FrameRange {
  start: number;
  end: number;
}

/**
 * The VAD model's frame geometry, read at runtime from its processor config.
 *
 * **Never hardcode these.** For `pyannote-segmentation-3.0` the values are `step: 270`,
 * `offset: 990`, `sampleRate: 16000` — a frame every 16.875 ms — and the extractor derives frame
 * counts as `(samples - offset) / step`. Every threshold, timestamp and cut position below is
 * expressed in frames and converted through these numbers, so a wrong `step` silently rescales the
 * entire algorithm by a constant factor while every test that shares the bad constant still passes.
 */
export interface FrameGeometry {
  readonly step: number;
  readonly offset: number;
  readonly sampleRate: number;
}

/** Tuning for {@link planVadChunks}. Defaults are the values this module was reasoned about with. */
export interface SegmentationOptions {
  /** Probability at which a frame ENTERS speech. */
  readonly onset?: number;
  /** Probability below which a frame LEAVES speech. Lower than `onset` — that gap is the hysteresis. */
  readonly leave?: number;
  /** Speech shorter than this is noise, not an utterance. */
  readonly minSpeechMs?: number;
  /** Silence shorter than this is a pause inside a word, not a boundary. */
  readonly minSilenceMs?: number;
  /** Added to each side of a region so a consonant onset is not clipped. */
  readonly padMs?: number;
  /** Whisper's receptive field. Also WhisperX's measured-optimal merge threshold. */
  readonly maxChunkSeconds?: number;
}

const DEFAULTS = {
  onset: 0.5,
  leave: 0.35,
  minSpeechMs: 250,
  minSilenceMs: 100,
  padMs: 200,
  maxChunkSeconds: 30,
} as const;

/** Whisper's receptive field in seconds — architectural, not a tunable. */
export const WHISPER_WINDOW_SECONDS = 30;

/**
 * Per-frame `P(speech)` from the model's raw powerset logits.
 *
 * **Class 0 is silence.** That is established by the model's own config
 * (`id2label["0"] === "NO_SPEAKER"`) and by pyannote's powerset construction, in which the first
 * class is the empty set — not by inference from output that happens to look right.
 *
 * So `P(speech)` is one minus the silence probability, equivalently the sum of the six non-empty
 * classes. A hard `argmax !== 0` decision would be cheaper and is **not** usable: the hysteresis,
 * the cross-window averaging and the minimum-probability cut all need a continuous value.
 */
export function speechProbabilities(
  logits: Float32Array,
  frames: number,
  classes: number,
): Float32Array {
  const out = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    const base = frame * classes;
    // Subtract the row max before exponentiating — the standard guard against overflow on large
    // logits, which would otherwise produce NaN and silently poison every threshold downstream.
    let max = -Infinity;
    for (let c = 0; c < classes; c++) {
      const value = logits[base + c] ?? 0;
      if (value > max) max = value;
    }
    let total = 0;
    let silence = 0;
    for (let c = 0; c < classes; c++) {
      const weight = Math.exp((logits[base + c] ?? 0) - max);
      total += weight;
      if (c === 0) silence = weight;
    }
    out[frame] = total > 0 ? 1 - silence / total : 0;
  }
  return out;
}

/** Frame index to sample index, inverting the extractor's `frames = (samples - offset) / step`. */
export function frameToSample(frame: number, geometry: FrameGeometry): number {
  return frame * geometry.step + geometry.offset;
}

/** Convert a duration to a whole number of frames, always at least one. */
function msToFrames(ms: number, geometry: FrameGeometry): number {
  return Math.max(1, Math.round((ms / 1000) * (geometry.sampleRate / geometry.step)));
}

/**
 * Binarize per-frame probabilities into speech regions, with **hysteresis**.
 *
 * A frame enters speech at `onset` and only leaves below `leave`. Two thresholds rather than one
 * because a probability hovering around a single boundary — which is what the model produces through
 * a quiet syllable — would otherwise shred one utterance into dozens of fragments, each of which the
 * min-duration filter then discards. The gap between the thresholds is the whole mechanism.
 */
export function binarizeSpeech(pSpeech: Float32Array, onset: number, leave: number): SampleRange[] {
  const regions: FrameRange[] = [];
  let current: FrameRange | undefined;
  for (let frame = 0; frame < pSpeech.length; frame++) {
    const p = pSpeech[frame] ?? 0;
    if (current === undefined) {
      if (p >= onset) current = { start: frame, end: frame + 1 };
    } else if (p < leave) {
      regions.push(current);
      current = undefined;
    } else {
      current.end = frame + 1;
    }
  }
  if (current !== undefined) regions.push(current);
  return regions;
}

/**
 * Join regions separated by less than `minSilenceFrames`.
 *
 * **This runs BEFORE short regions are dropped, and the order is load-bearing.** Two 150 ms
 * fragments split by a 50 ms false gap: filling first yields one 350 ms region that survives the
 * min-speech filter; dropping first destroys both and leaves the fill nothing to join. In a module
 * whose purpose is to stop speech being silently deleted, that ordering is the difference between
 * working and not.
 */
export function fillShortSilences(
  regions: readonly SampleRange[],
  minSilence: number,
): SampleRange[] {
  const filled: FrameRange[] = [];
  for (const region of regions) {
    const previous = filled[filled.length - 1];
    if (previous !== undefined && region.start - previous.end < minSilence) {
      previous.end = region.end;
    } else {
      filled.push({ start: region.start, end: region.end });
    }
  }
  return filled;
}

/** Drop regions shorter than `minSpeech` — noise, not an utterance. Runs AFTER the silence fill. */
export function dropShortSpeech(regions: readonly SampleRange[], minSpeech: number): SampleRange[] {
  return regions.filter((region) => region.end - region.start >= minSpeech);
}

/**
 * Pad each region on both sides so a consonant onset or a trailing fricative is not clipped.
 *
 * Where two padded regions would collide they meet at the **midpoint of the original gap** — one
 * deterministic shared boundary. Clamping each side independently to its neighbour does not actually
 * guarantee non-overlap, and overlapping chunks would reintroduce duplicated audio, which is the
 * thing this whole approach exists to avoid.
 */
export function padRegions(
  regions: readonly SampleRange[],
  pad: number,
  limit: number,
): SampleRange[] {
  const padded: FrameRange[] = regions.map((region) => ({
    start: Math.max(0, region.start - pad),
    end: Math.min(limit, region.end + pad),
  }));
  for (let i = 1; i < padded.length; i++) {
    const previous = padded[i - 1]!;
    const current = padded[i]!;
    if (previous.end > current.start) {
      const midpoint = Math.floor((regions[i - 1]!.end + regions[i]!.start) / 2);
      previous.end = midpoint;
      current.start = midpoint;
    }
  }
  return padded;
}

/** Greedily merge consecutive regions while the combined span stays within `maxSpan`. */
export function mergeRegions(regions: readonly SampleRange[], maxSpan: number): SampleRange[] {
  const merged: FrameRange[] = [];
  for (const region of regions) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && region.end - previous.start <= maxSpan) {
      previous.end = region.end;
    } else {
      merged.push({ start: region.start, end: region.end });
    }
  }
  return merged;
}

/**
 * Split any region longer than `maxSpan` at its **quietest** frame, recursively.
 *
 * The search is confined to the **middle 50%** of the region. That band is not decoration: a minimum
 * found at the very edge would split off a sliver and make no progress, so the band is what
 * guarantees both halves are substantial and that the recursion terminates. Ties go to the earliest
 * frame, so the result is deterministic.
 *
 * A region this long is continuous speech, so unlike every other chunk boundary this one necessarily
 * falls *inside* speech. Cutting at the local probability minimum is the least-bad place for it.
 */
export function cutLongRegions(
  regions: readonly SampleRange[],
  pSpeech: Float32Array,
  maxSpan: number,
): SampleRange[] {
  const out: SampleRange[] = [];
  const queue = [...regions];
  while (queue.length > 0) {
    const region = queue.shift()!;
    const span = region.end - region.start;
    if (span <= maxSpan) {
      out.push(region);
      continue;
    }
    const bandStart = region.start + Math.floor(span * 0.25);
    const bandEnd = region.start + Math.ceil(span * 0.75);
    let cut = bandStart;
    let quietest = Infinity;
    for (let frame = bandStart; frame < bandEnd; frame++) {
      const p = pSpeech[frame] ?? 0;
      if (p < quietest) {
        quietest = p;
        cut = frame;
      }
    }
    // Both halves are non-empty because the band is strictly interior to the region.
    queue.unshift({ start: region.start, end: cut }, { start: cut, end: region.end });
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * The whole pipeline: per-frame speech probabilities to ordered, non-overlapping sample chunks,
 * none longer than `maxChunkSeconds`.
 *
 * Returns `[]` when no speech is found. That is **not** the same as a failure, and the caller must
 * not treat it as one: on genuinely silent audio the right answer is an empty transcript, whereas
 * running fixed windows of padded silence through a decoder primed with domain jargon is a way to
 * manufacture content out of nothing.
 */
export function planVadChunks(
  pSpeech: Float32Array,
  geometry: FrameGeometry,
  totalSamples: number,
  options: SegmentationOptions = {},
): SampleRange[] {
  const onset = options.onset ?? DEFAULTS.onset;
  const leave = options.leave ?? DEFAULTS.leave;
  const maxChunkSeconds = options.maxChunkSeconds ?? DEFAULTS.maxChunkSeconds;

  const minSpeech = msToFrames(options.minSpeechMs ?? DEFAULTS.minSpeechMs, geometry);
  const minSilence = msToFrames(options.minSilenceMs ?? DEFAULTS.minSilenceMs, geometry);
  const pad = msToFrames(options.padMs ?? DEFAULTS.padMs, geometry);
  const maxSpan = msToFrames(maxChunkSeconds * 1000, geometry);

  const speech = binarizeSpeech(pSpeech, onset, leave);
  // Order matters — see `fillShortSilences`.
  const joined = fillShortSilences(speech, minSilence);
  const kept = dropShortSpeech(joined, minSpeech);
  if (kept.length === 0) return [];

  const padded = padRegions(kept, pad, pSpeech.length);
  const merged = mergeRegions(padded, maxSpan);
  const chunks = cutLongRegions(merged, pSpeech, maxSpan);

  return chunks.map((chunk) => ({
    start: Math.max(0, Math.min(totalSamples, frameToSample(chunk.start, geometry))),
    end: Math.max(0, Math.min(totalSamples, frameToSample(chunk.end, geometry))),
  }));
}

/**
 * The fallback when VAD is unavailable, errors, or finds nothing on audible input: a fixed-window
 * march, copied in structure from transformers.js's own ASR pipeline
 * (`src/pipelines/automatic-speech-recognition.js`).
 *
 * The final chunk is simply **short**. Do not anchor it to the end of the audio and do not distribute
 * the windows evenly — an earlier attempt did both and was wrong on both counts. The loop's exit
 * condition fires as soon as `offset + window >= total`, so the last chunk can never be shorter than
 * `window - jump`; there is no runt tail to defend against, and anchoring introduces a pathological
 * near-duplicate window whenever the remainder is small.
 *
 * These chunks **overlap by `window - jump` = 10 s** and are concatenated with **no merge step**, so
 * the fallback knowingly trades some duplicated text for never losing speech. That is the correct
 * direction: a reader and the downstream extraction both absorb a repeated phrase harmlessly, and
 * neither can recover a deleted one.
 */
export function planFallbackChunks(totalSamples: number, sampleRate: number): SampleRange[] {
  if (totalSamples <= 0) return [];
  const window = WHISPER_WINDOW_SECONDS * sampleRate;
  if (totalSamples <= window) return [{ start: 0, end: totalSamples }];

  const stride = window / 6;
  const jump = window - 2 * stride;
  const chunks: SampleRange[] = [];
  let offset = 0;
  for (;;) {
    chunks.push({ start: offset, end: Math.min(offset + window, totalSamples) });
    if (offset + window >= totalSamples) break;
    offset += jump;
  }
  return chunks;
}

/**
 * Root-mean-square amplitude — the model-free signal that tells credible silence from VAD failure.
 *
 * When segmentation returns no chunks, the caller cannot tell "this recording is silent" from "the
 * voice-activity model failed on audible speech" — and the two want opposite responses. Energy
 * distinguishes them without loading anything.
 */
export function rootMeanSquare(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const value = samples[i] ?? 0;
    sum += value * value;
  }
  return Math.sqrt(sum / samples.length);
}
