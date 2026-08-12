import { expect, test } from "vitest";

import longWavUrl from "../testdata/energy-audit-long-48k-mono.wav?url";
import { decodeTo16kMono, OnDeviceTranscriber } from "./index.js";

/**
 * OPT-IN, NOT GATED. Runs only under `vitest.manual.config.ts` — never in `./check.sh`.
 *
 *   pnpm exec vitest run --config packages/ribo-transcriber-ondevice/vitest.manual.config.ts \
 *     packages/ribo-transcriber-ondevice/src/long-audio.manual.ts
 *
 * ## Why this file exists
 *
 * **The >30 s transcription path has never been executed.** `planChunks` ships a VAD
 * segmentation layer for audio past Whisper's receptive field, and every automated test
 * that reaches it takes either the <=30 s bypass or the VAD-failed-to-load fallback. The
 * only real-inference test uses an 11 s clip. So the advertised RTF and WER describe a
 * code path that no longer runs for exactly the recordings the feature was built for,
 * and a 54 s fixture sat in `testdata/` referenced by nothing.
 *
 * This runs the real model over that fixture and answers two questions.
 *
 * ## The second question may delete the feature
 *
 * transformers.js 4.2.0 — the pinned version — already implements long-form
 * transcription in `WhisperForConditionalGeneration._generate_with_seek`: a timestamp-
 * driven seek loop over the whole spectrogram. The stated reason for hand-rolling VAD
 * segmentation instead was that the library's path would decode our injected jargon
 * prefix and leak it into the transcript. **Reading the source, that is not true of the
 * seek loop**: it passes `decoder_input_ids: init_tokens` into every segment and then
 * `slice(init_tokens.length)` off the result — the identical inject-then-slice trick
 * `transcribeChunk` performs by hand (`modeling_whisper.js`, the `_generate_with_seek`
 * body).
 *
 * If that holds in practice, ~360 lines of `segmentation.ts` plus a 6 MB second model
 * plus a VAD pre-pass over the whole recording are all replaceable by two generation
 * flags. This test is the evidence for that decision, and it is deliberately a
 * comparison rather than an assertion: print both transcripts and let a human read them.
 */
declare const __ORT_WASM_BASE__: string;

const MODEL = "Xenova/whisper-base.en";
const VOCABULARY = ["R-value", "CFM50", "AFUE", "blower door", "backdrafting", "ACH50", "flue"];

/**
 * A word that appears ONLY in the hint vocabulary and is never spoken in the fixture.
 * Asserting that real jargon is absent would be invalid — Whisper may legitimately
 * transcribe it, and may even regenerate primed terms over silence — so leak detection
 * needs a sentinel that cannot arrive any other way.
 */
const SENTINEL = "zorbulator";

const recording = {
  id: "manual-long",
  capturedAt: "2026-08-10T10:00:00.000Z",
  durationMs: 0,
  mimeType: "audio/wav",
  ctx: {},
};

function makeTranscriber(hints?: { vocabulary: string[] }): OnDeviceTranscriber {
  return new OnDeviceTranscriber({
    modelId: MODEL,
    device: "wasm",
    dtype: "fp32",
    ...(hints ? { hints } : {}),
    wasmPaths: __ORT_WASM_BASE__,
    createWorker: () => new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }),
  });
}

test("the VAD path transcribes a 54 s clip in full, with hints and without leaking them", async () => {
  const audio = await (await fetch(longWavUrl)).blob();
  const audioSeconds = (await decodeTo16kMono(audio)).length / 16_000;
  expect(audioSeconds).toBeGreaterThan(30); // or this file is testing the bypass

  const transcriber = makeTranscriber({ vocabulary: [...VOCABULARY, SENTINEL] });
  await transcriber.prime();
  const started = performance.now();
  const transcript = await transcriber.transcribe(recording, audio);
  const elapsed = performance.now() - started;
  transcriber.dispose();

  console.log(
    [
      "",
      "── VAD segmentation path ─────────────────────────────────────────",
      `audio ${audioSeconds.toFixed(1)}s · wall ${(elapsed / 1000).toFixed(1)}s · RTF ${(elapsed / 1000 / audioSeconds).toFixed(3)}`,
      "",
      transcript.text,
      "",
    ].join("\n"),
  );

  // Reaches the END of the clip — truncation at 30 s cuts off around the furnace, so
  // anything from the windows sentence onward proves the whole recording was seen. This
  // is the assertion the feature exists to satisfy and nothing else in the repo makes it.
  //
  // Anchored on "south elevation" rather than the fixture's final word: the closing
  // sentence is "WALL insulation is rated well throughout" and whisper-base.en hears
  // "while insulation". A brittle anchor made this fail on a transcription error the
  // first time it ran, which proves nothing about coverage.
  expect(transcript.text.toLowerCase()).toMatch(/south elevation/);
  // And the MIDDLE, because a seam that silently dropped a segment would still pass an
  // ends-only check.
  expect(transcript.text.toLowerCase()).toMatch(/blown cellulose|joist/);
  // The prefix is sliced off, not decoded.
  expect(transcript.text.toLowerCase()).not.toContain(SENTINEL);
});

test("the library's seek loop is UNREACHABLE through the standard processor", async () => {
  // MEASURED NEGATIVE RESULT, and the reason the VAD layer stays.
  //
  // `WhisperForConditionalGeneration._generate_with_seek` really does implement long-form
  // transcription, and it really does carry an injected decoder prefix safely — it passes
  // `decoder_input_ids: init_tokens` into every segment and slices `init_tokens.length`
  // off the result, the same inject-then-slice `transcribeChunk` does by hand. Reading
  // that, it looks like ~360 lines of `segmentation.ts` plus a 6 MB VAD model could be
  // replaced by two generation flags.
  //
  // They cannot, and this test records why. The seek loop derives its work from
  // `input_features.dims[2]`, but **`WhisperFeatureExtractor` truncates the waveform to
  // `n_samples` before producing features** (`feature_extraction_whisper.js`:
  // `waveform = audio.slice(0, length)`, with the "longer than 30 seconds" warning right
  // above it). So a spectrogram built through `processor()` is always exactly one
  // segment, the seek loop iterates once, and everything past 30 s is already gone before
  // `generate` is called. Reaching it would mean building a full-length mel spectrogram
  // ourselves — strictly more work than the layer it would replace.
  //
  // This ran and failed with `token_ids must be a non-empty array of integers` after
  // emitting that truncation warning, which is what a one-segment seek over truncated
  // input looks like from the outside.
  const { pipeline, env } = await import("@huggingface/transformers");
  const wasm = env.backends?.onnx?.wasm;
  if (wasm) wasm.wasmPaths = __ORT_WASM_BASE__;

  const asr = await pipeline("automatic-speech-recognition", MODEL, {
    device: "wasm",
    dtype: "fp32",
  });
  const samples = await decodeTo16kMono(await (await fetch(longWavUrl)).blob());
  const processor = (
    asr as unknown as {
      processor(a: Float32Array): Promise<{ input_features: { dims: number[] } }>;
    }
  ).processor;

  const { input_features } = await processor(samples);
  const framesPerSegment = 3000; // input_stride (2) x max_source_positions (1500)

  // The whole finding, as one assertion: 54 s of audio yields ONE segment of features.
  expect(input_features.dims[2]).toBe(framesPerSegment);
  expect(samples.length / 16_000).toBeGreaterThan(30);
});
