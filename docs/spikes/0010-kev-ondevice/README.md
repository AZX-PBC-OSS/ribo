# 0010 — self-hosted System One: can kev stand in for hosted Jev?

**Status:** Answered · **Date:** 2026-09-22/23 · **Target:** `onnx-community/kev-0.6b-ONNX` and
`onnx-community/kev-4b-ONNX` under transformers.js 4.2.0, scored against the same corpus and the
same cells as spike 0008

## The answer

**No, at either published size — and a bigger export is not the missing piece.**

Spike 0008 closed on-device with "No ONNX, no transformers.js, no WASM … nothing like that exists
today." **That is no longer true.** Two exports publish the pointer head inside the graph, load
through transformers.js and run; the 0.6B runs in a browser under WebGPU at 860 ms a pass.
Mechanically, the rung ADR 0020 reserved `ribo-systemone-ondevice` for now exists.

Neither model is accurate enough to carry either feature built on spike 0008. On the 951
corroboration cells, against hosted Jev:

|          | supported → supports | corrupted → contradicts | invented → says_nothing |
| -------- | -------------------- | ----------------------- | ----------------------- |
| kev-0.6b | 93.7%                | **0.0%**                | 60.7%                   |
| kev-4b   | 98.9%                | 54.7%                   | **15.1%**               |
| Jev      | 91.6%                | 97.9%                   | 91.1%                   |

**The two sizes fail in opposite directions, and that is the finding.** 0.6B is indecisive: its
distributions are nearly flat, `contradicts` never wins a single cell, and median confidence is
0.161. 4B is decisive and **over-agreeable**: it beats Jev at not escalating good values (1.1%
against 8.4%) and tells a wrong value from a right one half the time — but it marks **84.5% of
invented values as `supports`**. Those are hallucinations, they are 761 of the 951 cells, and
`corroborateExtractor` thresholds a ratio over exactly that population. It would escalate almost
nothing.

So scale moved the failure rather than removing it. Going from 0.6B to 4B bought the
wrong-value axis and lost the never-discussed axis, which is the one the combinator exists for.
That is not a size away from working, and it is why this spike does not end in "wait for the 9B".

**And the question's shape matters more than its size.** Asked as a single noul instead of a
three-way choice, the same 4B weights on the same cells catch **75.6%** of invented values rather
than 15.5%, at a matched false-escalation rate (probe 4). That is a larger effect than the whole
0.6B → 4B jump. It does not rescue the feature — a noul cannot tell `contradicts` from
`says_nothing`, which is the distinction ADR 0021 kept the choice for — but it is the finding most
likely to matter to whoever picks this up next.

**Presence fails at both sizes, and fails the same way twice.** Scale moves its AUC 0.8319 → 0.9596
and leaves the lowest discussed leaf at 0.136 — slightly _worse_ than 0.6B's 0.185. A presence
phase cannot trade recall, so only the tail counts, and the tail is exactly what did not improve
(probe 2).

**Two defects in the published artifacts, both silent, both worth carrying forward.** The model
card's own snippet mis-derives all five delimiters, and neither export carries the calibration
temperature. Details below; either one alone produces confident, plausible, meaningless numbers.

## What exists

Two conversions, both created 2026-09-20. They are not the same generation: `kev-0.6b` is a LoRA
on `Qwen/Qwen3-0.6B-Base`, the **previous** backbone, while `kev-4b` is on `Qwen/Qwen3.5-4B-Base`,
the current one. So the gap below is generation and size together, not size alone. There is no 9B
export.

| export          | q4f16    | checkpoint transfer accuracy | fitted temperature |
| --------------- | -------- | ---------------------------- | ------------------ |
| `kev-0.6b-ONNX` | ~335 MB  | 0.620                        | 1.9318726578       |
| `kev-4b-ONNX`   | ~2.26 GB | 0.797                        | 2.3784142300       |
| hosted Jev      | —        | 0.857                        | n/a                |

