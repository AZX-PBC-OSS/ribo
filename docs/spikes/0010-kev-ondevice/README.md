# 0010 — kev on-device: a System One model in the browser

**Status:** Answered · **Date:** 2026-09-22 · **Target:** `onnx-community/kev-0.6b-ONNX` under
transformers.js 4.2.0, scored against the same corpus and the same cells as spike 0008

## The answer

**Do not build `ribo-systemone-ondevice` on kev-0.6b. The runtime works; the model does not.**

Spike 0008 closed on-device with "No ONNX, no transformers.js, no WASM … nothing like that exists
today." **That is no longer true** — `onnx-community/kev-0.6b-ONNX` publishes the pointer head
inside the graph, loads through transformers.js, and runs. Mechanically, the rung ADR 0020
reserved the name for now exists.

It is not accurate enough to carry either feature built on spike 0008:

- **Corroboration — no.** `contradicts` won **0 of 951 cells**. A substituted wrong value, which
  hosted Jev catches 97.9% of the time, is caught 22.1% of the time and never for the right
  reason. The simpler one-noul formulation fails the same way: corrupted values score 0.660
  against supported's 0.734, a gap of 0.074 where Jev's is 0.769.
- **Presence — no.** Recall 1.000 needs a threshold of 0.185, where precision is 0.061: it plans
  149 items of 159. The phase exists to shrink 159 leaves to a few dozen without losing one, and
  at its only safe operating point it shrinks nothing.

Both failures are the same failure. kev-0.6b can tell **whether a topic came up**; it cannot tell
**whether a particular value is the right one**. That is the limitation its own model card names —
"out of domain it is a 0.6B model … capacity, not data, is the bottleneck at this size" — and our
corpus is out of domain.

The signal is real but never usable: AUC 0.83–0.87 on every task here, against Jev's 0.95. And
per-cell agreement with Jev is **r = 0.238**, so this is not a weaker version of the same
judgement. It is a different one.

**Two defects in the published artifacts, both silent, both worth carrying forward.** The model
card's own snippet mis-derives all five delimiters, and the export drops the calibration
temperature. Details below; either one alone produces confident, plausible, meaningless numbers.

## What changed since 0008, and what did not

`onnx-community/kev-0.6b-ONNX` is a conversion of `jaredpalmer/kev-0.6b` — the **previous**
(Qwen3) generation and the smallest size. Kev-4B and Kev-9B are much stronger (transfer accuracy
0.72–0.75 and 0.74–0.77 against 0.6B's 0.620, and Jev's 0.857) and **neither has an ONNX export**.
So the browser choice today is 0.6B or nothing.

Sizes are not the obstacle: q4f16 is ~335 MB, which sits beside the ~314 MB Whisper `base.en` this
repo already measured and ships as an option in `ribo-transcriber-ondevice`.

## Probe 1 — does it load, and can we reproduce the wire format?

Yes, and the wire format is documented rather than reverse-engineered: `config.json` carries the
delimiters, their ids and the limits under a `kev` key, and the graph takes only `input_ids` and
`attention_mask`, deriving segments, positions and the block-causal mask in-graph.

Node, `q4` on CPU: **0.7 s warm load, 64 ms for a 103-token forward pass.**

**The model card's snippet does not work, and fails silently.** It sanitizes caller text with
`<|name|>` → `<¦name¦>` so caller text can never forge a delimiter — then applies that same
function to the five delimiter _names_. All five tokenize as ordinary text and `enc(t)[0]` returns
the id of `<` for every one of them. Nothing errors. The packing runs, the pointer head reads
positions that are not option boundaries, and every question comes back **exactly uniform**:

```
Which team should handle this ticket?      0.2500 / 0.2500 / 0.2500 / 0.2500
Is the customer asking for a refund?       0.5000 / 0.5000
```

Read the ids from `config.json` instead and the same call returns 0.823 billing, 0.743 yes, 0.704
very negative.

Worth naming because of how it was caught: the probe asserts that every position it reads holds an
`option_end` token — and that assertion **passed**, because all five delimiters had collapsed to
the same id, making `tokens[i] === END` trivially true. The guard was defeated by the exact bug it
was written to catch. What actually exposed it was the output being too round.

