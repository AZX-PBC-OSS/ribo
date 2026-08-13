import { expect, test } from "vitest";

import longWavUrl from "../testdata/energy-audit-long-48k-mono.wav?url";
import { DEFAULT_MODEL_ID, decodeTo16kMono, OnDeviceTranscriber } from "./index.js";
import {
  VAD_FRAME_SIZE,
  VAD_SAMPLE_RATE,
  StreamingVad,
  createSileroDetector,
} from "./vad-stream.js";
import type { ProbabilityDetector } from "./vad-stream.js";

/**
 * OPT-IN, NOT GATED. Runs only under `vitest.manual.config.ts` — never in `./check.sh`.
 *
 *   pnpm exec vitest run --config packages/ribo-transcriber-ondevice/vitest.manual.config.ts \
 *     packages/ribo-transcriber-ondevice/src/localagreement-spike.manual.ts
 *
 * ## What this probes
 *
 * LocalAgreement-n (Macháček, Dabre & Bojar 2023, `whisper_streaming`): re-transcribe a
 * fixed-start, growing-end buffer at each VAD pause; commit the longest word prefix that
 * n consecutive hypotheses agree on; leave the disagreeing tail provisional. The start
 * only advances when text is committed, so the model always sees the region from its
 * beginning.
 *
 * Compares three approaches on the same 54 s energy-audit fixture:
 *   1. **isolated** — per-closed-utterance, what ships today
 *   2. **LocalAgreement-2** — commit-on-agreement over a growing buffer (15 s and 30 s caps)
 *   3. **batch** — `OnDeviceTranscriber` over the whole 54 s, the quality reference
 *
 * Also measures LocalAgreement-3, reproducibility (same buffer transcribed twice), and
 * the duty cycle at 15 s and 30 s region caps.
 */
declare const __ORT_WASM_BASE__: string;

const SAMPLE_RATE = 16_000;

// ── Minimal ASR pipeline view (mirrors worker.ts's AsrPipeline) ───────────────

interface AsrPipeline {
  readonly tokenizer: {
    decode(ids: number[], options?: { skip_special_tokens?: boolean }): string;
  };
  readonly model: {
    generate(inputs: Record<string, unknown>): Promise<unknown>;
  };
  processor(audio: Float32Array): Promise<{ input_features?: unknown; input_values?: unknown }>;
}

// ── Transcription helper (replicates worker.ts's transcribeChunk) ─────────────

async function transcribeBuffer(
  pipeline: AsrPipeline,
  samples: Float32Array,
): Promise<{ text: string; elapsedMs: number }> {
  const started = performance.now();
  const features = await pipeline.processor(samples);
  const inputs = features.input_features ?? features.input_values ?? null;
  if (inputs === null) {
    throw new Error("processor returned neither input_features nor input_values");
  }
  const waveformInput =
    features.input_features === undefined && features.input_values !== undefined;
  const output = await pipeline.model.generate({
    inputs,
    // Moonshine needs an explicit generation bound (6 tokens/s of audio); Whisper does not.
    // `input_values` is the discriminator — Moonshine's extractor emits it, Whisper emits `input_features`.
    ...(waveformInput
      ? { max_new_tokens: Math.max(1, Math.floor(samples.length / SAMPLE_RATE) * 6) }
      : {}),
  });
  const first = (output as { [index: number]: { tolist?: () => number[] } })[0];
  const tokens = (first?.tolist?.() ?? []).map(Number);
  const text = pipeline.tokenizer.decode(tokens, { skip_special_tokens: true }).trim();
  return { text, elapsedMs: performance.now() - started };
}

// ── LocalAgreement helpers ───────────────────────────────────────────────────

