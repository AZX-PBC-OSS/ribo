import { expect, test } from "vitest";

import { decodeTo16kMono } from "../../packages/ribo-transcriber-ondevice/src/index.js";

/**
 * Live-model comparison spike (browser half) — **is Whisper's fixed window the latency floor it
 * looks like, and does Moonshine escape it?**
 *
 * MANUAL, OPT-IN. Runs only under `vitest.compare.config.ts`, driven by `run.mjs`.
 *
 * ## The measurement, and why it can falsify the hypothesis
 *
 * `docs/roadmap/design/live-transcription-design.md` §What "live" actually costs asserts that every
 * live utterance costs a **full 30-second encoder pass** regardless of its length, because
 * `WhisperFeatureExtractor` pads to `n_samples`. Moonshine's feature extractor does not — it passes
 * `[1, audio.length]` straight through.
 *
 * If that reasoning is right, plotting latency against utterance duration gives:
 *
 *   - **Whisper: flat.** A 2-second clip costs what a 29-second clip costs.
 *   - **Moonshine: rising.** Cost tracks actual audio.
 *
 * A flat Moonshine line falsifies it and the ASR swap buys nothing for live. A rising Whisper line
 * means the padding claim — which this repo has already been wrong about once, in the opposite
 * direction, when `_generate_with_seek` looked reachable and was not — is wrong again.
 *
 * **This is deliberately not routed through `OnDeviceTranscriber`.** That class is Whisper-shaped:
 * it injects a jargon prefix into `decoder_input_ids` and slices it back off, which Moonshine has no
 * equivalent for. Comparing through it would measure our wrapper, not the models. Both models are
 * driven through the same bare `pipeline()` call here, so the only difference is the model.
 *
 * That has a consequence worth stating plainly: **hints are off for both.** The hinted-vs-unhinted
 * WER delta is real (`docs/implementation/14`), so the WER figures here are not comparable to that
 * document's — only to each other.
 */
declare const __ORT_WASM_BASE__: string;
declare const __FIXTURE_URL__: string;
declare const __MODELS__: string;
declare const __DURATIONS__: string;
declare const __REPEATS__: string;

interface Timing {
  model: string;
  durationSec: number;
  /** Wall-clock ms for one `asr(samples)` call. */
  ms: number;
  run: number;
}

/** Emitted for `run.mjs` to capture off stdout, one JSON object per line. */
function emit(tag: string, payload: unknown): void {
  console.log(`@@${tag}@@${JSON.stringify(payload)}`);
}

test("latency against utterance length, per model", async () => {
  const { pipeline, env } = await import("@huggingface/transformers");
  const wasm = env.backends?.onnx?.wasm;
  if (wasm) wasm.wasmPaths = __ORT_WASM_BASE__;

  const models = __MODELS__.split(",").filter(Boolean);
  const durations = __DURATIONS__.split(",").map(Number).filter(Boolean);
  const repeats = Number(__REPEATS__) || 3;

  // The fixture is a gitignored WAV (`.gitignore`: `**/testdata/*.wav`), so a git worktree does not
  // have it and the dev server answers with a 404 page. Decoding that yields `EncodingError: Unable
  // to decode audio data`, which says nothing about the actual problem. Check the response instead.
  const response = await fetch(__FIXTURE_URL__);
  if (!response.ok || !/audio|octet-stream/.test(response.headers.get("content-type") ?? "")) {
    throw new Error(
      `The audio fixture is not being served (HTTP ${String(response.status)}). It is gitignored, ` +
        `so a fresh worktree does not have it — copy it from the main checkout:\n` +
        `  cp <main-checkout>/packages/ribo-transcriber-ondevice/testdata/*.wav ` +
        `packages/ribo-transcriber-ondevice/testdata/`,
    );
  }
  const full = await decodeTo16kMono(await response.blob());
  const fullSeconds = full.length / 16_000;
  // Guards the premise: every duration must be a real slice of this fixture, and the longest must
  // stay under Whisper's 30 s window so both models make exactly ONE call. A duration past the
  // window would silently compare one Whisper call against several Moonshine ones.
  expect(fullSeconds).toBeGreaterThan(Math.max(...durations));
  expect(Math.max(...durations)).toBeLessThan(30);

  const timings: Timing[] = [];

  for (const model of models) {
    const coldStart = performance.now();
    const asr = await pipeline("automatic-speech-recognition", model, {
      device: "wasm",
      // fp32 only: `docs/implementation/14` records that q4/q8 do not load on the pinned ORT build.
      // Comparing a q4 Moonshine against an fp32 Whisper would confound quantization with
      // architecture, which is the one thing this spike exists to separate.
      dtype: "fp32",
    });
    const loadMs = performance.now() - coldStart;
    emit("LOAD", { model, loadMs });

    // One untimed call before the timed ones. The first inference of a session pays for ORT graph
    // setup and buffer allocation, and folding that into the 2-second bucket would manufacture
    // exactly the falling curve a reader would mistake for "short clips are disproportionately
    // expensive".
    await asr(full.slice(0, 16_000 * 2));

    for (const durationSec of durations) {
      const samples = full.slice(0, Math.round(16_000 * durationSec));
      let text = "";
      for (let run = 0; run < repeats; run++) {
        const started = performance.now();
        const out = (await asr(samples)) as { text: string };
        const ms = performance.now() - started;
        timings.push({ model, durationSec, ms, run });
        text = out.text;
      }
      // Speed is worthless without the text it produced. Live utterances are 2-8 s, so quality AT
      // THAT LENGTH is the question — a model can be accurate on a 30 s clip and useless on 3 s, or
      // the reverse. Emitting only the full-fixture transcript would have measured the wrong thing.
      emit("TEXT", { model, durationSec, text });
    }

    // The full fixture, for an RTF figure comparable to `long-audio.manual.ts`'s 0.158. Whisper
    // TRUNCATES this to 30 s (see `feature_extraction_whisper.js`), so its transcript here is
    // deliberately incomplete and its RTF is not comparable to Moonshine's — recorded so the text
    // shows the truncation rather than leaving a reader to assume parity.
    const fullStart = performance.now();
    const out = (await asr(full)) as { text: string };
    const fullMs = performance.now() - fullStart;
    emit("FULL", {
      model,
      fullMs,
      audioSec: fullSeconds,
      rtf: fullMs / 1000 / fullSeconds,
      text: out.text,
    });

    await asr.dispose?.();
  }

  emit("TIMINGS", timings);

  // The assertion is only that every cell ran. The comparison itself is a judgement a human makes
  // from the table `run.mjs` prints — a threshold here would be inventing a pass mark for a
  // question nobody has answered yet.
  expect(timings).toHaveLength(models.length * durations.length * repeats);
});