## The calibration temperature is not in the export

kev fits a temperature per checkpoint on its in-distribution dev set, and "the pointer head applies
it when the model is loaded". The exported graph's final node is `logits = ReduceSum × Constant_25`,
and `Constant_25` is exactly **0.0625** — `1/sqrt(head_dim=256)`, the raw pointer scale. **T = 1.**

So the export emits uncalibrated logits, a bare softmax over them is overconfident, and kev's
published calibration numbers describe a different file. The fitted value for this checkpoint is in
`result.json` on the source repo:

|                   | ECE in-distribution | ECE transfer | confident-error rate |
| ----------------- | ------------------- | ------------ | -------------------- |
| as exported (T=1) | —                   | —            | not measured         |
| T = 1.9318726578  | 0.032               | 0.073        | 2.7% / 1.2%          |

`kev.mjs` applies it. Nothing in the ONNX repo's card or config mentions this.

**It changes no verdict here.** Temperature scaling is monotone: it moves no argmax and reorders
nothing, so accuracy, the precision/recall curves and every AUC below are identical with or
without it. Only the numeric thresholds and the calibration move — which is precisely why a
threshold quoted without its scale is not reusable, and why the comparable numbers below are AUCs.

`confidence` is kev's own chance-corrected `(max(p) − 1/K) / (1 − 1/K)` (`kev/api.py`), not
`max(p)` — a confidence gate copied from a hosted probe means nothing unless the quantity matches.

## Probe 2 — presence at leaf granularity

Spike 0008's probe 10, same 2226 transcript × leaf cells, same question text, import swapped.

| threshold | precision | recall | wasted items/transcript |
| --------- | --------- | ------ | ----------------------- |
| 0.10      | 0.061     | 1.000  | 149.4                   |
| 0.20      | 0.084     | 0.978  | 103.2                   |
| 0.30      | 0.143     | 0.815  | 47.1                    |
| 0.50      | 0.337     | 0.237  | 4.5                     |

**The populations sit on top of each other.** Discussed leaves run min 0.185 / p5 0.212 / median
0.423; undiscussed ones run median 0.245 / p95 0.452 / max 0.764. The undiscussed _median_ is above
the discussed _5th percentile_. AUC 0.8319 — real signal, no usable operating point.

Hosted Jev reached recall 1.000 at 0.20 with 19.9 wasted items, planning ~33 of 159.

Cost, for the record: 16.0 s per transcript on CPU, four passes of ~3200 tokens each.

## Probe 3 — the three-way choice that shipped

Spike 0008's probe 11, the formulation that became `corroborateExtractor` (ADR 0021). Same 951
cells from probe 4's `triage.json`.

| population | n   | supports | contradicts | says_nothing |
| ---------- | --- | -------- | ----------- | ------------ |
| supported  | 95  | 93.7%    | **0.0%**    | 6.3%         |
| corrupted  | 95  | 77.9%    | **0.0%**    | 22.1%        |
| invented   | 761 | 39.3%    | **0.0%**    | 60.7%        |

**`contradicts` is never selected.** Not rare — zero, across all 951 cells. It never exceeds
p = 0.327 and ranks last in 921 of 951. This is at argmax, so no amount of temperature explains it.

Its mean mass does not even point the right way: 0.154 on supported, 0.188 on corrupted, 0.208 on
invented. If it tracked contradiction, corrupted would be highest; instead the _never-discussed_
population attracts the most. The three-way question collapses into a two-way one, and the axis it
loses is exactly the one ADR 0021 kept it for — telling a wrong value (re-askable) from an
unmentioned one (null it).

Escalating on `choice != supports`: 6.3% of good values wrongly escalated, 22.1% of corrupted
caught, 60.7% of invented caught. Jev on the same cells: 8.4% / 97.9% / 92.1%.

The confidence axis is unavailable too. Median confidence is 0.161 and the maximum over all 951
cells is 0.676; **every** gate at 0.30 or above zeroes all three columns at once.

## Probe 4 — is it the three-way split, or the task?

The task. Same cells as a single noul — "does the dictation support this value?".