function splitWords(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

function commonWordPrefix(a: string[], b: string[]): string[] {
  const min = Math.min(a.length, b.length);
  let i = 0;
  while (i < min && a[i] === b[i]) i++;
  return a.slice(0, i);
}

/** Longest common word prefix across the last n hypotheses. Returns [] if fewer than n. */
function localAgreementN(hypotheses: string[][], n: number): string[] {
  if (hypotheses.length < n) return [];
  const lastN = hypotheses.slice(-n);
  let common = lastN[0]!;
  for (let i = 1; i < lastN.length; i++) {
    common = commonWordPrefix(common, lastN[i]!);
  }
  return common;
}

// ── VAD driving ──────────────────────────────────────────────────────────────

interface PausePoint {
  endSample: number;
  endSeconds: number;
  utteranceSamples: Float32Array;
  utteranceSeconds: number;
}

async function driveVad(
  detector: ProbabilityDetector,
  samples: Float32Array,
): Promise<readonly PausePoint[]> {
  const vad = new StreamingVad(detector);
  const pauses: PausePoint[] = [];
  for (let i = 0; i + VAD_FRAME_SIZE <= samples.length; i += VAD_FRAME_SIZE) {
    const frame = samples.slice(i, i + VAD_FRAME_SIZE);
    const closed = await vad.feed(frame);
    for (const u of closed) {
      pauses.push({
        endSample: i + VAD_FRAME_SIZE,
        endSeconds: (i + VAD_FRAME_SIZE) / VAD_SAMPLE_RATE,
        utteranceSamples: u.samples,
        utteranceSeconds: u.samples.length / VAD_SAMPLE_RATE,
      });
    }
  }
  const flushed = await vad.flush();
  const endSample = Math.floor(samples.length / VAD_FRAME_SIZE) * VAD_FRAME_SIZE;
  for (const u of flushed) {
    pauses.push({
      endSample,
      endSeconds: endSample / VAD_SAMPLE_RATE,
      utteranceSamples: u.samples,
      utteranceSeconds: u.samples.length / VAD_SAMPLE_RATE,
    });
  }
  return pauses;
}

// ── LocalAgreement runner ────────────────────────────────────────────────────

interface PerPauseLog {
  pauseEnd: number;
  bufferSeconds: number;
  hypothesisWords: number;
  hypothesisText: string;
  newlyCommittedWords: number;
  newlyCommittedText: string;
  committedTotal: number;
  ephemeralTail: string;
  audioLag: number;
  inferenceMs: number;
  dutyCycle: number;
  forcedAdvance: boolean;
}

interface LaResult {
  committedText: string;
  log: PerPauseLog[];
  totalInferenceMs: number;
  forcedAdvances: number;
}

/**
 * Run LocalAgreement-n over the audio, using VAD pause points as the refresh cadence.
 *
 * The buffer starts at `commitSample` and grows to each pause's `endSample`. At each
 * pause, the buffer is transcribed and the hypothesis is compared with the previous n-1
 * hypotheses. When n hypotheses agree on a prefix, that prefix is committed and the
 * start advances proportionally (word-count fraction × buffer duration). After a commit,
 * hypotheses are cleared because the buffer start changed.
 *
 * When the buffer would exceed `regionCapSeconds`, the start is forced forward to keep
 * within the cap — hypotheses are cleared and the dropped audio's text is lost.
 */
async function runLocalAgreement(
  pipeline: AsrPipeline,
  samples: Float32Array,
  pauses: readonly PausePoint[],
  n: number,
  regionCapSeconds: number,
): Promise<LaResult> {
  let commitSample = 0;
  let committedWords: string[] = [];
  let hypotheses: string[][] = [];
  const log: PerPauseLog[] = [];
  const capSamples = regionCapSeconds * VAD_SAMPLE_RATE;
  let totalInferenceMs = 0;
  let forcedAdvances = 0;

  for (const pause of pauses) {
    const endSample = pause.endSample;
    let bufferStart = commitSample;
    let forcedAdvance = false;

    if (endSample - bufferStart > capSamples) {
      bufferStart = endSample - capSamples;
      commitSample = bufferStart;
      hypotheses = [];
      forcedAdvance = true;
      forcedAdvances++;
    }

    const buffer = samples.subarray(bufferStart, endSample);
    const bufferSeconds = buffer.length / VAD_SAMPLE_RATE;
    const { text, elapsedMs } = await transcribeBuffer(pipeline, buffer);
    totalInferenceMs += elapsedMs;
    const hypWords = splitWords(text);
    hypotheses.push(hypWords);

    const agreed = localAgreementN(hypotheses, n);
    let newlyCommitted: string[] = [];

    if (hypotheses.length >= n && agreed.length > 0) {
      newlyCommitted = agreed;
      committedWords = [...committedWords, ...agreed];
      // Proportional advance: estimate the audio position of the committed text.
      const fraction = hypWords.length > 0 ? agreed.length / hypWords.length : 0;
      const advance = Math.floor(fraction * (endSample - bufferStart));
      commitSample = bufferStart + advance;
      hypotheses = [];
    }

    const committedAudioEnd = commitSample / VAD_SAMPLE_RATE;
    log.push({
      pauseEnd: pause.endSeconds,
      bufferSeconds,
      hypothesisWords: hypWords.length,
      hypothesisText: text,
      newlyCommittedWords: newlyCommitted.length,
      newlyCommittedText: newlyCommitted.join(" "),
      committedTotal: committedWords.length,
      ephemeralTail: hypWords.slice(agreed.length).join(" "),
      audioLag: pause.endSeconds - committedAudioEnd,
      inferenceMs: elapsedMs,
      dutyCycle: bufferSeconds > 0 ? elapsedMs / 1000 / bufferSeconds : 0,
      forcedAdvance,
    });
  }

  return {
    committedText: committedWords.join(" "),
    log,
    totalInferenceMs,
    forcedAdvances,
  };
}

// ── Fixed-interval pause points ──────────────────────────────────────────────
//
// The production VAD (800 ms silence, 4 s minimum, 30 s cap) produces only 2 emit
// points for 54 s of continuous dictation: the 30 s cap and the flush. That is too
// few for LocalAgreement to ever agree. A fixed-interval cadence (every N seconds)
// gives the technique the frequent refresh points it needs, and tests whether
// agreement is possible at all on this audio — independent of the VAD's emit rate.

function fixedIntervalPauses(samples: Float32Array, intervalSeconds: number): PausePoint[] {
  const pauses: PausePoint[] = [];
  const intervalSamples = Math.floor(intervalSeconds * VAD_SAMPLE_RATE);
  for (let end = intervalSamples; end <= samples.length; end += intervalSamples) {
    pauses.push({
      endSample: end,
      endSeconds: end / VAD_SAMPLE_RATE,
      utteranceSamples: samples.subarray(end - intervalSamples, end),
      utteranceSeconds: intervalSeconds,
    });
  }
  if (samples.length % intervalSamples !== 0) {
    const start = Math.floor(samples.length / intervalSamples) * intervalSamples;
    if (start < samples.length) {
      pauses.push({
        endSample: samples.length,
        endSeconds: samples.length / VAD_SAMPLE_RATE,
        utteranceSamples: samples.subarray(start, samples.length),
        utteranceSeconds: (samples.length - start) / VAD_SAMPLE_RATE,
      });
    }
  }
  return pauses;
}

// ── Formatting helpers ───────────────────────────────────────────────────────

function f(n: number, decimals = 1): string {
  return n.toFixed(decimals);
}

function p(s: string | number, n: number): string {
  return String(s).padStart(n);
}

test("LocalAgreement spike: isolated vs LA-2 vs LA-3 vs batch", async () => {
  const audioBlob = await (await fetch(longWavUrl)).blob();
  const samples = await decodeTo16kMono(audioBlob);
  const audioSeconds = samples.length / SAMPLE_RATE;

  console.log(`\n${"=".repeat(72)}`);
  console.log(`LocalAgreement Spike — ${f(audioSeconds)}s audio, ${DEFAULT_MODEL_ID}`);
  console.log(`${"=".repeat(72)}`);

  // ── 1. Batch reference (production path) ───────────────────────────────────
  const recording = {
    id: "la-spike",
    capturedAt: "2026-08-12T10:00:00.000Z",
    durationMs: Math.round(audioSeconds * 1000),
    mimeType: "audio/wav",
    ctx: {},
  };
  const batchTranscriber = new OnDeviceTranscriber({
    device: "wasm",
    dtype: "fp32",
    wasmPaths: __ORT_WASM_BASE__,
    createWorker: () => new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }),
  });
  await batchTranscriber.prime();
  const batchStart = performance.now();
  const batchTranscript = await batchTranscriber.transcribe(recording, audioBlob);
  const batchElapsed = performance.now() - batchStart;
  batchTranscriber.dispose();

  console.log(`\n--- Batch reference (OnDeviceTranscriber, whole ${f(audioSeconds)}s) ---`);
  console.log(`wall: ${f(batchElapsed / 1000)}s  RTF: ${f(batchElapsed / 1000 / audioSeconds, 3)}`);
  console.log(`\n${batchTranscript.text}\n`);

  // ── 2. Load direct pipeline + VAD detector ─────────────────────────────────
  const { env, pipeline } = await import("@huggingface/transformers");
  const wasm = env.backends?.onnx?.wasm;
  if (wasm) wasm.wasmPaths = __ORT_WASM_BASE__;
  const asr = (await pipeline("automatic-speech-recognition", DEFAULT_MODEL_ID, {
    device: "wasm",
    dtype: "fp32",
  })) as unknown as AsrPipeline;

  const detector = await createSileroDetector({ wasmPaths: __ORT_WASM_BASE__ });

  // ── 3. Drive VAD to find pause points ──────────────────────────────────────
  const pauses = await driveVad(detector, samples);
  console.log(`\n--- VAD pause points (${pauses.length}) ---`);
  for (const [i, pt] of pauses.entries()) {
    console.log(`  #${i + 1}  end=${f(pt.endSeconds)}s  uttDur=${f(pt.utteranceSeconds)}s`);
  }
  expect(pauses.length).toBeGreaterThan(0);

  // ── 4. Isolated (per-utterance — what ships today) ─────────────────────────
  console.log(`\n--- Isolated (per-utterance, what ships today) ---`);
  const isolatedTexts: string[] = [];
  for (const [i, pt] of pauses.entries()) {
    const { text, elapsedMs } = await transcribeBuffer(asr, pt.utteranceSamples);
    isolatedTexts.push(text);
    console.log(`  #${i + 1}  end=${f(pt.endSeconds)}s  inf=${f(elapsedMs / 1000, 2)}s  ${text}`);
  }
  const isolatedText = isolatedTexts.filter(Boolean).join(" ").trim();
  console.log(`\n  joined: ${isolatedText}\n`);

  // ── 5. LocalAgreement-2, 30s cap (primary measurement) ─────────────────────
  const la2_30 = await runLocalAgreement(asr, samples, pauses, 2, 30);
  console.log(`\n--- LocalAgreement-2 (30s cap) ---`);
  console.log(
    `  #  end    bufSec  hypW  newCmt  cmtTot  lag    infMs   duty   forced | hypothesis`,
  );
  for (const [i, e] of la2_30.log.entries()) {
    console.log(
      `  ${p(i + 1, 2)}  ${p(f(e.pauseEnd), 5)}  ${p(f(e.bufferSeconds), 5)}  ${p(e.hypothesisWords, 4)}  ${p(e.newlyCommittedWords, 6)}  ${p(e.committedTotal, 6)}  ${p(f(e.audioLag), 5)}  ${p(e.inferenceMs, 6)}  ${p(f(e.dutyCycle, 3), 5)}  ${e.forcedAdvance ? "YES" : " no"}   | ${e.hypothesisText}`,
    );
    if (e.newlyCommittedWords > 0) {
      console.log(`       + committed: "${e.newlyCommittedText}"`);
    }
    if (e.ephemeralTail) {
      console.log(`       ~ ephemeral:  "${e.ephemeralTail}"`);
    }
  }
  console.log(`\n  committed text (${splitWords(la2_30.committedText).length} words):`);
  console.log(`  ${la2_30.committedText}`);
  console.log(
    `  total inference: ${f(la2_30.totalInferenceMs / 1000)}s  forced advances: ${la2_30.forcedAdvances}`,
  );

  // ── 6. LocalAgreement-2, 15s cap (cost comparison) ─────────────────────────
  const la2_15 = await runLocalAgreement(asr, samples, pauses, 2, 15);
  console.log(`\n--- LocalAgreement-2 (15s cap) ---`);
  console.log(
    `  #  end    bufSec  hypW  newCmt  cmtTot  lag    infMs   duty   forced | hypothesis`,
  );
  for (const [i, e] of la2_15.log.entries()) {
    console.log(
      `  ${p(i + 1, 2)}  ${p(f(e.pauseEnd), 5)}  ${p(f(e.bufferSeconds), 5)}  ${p(e.hypothesisWords, 4)}  ${p(e.newlyCommittedWords, 6)}  ${p(e.committedTotal, 6)}  ${p(f(e.audioLag), 5)}  ${p(e.inferenceMs, 6)}  ${p(f(e.dutyCycle, 3), 5)}  ${e.forcedAdvance ? "YES" : " no"}   | ${e.hypothesisText}`,
    );
    if (e.newlyCommittedWords > 0) {
      console.log(`       + committed: "${e.newlyCommittedText}"`);
    }
  }
  console.log(`\n  committed text (${splitWords(la2_15.committedText).length} words):`);
  console.log(`  ${la2_15.committedText}`);
  console.log(
    `  total inference: ${f(la2_15.totalInferenceMs / 1000)}s  forced advances: ${la2_15.forcedAdvances}`,
  );

  // ── 7. LocalAgreement-3, 30s cap ──────────────────────────────────────────
  const la3_30 = await runLocalAgreement(asr, samples, pauses, 3, 30);
  console.log(`\n--- LocalAgreement-3 (30s cap) ---`);
  console.log(
    `  #  end    bufSec  hypW  newCmt  cmtTot  lag    infMs   duty   forced | hypothesis`,
  );
  for (const [i, e] of la3_30.log.entries()) {
    console.log(
      `  ${p(i + 1, 2)}  ${p(f(e.pauseEnd), 5)}  ${p(f(e.bufferSeconds), 5)}  ${p(e.hypothesisWords, 4)}  ${p(e.newlyCommittedWords, 6)}  ${p(e.committedTotal, 6)}  ${p(f(e.audioLag), 5)}  ${p(e.inferenceMs, 6)}  ${p(f(e.dutyCycle, 3), 5)}  ${e.forcedAdvance ? "YES" : " no"}   | ${e.hypothesisText}`,
    );
    if (e.newlyCommittedWords > 0) {
      console.log(`       + committed: "${e.newlyCommittedText}"`);
    }
    if (e.ephemeralTail) {
      console.log(`       ~ ephemeral:  "${e.ephemeralTail}"`);
    }
  }
  console.log(`\n  committed text (${splitWords(la3_30.committedText).length} words):`);
  console.log(`  ${la3_30.committedText}`);
  console.log(
    `  total inference: ${f(la3_30.totalInferenceMs / 1000)}s  forced advances: ${la3_30.forcedAdvances}`,
  );

  // ── 7b. Fixed-interval refresh (every 5s) ──────────────────────────────────
  //
  // The production VAD produced only 2 pause points for 54 s of continuous dictation
  // (the 30 s cap and the flush). LocalAgreement never had enough hypotheses to agree.
  // A 5 s fixed-interval cadence gives ~11 refresh points — enough for LA-2 to compare
  // consecutive hypotheses over a growing buffer. This tests whether the technique
  // works at all on this audio, independent of the VAD's emit rate.
  const fixedPauses = fixedIntervalPauses(samples, 5);
  console.log(`\n--- Fixed-interval pause points (every 5s, ${fixedPauses.length}) ---`);
  for (const [i, pt] of fixedPauses.entries()) {
    console.log(`  #${i + 1}  end=${f(pt.endSeconds)}s`);
  }

  // LA-2 with fixed-interval, 30s cap
  const la2_fix30 = await runLocalAgreement(asr, samples, fixedPauses, 2, 30);
  console.log(`\n--- LocalAgreement-2, fixed 5s interval (30s cap) ---`);
  console.log(
    `  #  end    bufSec  hypW  newCmt  cmtTot  lag    infMs   duty   forced | hypothesis`,
  );
  for (const [i, e] of la2_fix30.log.entries()) {
    console.log(
      `  ${p(i + 1, 2)}  ${p(f(e.pauseEnd), 5)}  ${p(f(e.bufferSeconds), 5)}  ${p(e.hypothesisWords, 4)}  ${p(e.newlyCommittedWords, 6)}  ${p(e.committedTotal, 6)}  ${p(f(e.audioLag), 5)}  ${p(e.inferenceMs, 6)}  ${p(f(e.dutyCycle, 3), 5)}  ${e.forcedAdvance ? "YES" : " no"}   | ${e.hypothesisText}`,
    );
    if (e.newlyCommittedWords > 0) {
      console.log(`       + committed: "${e.newlyCommittedText}"`);
    }
    if (e.ephemeralTail) {
      console.log(`       ~ ephemeral:  "${e.ephemeralTail}"`);
    }
  }
  console.log(`\n  committed text (${splitWords(la2_fix30.committedText).length} words):`);
  console.log(`  ${la2_fix30.committedText}`);
  console.log(
    `  total inference: ${f(la2_fix30.totalInferenceMs / 1000)}s  forced advances: ${la2_fix30.forcedAdvances}`,
  );

  // LA-2 with fixed-interval, 15s cap
  const la2_fix15 = await runLocalAgreement(asr, samples, fixedPauses, 2, 15);
  console.log(`\n--- LocalAgreement-2, fixed 5s interval (15s cap) ---`);
  console.log(
    `  #  end    bufSec  hypW  newCmt  cmtTot  lag    infMs   duty   forced | hypothesis`,
  );
  for (const [i, e] of la2_fix15.log.entries()) {
    console.log(
      `  ${p(i + 1, 2)}  ${p(f(e.pauseEnd), 5)}  ${p(f(e.bufferSeconds), 5)}  ${p(e.hypothesisWords, 4)}  ${p(e.newlyCommittedWords, 6)}  ${p(e.committedTotal, 6)}  ${p(f(e.audioLag), 5)}  ${p(e.inferenceMs, 6)}  ${p(f(e.dutyCycle, 3), 5)}  ${e.forcedAdvance ? "YES" : " no"}   | ${e.hypothesisText}`,
    );
    if (e.newlyCommittedWords > 0) {
      console.log(`       + committed: "${e.newlyCommittedText}"`);
    }
  }
  console.log(`\n  committed text (${splitWords(la2_fix15.committedText).length} words):`);
  console.log(`  ${la2_fix15.committedText}`);
  console.log(
    `  total inference: ${f(la2_fix15.totalInferenceMs / 1000)}s  forced advances: ${la2_fix15.forcedAdvances}`,
  );

  // LA-3 with fixed-interval, 30s cap
  const la3_fix30 = await runLocalAgreement(asr, samples, fixedPauses, 3, 30);
  console.log(`\n--- LocalAgreement-3, fixed 5s interval (30s cap) ---`);
  console.log(
    `  #  end    bufSec  hypW  newCmt  cmtTot  lag    infMs   duty   forced | hypothesis`,
  );
  for (const [i, e] of la3_fix30.log.entries()) {
    console.log(
      `  ${p(i + 1, 2)}  ${p(f(e.pauseEnd), 5)}  ${p(f(e.bufferSeconds), 5)}  ${p(e.hypothesisWords, 4)}  ${p(e.newlyCommittedWords, 6)}  ${p(e.committedTotal, 6)}  ${p(f(e.audioLag), 5)}  ${p(e.inferenceMs, 6)}  ${p(f(e.dutyCycle, 3), 5)}  ${e.forcedAdvance ? "YES" : " no"}   | ${e.hypothesisText}`,
    );
    if (e.newlyCommittedWords > 0) {
      console.log(`       + committed: "${e.newlyCommittedText}"`);
    }
    if (e.ephemeralTail) {
      console.log(`       ~ ephemeral:  "${e.ephemeralTail}"`);
    }
  }
  console.log(`\n  committed text (${splitWords(la3_fix30.committedText).length} words):`);
  console.log(`  ${la3_fix30.committedText}`);
  console.log(
    `  total inference: ${f(la3_fix30.totalInferenceMs / 1000)}s  forced advances: ${la3_fix30.forcedAdvances}`,
  );

  // ── 8. Reproducibility: same buffer transcribed twice ──────────────────────
  // The whole technique rests on hypotheses agreeing. If the same audio produces
  // different text on re-transcription, agreement is a matter of luck.
  const reprSeconds = Math.min(15, audioSeconds);
  const reprBuffer = samples.subarray(0, Math.floor(reprSeconds * SAMPLE_RATE));
  const { text: repr1, elapsedMs: repr1Ms } = await transcribeBuffer(asr, reprBuffer);
  const { text: repr2, elapsedMs: repr2Ms } = await transcribeBuffer(asr, reprBuffer);
  const reprW1 = splitWords(repr1);
  const reprW2 = splitWords(repr2);
  const reprSame = repr1 === repr2;
  const reprCommon = commonWordPrefix(reprW1, reprW2);

  console.log(`\n--- Reproducibility: same ${f(reprSeconds)}s buffer transcribed twice ---`);
  console.log(`  pass1 (${f(repr1Ms / 1000, 2)}s): ${repr1}`);
  console.log(`  pass2 (${f(repr2Ms / 1000, 2)}s): ${repr2}`);
  console.log(`  identical: ${reprSame}`);
  console.log(`  common prefix: ${reprCommon.length} / ${reprW1.length} words`);
  if (!reprSame) {
    console.log(`  word-level differences:`);
    for (let i = 0; i < Math.max(reprW1.length, reprW2.length); i++) {
      if (reprW1[i] !== reprW2[i]) {
        console.log(`    word ${i + 1}: "${reprW1[i] ?? "<none>"}" vs "${reprW2[i] ?? "<none>"}"`);
      }
    }
  }

  // Also check a longer buffer (30s)
  const repr30Len = Math.min(30 * SAMPLE_RATE, samples.length);
  const repr30Buf = samples.subarray(0, repr30Len);
  const { text: r30a } = await transcribeBuffer(asr, repr30Buf);
  const { text: r30b } = await transcribeBuffer(asr, repr30Buf);
  const r30w1 = splitWords(r30a);
  const r30w2 = splitWords(r30b);
  const r30Same = r30a === r30b;
  const r30Common = commonWordPrefix(r30w1, r30w2);

  console.log(`\n--- Reproducibility: same 30s buffer transcribed twice ---`);
  console.log(`  pass1: ${r30a}`);
  console.log(`  pass2: ${r30b}`);
  console.log(`  identical: ${r30Same}`);
  console.log(`  common prefix: ${r30Common.length} / ${r30w1.length} words`);
  if (!r30Same) {
    console.log(`  word-level differences:`);
    for (let i = 0; i < Math.max(r30w1.length, r30w2.length); i++) {
      if (r30w1[i] !== r30w2[i]) {
        console.log(`    word ${i + 1}: "${r30w1[i] ?? "<none>"}" vs "${r30w2[i] ?? "<none>"}"`);
      }
    }
  }

  // Cross-call non-determinism: transcribe the same 30s buffer that was transcribed
  // earlier in the LA-2 VAD run, and compare. The LA-2 run's first hypothesis and the
  // reproducibility check above may differ despite being the same audio — ORT WASM
  // can produce different results depending on what ran before.
  const { text: cross30 } = await transcribeBuffer(asr, repr30Buf);
  const cross30W = splitWords(cross30);
  const crossSameAsRepr = cross30 === r30a;
  const crossSameAsLa2 = la2_30.log[0]?.hypothesisText === cross30;
  console.log(`\n--- Cross-call non-determinism: same 30s buffer at different points ---`);
  console.log(`  LA-2 VAD run (early):    ${la2_30.log[0]?.hypothesisText ?? "<none>"}`);
  console.log(`  reproducibility (late):  ${r30a}`);
  console.log(`  this call (later still): ${cross30}`);
  console.log(`  matches reproducibility: ${crossSameAsRepr}`);
  console.log(`  matches LA-2 VAD run:    ${crossSameAsLa2}`);
  const crossCommonLa2 = commonWordPrefix(
    splitWords((la2_30.log[0]?.hypothesisText ?? "").toLowerCase()),
    cross30W.map((w) => w.toLowerCase()),
  );
  console.log(
    `  common prefix vs LA-2: ${crossCommonLa2.length} / ${splitWords(la2_30.log[0]?.hypothesisText ?? "").length} words`,
  );

  // ── 9. Cost summary ────────────────────────────────────────────────────────
  console.log(`\n--- Cost summary: duty cycle across configs ---`);
  console.log(`  config              totalInf   avgDuty  maxDuty  forced  committedWords`);
  for (const { label, res } of [
    { label: "VAD 30s", res: la2_30 },
    { label: "VAD 15s", res: la2_15 },
    { label: "fixed5s 30s", res: la2_fix30 },
    { label: "fixed5s 15s", res: la2_fix15 },
  ]) {
    const duties = res.log.map((e) => e.dutyCycle);
    const avgDuty = duties.reduce((a, b) => a + b, 0) / duties.length;
    const maxDuty = Math.max(...duties);
    console.log(
      `  ${label.padEnd(18)}  ${p(f(res.totalInferenceMs / 1000), 7)}s  ${p(f(avgDuty, 3), 7)}  ${p(f(maxDuty, 3), 7)}  ${p(res.forcedAdvances, 6)}  ${splitWords(res.committedText).length}`,
    );
  }

  // ── 10. Side-by-side transcript comparison ─────────────────────────────────
  console.log(`\n--- Side-by-side transcript comparison ---`);
  console.log(`  BATCH:          ${batchTranscript.text}`);
  console.log(`  ISOLATED:       ${isolatedText}`);
  console.log(`  LA-2 VAD 30s:   ${la2_30.committedText}`);
  console.log(`  LA-2 fixed 30s: ${la2_fix30.committedText}`);
  console.log(`  LA-3 VAD 30s:   ${la3_30.committedText}`);
  console.log(`  LA-3 fixed 30s: ${la3_fix30.committedText}`);

  // ── 11. Committed text check: LA-2 fixed-interval vs batch ─────────────────
  const batchWords = splitWords(batchTranscript.text.toLowerCase());
  const la2FixWords = splitWords(la2_fix30.committedText.toLowerCase());
  console.log(`\n--- Committed text check: LA-2 fixed 30s vs batch (case-insensitive) ---`);
  let mismatches = 0;
  for (let i = 0; i < la2FixWords.length; i++) {
    if (batchWords[i] !== la2FixWords[i]) {
      mismatches++;
      console.log(
        `  word ${i + 1}: committed "${la2FixWords[i]}" vs batch "${batchWords[i] ?? "<none>"}"`,
      );
    }
  }
  if (mismatches === 0) {
    console.log(
      `  All ${la2FixWords.length} committed words match the batch reference at the same position.`,
    );
  } else {
    console.log(`  ${mismatches} mismatch(es) out of ${la2FixWords.length} committed words.`);
  }

  // ── 12. LA-2 vs LA-3 comparison (fixed-interval) ───────────────────────────
  const la2w = splitWords(la2_fix30.committedText.toLowerCase());
  const la3w = splitWords(la3_fix30.committedText.toLowerCase());
  console.log(`\n--- LA-2 vs LA-3 committed text comparison (fixed 5s, 30s cap) ---`);
  console.log(`  LA-2: ${la2w.length} words`);
  console.log(`  LA-3: ${la3w.length} words`);
  const laCommon = commonWordPrefix(la2w, la3w);
  console.log(`  common prefix: ${laCommon.length} words`);
  if (la2w.length !== la3w.length || laCommon.length !== la2w.length) {
    console.log(`  differences:`);
    for (let i = 0; i < Math.max(la2w.length, la3w.length); i++) {
      if (la2w[i] !== la3w[i]) {
        console.log(
          `    word ${i + 1}: LA-2 "${la2w[i] ?? "<none>"}" vs LA-3 "${la3w[i] ?? "<none>"}"`,
        );
      }
    }
  }

  // ── Sanity assertions ──────────────────────────────────────────────────────
  expect(batchTranscript.text.length).toBeGreaterThan(200);
  expect(pauses.length).toBeGreaterThan(0);
  expect(isolatedText.length).toBeGreaterThan(0);
}, 600_000);
