import { expect, test } from "vitest";

import longWavUrl from "../testdata/energy-audit-long-48k-mono.wav?url";
import { decodeTo16kMono } from "./index.js";

/**
 * OPT-IN, NOT GATED. Runs only under `vitest.manual.config.ts` — never in `./check.sh`.
 *
 *   pnpm exec vitest run --config packages/ribo-transcriber-ondevice/vitest.manual.config.ts \
 *     packages/ribo-transcriber-ondevice/src/moonshine-priming.manual.ts
 *
 * ## The one question that decides whether swapping to Moonshine costs us a feature
 *
 * `config.ts` says domain-jargon priming is "the decisive reason Whisper was chosen over
 * Moonshine/Parakeet: those expose no biasing hook." That claim is about the *documented API* — and
 * our own priming is not a documented API either. It is a `decoder_input_ids` prefix, and
 * `MoonshineForConditionalGeneration` declares `forward_params = ['input_values',
 * 'decoder_input_ids', 'past_key_values']`. So the mechanism is reachable.
 *
 * **Reachable is not the same as working**, and the difference is a trained token. Whisper accepts
 * prior context because `<|startofprev|>` was trained for exactly that: the jargon sits in a region
 * the model learned to condition on and not emit. If Moonshine has no equivalent, the same prefix
 * makes the decoder simply *continue* it — the jargon lands in the transcript, which is a corruption,
 * not a bias.
 *
 * This test settles which, using the sentinel technique from `long-audio.manual.ts`: a word that
 * appears ONLY in the hint list and is never spoken. Asserting real jargon is absent would be invalid
 * (Whisper may legitimately transcribe it), so leak detection needs a token that cannot arrive any
 * other way.
 */
declare const __ORT_WASM_BASE__: string;

const MODEL = "onnx-community/moonshine-base-ONNX";

/** Never spoken in the fixture; can only reach the output by leaking from the prefix. */
const SENTINEL = "zorbulator";
const VOCABULARY = ["R-value", "CFM50", "ACH50", "blower door", "backdrafting", SENTINEL];

test("does a decoder prefix prime Moonshine, or leak into its output?", async () => {
  const { pipeline, AutoTokenizer, env } = await import("@huggingface/transformers");
  const wasm = env.backends?.onnx?.wasm;
  if (wasm) wasm.wasmPaths = __ORT_WASM_BASE__;

  const tokenizer = await AutoTokenizer.from_pretrained(MODEL);

  // Whisper's prefix is bracketed by trained control tokens. If Moonshine has no analogue, there is
  // no region the decoder was taught to read-but-not-emit, and that alone predicts a leak. Report
  // what the vocabulary actually contains rather than assuming either way.
  const specials = (tokenizer.all_special_tokens as string[] | undefined) ?? [];
  const priorContextLike = specials.filter((t) => /prev|context|prompt/i.test(t));
  console.log("Moonshine all_special_tokens:", JSON.stringify(specials));
  console.log("prior-context-like tokens:", JSON.stringify(priorContextLike));

  const asr = await pipeline("automatic-speech-recognition", MODEL, {
    device: "wasm",
    dtype: "fp32",
  });

  // A 10-second slice: long enough to contain real jargon (the blower-door reading), short enough
  // that a leak is obvious rather than buried.
  const full = await decodeTo16kMono(await (await fetch(longWavUrl)).blob());
  const clip = full.slice(0, 16_000 * 10);

  const baseline = (await asr(clip)) as { text: string };

  // The same inject-then-slice shape `worker.ts` uses for Whisper, minus the control tokens Moonshine
  // does not have. `add_special_tokens: false` because we are building the prefix by hand.
  const promptText = VOCABULARY.join(", ");
  const encoded = tokenizer(promptText, { add_special_tokens: false });
  const prefix = [...(encoded.input_ids.data as BigInt64Array)].map(Number);

  const model = (asr as unknown as { model: { generate(o: unknown): Promise<unknown> } }).model;
  const processor = (asr as unknown as { processor(a: Float32Array): Promise<unknown> }).processor;
  const inputs = (await processor(clip)) as { input_values: unknown };

  const output = (await model.generate({
    inputs: inputs.input_values,
    decoder_input_ids: [prefix],
  })) as { tolist(): number[][] };

  const decoded = tokenizer.batch_decode(output.tolist(), { skip_special_tokens: true })[0] ?? "";
  // Slice off what we injected, exactly as the Whisper path does.
  const primed = decoded.slice(promptText.length).trim();

  console.log("\n── baseline (no prefix) ──\n" + baseline.text.trim());
  console.log("\n── with prefix, after slicing ──\n" + primed);
  console.log("\n── raw primed output (prefix NOT sliced) ──\n" + decoded.trim());

  const leaked = primed.toLowerCase().includes(SENTINEL);
  console.log(`\nSENTINEL LEAKED INTO SLICED OUTPUT: ${String(leaked)}`);

  // Deliberately no pass/fail on the leak — the finding is the output above, and a threshold here
  // would assert an answer to the question the test exists to ask. What IS asserted is that the
  // experiment ran: a prefixed generate that produced no text would make the leak line meaningless.
  expect(decoded.length).toBeGreaterThan(0);
  expect(baseline.text.length).toBeGreaterThan(0);
});
