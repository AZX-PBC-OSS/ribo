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

  // eslint-disable-next-line no-console
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

  // Reaches the END of the clip. The fixture's closing sentence is about wall
  // insulation; truncation at 30 s cuts off around the furnace. This is the assertion
  // the whole feature exists to satisfy and nothing else in the repo makes it.
  expect(transcript.text.toLowerCase()).toMatch(/wall/);
  // And the MIDDLE, because a seam that silently drops a segment would still pass an
  // ends-only check.
  expect(transcript.text.toLowerCase()).toMatch(/attic|insulation/);
  // The prefix is sliced off, not decoded.
  expect(transcript.text.toLowerCase()).not.toContain(SENTINEL);
});

test("COMPARISON: the library's own seek loop, for the delete-the-VAD-layer decision", async () => {
  // Drives `model.generate` directly with `return_timestamps: true` and no
  // `max_new_tokens`, which is the condition `generate()` uses to enter
  // `_generate_with_seek`. Everything else matches what `transcribeChunk` does.
  //
  // Not asserted against the VAD path's exact text — two decoders will differ in
  // punctuation and that is not a defect. What matters is whether this reaches the end
  // of the clip, keeps the jargon bias, and does not leak the prefix. If it does all
  // three, the hand-rolled layer is redundant.
  const { pipeline, env } = await import("@huggingface/transformers");
  const wasm = env.backends?.onnx?.wasm;
  if (wasm) wasm.wasmPaths = __ORT_WASM_BASE__;

  const asr = await pipeline("automatic-speech-recognition", MODEL, {
    device: "wasm",
    dtype: "fp32",
  });
  const audio = await (await fetch(longWavUrl)).blob();
  const samples = await decodeTo16kMono(audio);

  const tokenizer = (asr as unknown as { tokenizer: { encode(t: string, o?: object): number[] } })
    .tokenizer;
  const model = (
    asr as unknown as {
      model: {
        generation_config?: { decoder_start_token_id?: number };
        generate(i: Record<string, unknown>): Promise<unknown>;
      };
    }
  ).model;
  const processor = (
    asr as unknown as { processor(a: Float32Array): Promise<{ input_features: unknown }> }
  ).processor;

  // The same prefix `buildDecoderPrefix` builds, MINUS `<|notimestamps|>`: the seek loop
  // is timestamp-driven, so suppressing timestamps is what would keep it from working.
  const sot = model.generation_config?.decoder_start_token_id;
  const prefix = [
    ...tokenizer.encode("<|startofprev|>", { add_special_tokens: false }),
    ...tokenizer.encode(` ${[...VOCABULARY, SENTINEL].join(", ")}`, { add_special_tokens: false }),
    ...(sot == null ? [] : [sot]),
  ];

  const started = performance.now();
  const { input_features } = await processor(samples);
  const output = await model.generate({
    inputs: input_features,
    decoder_input_ids: prefix,
    return_timestamps: true,
  });
  const elapsed = performance.now() - started;

  const ids = (output as { sequences?: { tolist(): number[][] } }).sequences?.tolist()[0] ?? [];
  const text = (tokenizer as unknown as { decode(i: number[], o?: object): string }).decode(ids, {
    skip_special_tokens: true,
  });

  const audioSeconds = samples.length / 16_000;
  // eslint-disable-next-line no-console
  console.log(
    [
      "",
      "── library seek loop (_generate_with_seek) ───────────────────────",
      `audio ${audioSeconds.toFixed(1)}s · wall ${(elapsed / 1000).toFixed(1)}s · RTF ${(elapsed / 1000 / audioSeconds).toFixed(3)}`,
      `tokens ${ids.length}`,
      "",
      text.trim(),
      "",
      "DECIDE: does this reach the end of the clip, keep the jargon, and not leak the",
      "sentinel? If yes, segmentation.ts and the 6 MB VAD model are redundant.",
      "",
    ].join("\n"),
  );

  expect(text.length).toBeGreaterThan(0);
});