Transfer accuracy is the out-of-domain figure from each checkpoint's own `result.json`, which is
the regime our corpus sits in. Note 4B's 0.797 is well above the 0.72–0.75 the kev repository
README quotes for that size.

Size is only an obstacle at 4B. The 0.6B's ~335 MB sits beside the ~314 MB Whisper `base.en` this
repo already measured and ships as an option in `ribo-transcriber-ondevice`; 4B's ~2.26 GB is
roughly seven times that, and whether it is deployable in a browser at all is a question this
spike never had to reach.

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

## The calibration temperature is in neither export

kev fits a temperature per checkpoint on its in-distribution dev set, and "the pointer head applies
it when the model is loaded". In **both** exports the final node is `logits = ReduceSum ×
Constant_25`, and `Constant_25` is exactly **0.0625** — `1/sqrt(head_dim=256)`, the raw pointer
scale. **T = 1.**

So each export emits uncalibrated logits, a bare softmax over them is overconfident, and kev's
published calibration numbers describe a different file. The fitted values are the `temperature`
field of `result.json` on each source repo, and they differ per checkpoint — using one model's on
another is silently wrong:

| checkpoint | temperature  | ECE in-distribution | ECE transfer | confident-error rate |
| ---------- | ------------ | ------------------- | ------------ | -------------------- |
| kev-0.6b   | 1.9318726578 | 0.032               | 0.073        | 2.7% / 1.2%          |
| kev-4b     | 2.3784142300 | 0.013               | 0.021        | 2.1% / 2.3%          |

`kev.mjs` carries both in a registry and applies the right one. Nothing in either ONNX repo's card
or config mentions this, and neither export's `config.json` carries the value — so it cannot be
looked up at runtime and has to be transcribed from the source checkpoint.

**It changes no verdict here.** Temperature scaling is monotone: it moves no argmax and reorders
nothing, so accuracy, the precision/recall curves and every AUC below are identical with or
without it. Only the numeric thresholds and the calibration move — which is precisely why a
threshold quoted without its scale is not reusable, and why the comparable numbers below are AUCs.

`confidence` is kev's own chance-corrected `(max(p) − 1/K) / (1 − 1/K)` (`kev/api.py`), not
`max(p)` — a confidence gate copied from a hosted probe means nothing unless the quantity matches.

## Probe 2 — presence at leaf granularity

Spike 0008's probe 10, same 2226 transcript × leaf cells, same question text, import swapped.

| threshold | kev-0.6b precision / recall / wasted | kev-4b precision / recall / wasted |
| --------- | ------------------------------------ | ---------------------------------- |
| 0.10      | 0.061 / 1.000 / 149.4                | 0.063 / 1.000 / 144.0              |
| 0.20      | 0.084 / 0.978 / 103.2                | 0.121 / 0.985 / 68.8               |
| 0.30      | 0.143 / 0.815 / 47.1                 | 0.258 / 0.948 / 26.3               |
| 0.50      | 0.337 / 0.237 / 4.5                  | 0.532 / 0.852 / 7.2                |

**AUC goes 0.8319 → 0.9596, and it does not help.** That is the sharpest thing in this spike.
Scale transforms the _body_ of the distribution — the median discussed leaf moves from 0.423 to
0.700, and at a 0.50 threshold kev-4b is within a whisker of hosted Jev on both precision (0.532
against 0.551) and waste (7.2 against 7.5 items per transcript).

It changes nothing about the **tail**, which is the only part this phase cares about:

|          | lowest discussed leaf | recall 1.000 costs          | Jev                              |
| -------- | --------------------- | --------------------------- | -------------------------------- |
| kev-0.6b | 0.185                 | precision 0.061, 149 of 159 |                                  |
| kev-4b   | **0.136**             | precision 0.061, 144 of 159 | recall 1.000 at 0.20, ~33 of 159 |

The lowest true positive got _worse_. Undiscussed leaves still reach 0.904 while a discussed one
sits at 0.136, so the populations remain fully overlapped at the edges however good the middle
gets. A presence phase cannot trade recall: a false negative seeds the leaf null and no later
phase ever plans an item for it, which is silent data loss. At the only threshold that avoids it,
both models plan essentially everything and the phase does no work.

This is the mirror image of probe 3. There, 4B's gains landed on the axis we did not need; here
they land on the part of the distribution we do not get to use. An average-case metric says 4B is
close to Jev. The requirement is worst-case, and on worst-case it is not close.

Cost, for the record: 16.0 s per transcript at 0.6b and 65.9 s at 4b, four CPU passes of ~3200
tokens each.

## Probe 3 — the three-way choice that shipped

Spike 0008's probe 11, the formulation that became `corroborateExtractor` (ADR 0021). Same 951
cells from probe 4's `triage.json`.

| population | n   | model    | supports  | contradicts | says_nothing |
| ---------- | --- | -------- | --------- | ----------- | ------------ |
| supported  | 95  | kev-0.6b | 93.7%     | **0.0%**    | 6.3%         |
|            |     | kev-4b   | 98.9%     | 0.0%        | 1.1%         |
|            |     | Jev      | 91.6%     | 5.3%        | 3.2%         |
| corrupted  | 95  | kev-0.6b | 77.9%     | **0.0%**    | 22.1%        |
|            |     | kev-4b   | 34.7%     | 54.7%       | 10.5%        |
|            |     | Jev      | 2.1%      | **97.9%**   | 0.0%         |
| invented   | 761 | kev-0.6b | 39.3%     | **0.0%**    | 60.7%        |
|            |     | kev-4b   | **84.5%** | 0.4%        | 15.1%        |
|            |     | Jev      | 7.9%      | 1.1%        | **91.1%**    |

**At 0.6B, `contradicts` is never selected.** Not rare — zero across all 951 cells. It never
exceeds p = 0.327 and ranks last in 921 of 951, so no amount of temperature explains it. Its mean
mass does not even point the right way: 0.154 on supported, 0.188 on corrupted, 0.208 on invented.
If it tracked contradiction, corrupted would be highest; instead the _never-discussed_ population
attracts the most.

**At 4B it fires, and the other axis collapses instead.** 54.7% of corrupted values are correctly
called `contradicts` — a real capability the small model does not have at all. But 84.5% of
invented values come back `supports`. Those are hallucinations, and they are 761 of the 951 cells.

Escalating on `choice != supports`:

|          | good wrongly escalated | corrupted caught | invented caught | AUC    |
| -------- | ---------------------- | ---------------- | --------------- | ------ |
| kev-0.6b | 6.3%                   | 22.1%            | 60.7%           | 0.8736 |
| kev-4b   | **1.1%**               | 65.3%            | **15.5%**       | 0.9129 |
| Jev      | 8.4%                   | **97.9%**        | **92.1%**       | —      |

4B is the better model on every axis except the one that decides this. `corroborateExtractor`
thresholds a **ratio of non-`supports` verdicts over committed leaves** (ADR 0021), and the
population that ratio is meant to catch is exactly the one 4B waves through. A combinator that
escalates on 15.5% of hallucinations does not do the job the combinator exists for.

The confidence axis is unavailable at both sizes. At 0.6B median confidence is 0.161 and the
maximum over 951 cells is 0.676, so every gate at 0.30 or above zeroes all three columns. At 4B a
0.50 gate cuts corrupted-caught from 65.3% to 3.2% and invented-caught to zero.

## Probe 4 — is it the three-way split, or the task?

**At 0.6B the task. At 4B the split — and this is the most useful result here.** Same cells as a
single noul: "does the dictation support this value?".

| population | n   | kev-0.6b | kev-4b | Jev   |
| ---------- | --- | -------- | ------ | ----- |
| supported  | 95  | 0.734    | 0.831  | 0.804 |
| corrupted  | 95  | 0.660    | 0.293  | 0.035 |
| invented   | 761 | 0.549    | 0.588  | 0.146 |

0.6B has no separation to work with — corrupted sits 0.074 below supported where Jev's gap is
0.769 — and no gate helps: at 0.70 it keeps 73.7% of good values and catches 50.5% of corrupted;
at 0.80 it catches 93.7% and keeps 21.1%.

**4B is a different story.** Compared at a matched false-escalation rate, which is the only fair
comparison — both keep exactly 84.2% of good values:

| at 15.8% of good values escalated | corrupted caught | invented caught |
| --------------------------------- | ---------------- | --------------- |
| kev-4b noul, gate 0.70            | 89.5%            | 75.6%           |
| Jev noul, gate 0.50               | 98.9%            | 91.7%           |

Against the same model's three-way choice, which caught **15.5%** of invented values, the noul form
catches 75.6% at a comparable escalation rate. That is a formulation difference, not a model
difference — identical weights, identical cells, identical input.

This is spike 0008's probe 3 finding reproducing on a different model: "silence is invisible to
`choice` confidence but plainly visible to a `noul` that asks about absence directly." It was
recorded there about enum extraction on Jev. It turns out to be the thing that separates a
hopeless on-device verifier from a merely worse one.

AUC 0.8950 against Jev's 0.9482 on identical inputs, and the per-cell Pearson correlation rises
from 0.238 at 0.6B to **0.445** at 4B — so the bigger model is genuinely answering more of the same
question, not just answering louder.

**It still does not clear the bar, and the reason is specific.** `corroborateExtractor` ships the
three-way choice (ADR 0021) precisely because it separates `contradicts` — a wrong value gap-fill
could re-ask — from `says_nothing`, where the honest repair is null. A noul cannot make that
distinction at all. So an on-device rung would have to run a formulation ribo does not use, give up
the axis ADR 0021 kept the choice for, and still catch 16 points fewer hallucinations than hosted
Jev. That is a worse feature, not the same feature cheaper.

## Probe 5 — WebGPU in a real browser

**It works.** Headed Chromium, `q4f16`, real GPU adapter. **0.6B only** — 4B was not run in a
browser, because probes 3 and 4 had already said it is not the model we want, and ~2.26 GB is its
own question that only matters once something clears the accuracy bar.

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

The runtime path is real and both models are not. The useful part is **how** the two sizes fail,
because it is not the same failure twice.

0.6B is indecisive — flat distributions, `contradicts` never wins, confidence unusable. The
obvious reading is "too small", and the obvious next move is a bigger export. That move was
available and it was made, and 4B does not fix the problem; it **trades** one half of the
judgement for the other. It becomes better than Jev at leaving good values alone, gains the
wrong-value axis outright, and goes nearly blind to values that were never discussed at all —
which is the axis both shipped features actually rest on.

**Both probes fail the same way underneath, and it is worth naming because it is easy to miss.**
Every average-case measure says 4B is close to Jev: AUC 0.9596 on presence, precision within 0.02
and waste within 0.3 items at a 0.50 threshold. Every requirement these two features actually
impose is worst-case — recall 1.000 for presence, because a missed leaf is silent data loss, and
catching the invented population for corroboration, because that is the population the ratio
thresholds. Scale bought the average and left the worst case alone; presence's lowest true
positive even moved the wrong way, 0.185 → 0.136. A model selected on AUC would look ready here
and would not be.

So "wait for the 9B" is not the conclusion this supports. The scaling evidence available here
points at a model that agrees more readily as it gets larger, and agreement is the failure mode.

**The formulation matters more than the parameter count, and probe 4 is the evidence.** The same
4B weights on the same cells catch 15.5% of hallucinations as a three-way choice and 75.6% as a
single noul. That is the larger effect in this spike — bigger than the jump from 0.6B to 4B — and
it reproduces spike 0008's probe 3 finding on a different model. Anyone returning to this should
sweep formulations before sizes.

What would still be needed is a formulation that keeps the `contradicts` / `says_nothing` split
ADR 0021 depends on while seeing absence the way a noul does. Two nouls would, and spike 0008's
probe 11 rejected that shape on Jev for good reasons — but those reasons were measured on a model
that did not have this weakness. That is the one genuinely open question here, and it is cheap:
the cells and the harness both already exist.

Nothing in this spike changes `ribo-systemone-managed` or `corroborateExtractor`, both of which
run against hosted Jev and are unaffected. ADR 0020's reservation of `ribo-systemone-ondevice`
stands; this spike is why it is still empty.

It also bounds something narrower than it first appears. Ribo has a real offline story —
`ribo-transcriber-ondevice` and `ribo-extractor-ondevice` exist because auditors work where there
is no signal — so "can the corroboration judgement run offline too?" is a fair question. The
answer is no at both published sizes, which is worth recording precisely so the existence of an
ONNX export does not reopen it.

No ADR. ADR 0020 already decided the name and ADR 0021 the combinator; a measurement that declines
to build something does not overturn either.

## Running these

`kev.mjs` is the harness — it presents the same `ask()` as
[`../0008-typesafe-jev/env.mjs`](../0008-typesafe-jev/env.mjs), so probes 2–4 are that spike's
scripts with one import changed. It needs no credential: everything runs locally against weights
fetched from the Hub. Probes 3 and 4 read `../0008-typesafe-jev/results/triage.json` for their
cells, and all of them read the annotated corpus in
[`../0001-extraction-snuggpro/`](../0001-extraction-snuggpro/).

Probes 2–4 take the model size as their first argument (`0.6b` or `4b`, default `0.6b`) and a
chunk size as their second, and write one result file per size. `kev.mjs`'s `MODELS` registry is
where a new export is added — repo, its fitted temperature, and its published transfer accuracy.

```bash
pnpm build:packages            # schema-leaves.mjs reads the built adapter
node docs/spikes/0010-kev-ondevice/run-1-wire-format.mjs
node docs/spikes/0010-kev-ondevice/run-2-presence.mjs      4b
node docs/spikes/0010-kev-ondevice/run-3-corroboration.mjs 4b
node docs/spikes/0010-kev-ondevice/run-4-noul.mjs          4b
node docs/spikes/0010-kev-ondevice/run-5-webgpu.mjs        # 0.6b only; headed browser
```

First run of each size downloads its `q4` weights (~375 MB for 0.6b, ~2.5 GB for 4b) into the
repo's gitignored `.cache/`, and probe 5 another ~335 MB into the browser's own cache. On CPU a
probe is ~4 minutes at 0.6b and ~15–35 minutes at 4b; WebGPU was 4–5× faster than CPU on the small
model, so these timings bound iteration, not deployment. Nothing here writes to a live system and
nothing needs a credential.

## Sources

Fetched 2026-09-22/23. The ONNX repos carry the wire format and the loading snippet; the **source**
repos carry the calibration temperatures, which the exports omit.

|                         |                                                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| ONNX exports            | [kev-0.6b-ONNX](https://huggingface.co/onnx-community/kev-0.6b-ONNX), [kev-4b-ONNX](https://huggingface.co/onnx-community/kev-4b-ONNX)           |
| source checkpoints      | [kev-0.6b](https://huggingface.co/jaredpalmer/kev-0.6b), [kev-4b](https://huggingface.co/jaredpalmer/kev-4b) — `result.json` holds `temperature` |
| code and research log   | [github.com/jaredpalmer/kev](https://github.com/jaredpalmer/kev) — `kev/api.py` is where `choice_confidence` comes from                          |
| the contract kev serves | [TypeSafe HTTP API](https://docs.typesafe.ai/api.md), [primitives](https://docs.typesafe.ai/primitives.md)                                       |

Both defects this spike reports are in the ONNX repos' own card and graph, not in the source
checkpoints: the card's snippet mis-derives the delimiters, and both graphs carry a raw `0.0625`
scale with no temperature. Read the source repo's `result.json` for the value, never the export.