| population | n   | kev mean | kev median | Jev mean |
| ---------- | --- | -------- | ---------- | -------- |
| supported  | 95  | 0.734    | 0.750      | 0.804    |
| corrupted  | 95  | 0.660    | 0.689      | 0.035    |
| invented   | 761 | 0.549    | 0.559      | 0.146    |

No gate works: at 0.70 it keeps 73.7% of good values and catches 50.5% of corrupted; at 0.80 it
catches 93.7% of corrupted and keeps 21.1% of good.

AUC 0.854 against Jev's 0.948 on identical inputs. And the per-cell Pearson correlation between
the two models is **0.238** — the interesting number in this spike. A small model that was simply a
noisier Jev would be worth a threshold hunt. One that disagrees this much is answering a different
question, and its 0.660 on corrupted values says which: it is reporting topical relatedness, not
verification.

## Probe 5 — WebGPU in a real browser

**It works.** Headed Chromium, `q4f16`, real GPU adapter:

|                           |                                       |
| ------------------------- | ------------------------------------- |
| cold load (~335 MB)       | 15.6 s                                |
| first pass, 2537 tokens   | 1117 ms (includes shader compilation) |
| warm passes               | 868 / 860 / 860 ms                    |
| Node CPU reference (`q4`) | ~4000 ms per ~3200-token pass         |

Latency is not the obstacle — one pass answers every question put in it, so 40 questions cost the
same 860 ms as one. Headed is required: headless Chromium reports no GPU adapter, the same
constraint `ribo-transcriber-ondevice`'s dtype probe already documents.

The page re-checks the delimiter trap from probe 1 in-browser, asserting the answers are not all
identical, since that failure mode produces a perfectly healthy-looking run.

**One thing to confirm before anyone relies on it:** transformers.js could not cache the weights —
`Failed to execute 'put' on 'Cache'` — which would mean a 335 MB download every session. This ran
in Playwright's ephemeral profile, which is the likely cause, so it is an open question rather than
a finding. It did not affect any measurement here.

(Aside, not evidence: on a state discussing only attic R-value, all 40 differently-numbered field
questions returned p(yes) ≥ 0.63. Synthetic input, so it proves nothing on its own — but it is the
same inability to recognise absence that probe 2 measured properly.)

## Read

The runtime path is real and the model is not. That split is worth keeping straight, because it
says what would change the answer: **a kev-4B or kev-9B ONNX export**, not tuning, prompts or
thresholds. Transfer accuracy is flat at ~0.60 across eight one-knob mutations and three seeds at
this size — the card is explicit that capacity is the bottleneck — so nothing done on our side
moves it.

Nothing here changes `ribo-systemone-managed` or `corroborateExtractor`. ADR 0020's reservation of
`ribo-systemone-ondevice` stands; this spike is why it is still empty, and the harness is what
answers the question again when a larger export appears.

No ADR. ADR 0020 already decided the name and ADR 0021 the combinator; a measurement that declines
to build something does not overturn either.

## Running these

`kev.mjs` is the harness — it presents the same `ask()` as
[`../0008-typesafe-jev/env.mjs`](../0008-typesafe-jev/env.mjs), so probes 2–4 are that spike's
scripts with one import changed. It needs no credential: everything runs locally against weights
fetched from the Hub. Probes 3 and 4 read `../0008-typesafe-jev/results/triage.json` for their
cells, and all of them read the annotated corpus in
[`../0001-extraction-snuggpro/`](../0001-extraction-snuggpro/).

```bash
pnpm build:packages            # schema-leaves.mjs reads the built adapter
node docs/spikes/0010-kev-ondevice/run-1-wire-format.mjs
node docs/spikes/0010-kev-ondevice/run-2-presence.mjs
node docs/spikes/0010-kev-ondevice/run-3-corroboration.mjs
node docs/spikes/0010-kev-ondevice/run-4-noul.mjs
node docs/spikes/0010-kev-ondevice/run-5-webgpu.mjs    # launches a headed browser
```

First run downloads ~375 MB (`q4` on CPU) and probe 5 another ~335 MB (`q4f16` into the browser's
own cache). Probes 2–4 are ~4 minutes each on CPU. Nothing here writes to a live system.
