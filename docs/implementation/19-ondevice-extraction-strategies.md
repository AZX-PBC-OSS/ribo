# 19 — On-device extraction: four strategies, measured

**Date:** 2026-08-26
**Status:** Result, recorded. Four corpus runs against Chrome's real on-device model
(Gemini Nano, Chrome 151, M-series laptop). Scored with `spikes/extraction-snuggpro/score.mjs`,
**reused verbatim**, against the same 13 clean transcripts as doc 18.

## The one thing to take away

**How you ask the question mattered far more than any amount of engineering around the answer.**

The design in
[the on-device extraction spec](../superpowers/specs/2026-08-17-ondevice-extraction-design.md)
sent one constrained call per field group and mitigated the model's failures with retries. That
strategy lost **4 of 14 transcripts** even after the retry budget was tuned, and its quality got
_worse_ as reliability improved.

Splitting the same extraction into smaller questions — presence, then span, then classification —
took it to **14 of 14 with zero failures, in a third of the wall clock**, cut hallucination from
3.8% to 1.3%, and took source-span fidelity to **100%**, matching the frontier baselines.

The engineering built around the original strategy (retry budgets, loop detection, deadlines)
moved reliability from 7/14 to 10/14 and cost quality. Changing the question shape did the rest.

---

## 1. The four strategies

|                 | calls per transcript | shape of each call                                                                 |
| --------------- | -------------------- | ---------------------------------------------------------------------------------- |
| **per-group**   | 7                    | one nested enveloped group: values, confidences and spans together                 |
| **two-phase**   | ~22                  | phase 1: verbatim spans per group. phase 2: classify each span, one leaf at a time |
| **three-phase** | ~21                  | phase 0: booleans — is this field discussed? then spans, then classify             |
| **+ grounding** | ~20                  | three-phase, plus dropping any span that is not a verbatim substring               |

All four produce the identical nested enveloped shape, so `score.mjs` grades them unchanged.

## 2. Results

| metric                        |     per-group | two-phase | three-phase | **+ grounding** | frontier baseline |
| ----------------------------- | ------------: | --------: | ----------: | --------------: | ----------------: |
| transcripts completed         |          9/13 |     13/13 |       13/13 |       **13/13** |             13/13 |
| degenerate loops              | ~60% of calls |     0/303 |       0/297 |       **0/283** |               n/a |
| wall clock                    |      11.2 min |   4.0 min |     4.6 min |     **4.5 min** |               n/a |
| hard hallucination            |          3.8% |      4.8% |        1.6% |        **1.3%** |              0.5% |
| source-span verbatim          |         78.3% |     87.7% |       83.7% |        **100%** |              100% |
| enum member accuracy          |         82.7% |     93.3% |       94.2% |       **95.7%** |              100% |
| accuracy, both non-null       |         85.1% |     94.9% |       95.8% |       **95.2%** |              100% |
| hallucinated health passes    |             6 |         3 |           1 |           **2** |                 0 |
| health state accuracy         |         71.5% |     77.8% |       78.7% |       **77.4%** |              100% |
| **miss rate (all 51 leaves)** |         45.0% |     42.0% |       46.4% |       **53.0%** |              0.8% |

Frontier figures are doc 16 §5's codex/claude-cli baselines on the same corpus and scorer.

## 3. The degenerate loop was never a model defect to be retried around

The per-group strategy failed by falling into an unbounded run of whitespace after emitting valid
JSON, until it hit the model's output cap ~115 seconds later. Roughly 60% of calls did this.

**Retrying does not fix it.** Two runs, at four and then nine retries per call:

- 4 retries, default backoff: **7 of 14** transcripts completed
- 9 retries, near-zero backoff: **10 of 14**

And the four that failed the second time had all failed the first: `04-fuel-stated-separately`,
`06-homeowner-crosstalk`, `08-no-fuel-silent-drop`, `09-chatter-and-scheduling`. Ten attempts per
group, twice over, on the same four transcripts. Those are the corpus's deliberately hard cases —
indirection, distraction, information that must be withheld — and the model does not degrade on
them, it derails entirely.

**Under the smaller-question strategies the loop stopped occurring: 0 out of 883 calls across
three runs.** Not mitigated, not retried around. Absent.

### What the loop actually depends on — an open question, honestly held

The working hypothesis when the two-phase spike was designed was that this is a **grammar**
problem: a JSON grammar permits arbitrary whitespace between tokens, so an infinite run of
newlines is a legal continuation and constrained decoding cannot object. The prediction was that
phase 2's closed constraints (a bare enum, a bare number) would stop it while phase 1's object
constraint would not.

**That prediction was wrong.** Phase 1 uses an object constraint, with whitespace legal in its
grammar, and scored 0/98. Both phases changed two variables at once — output got shorter _and_
constraints got simpler — and the phase-1 result points at **output length**, not grammar shape.

Separating them needs a test that holds output length constant and varies only the grammar. Not
run. Recorded as the weaker true claim rather than the stronger convenient one.

## 4. The presence gate works, and did not rubber-stamp

The obvious way for a presence phase to fail is the model answering "yes" to everything. It did
not: **presence-true rate 165/714 (23.1%)**, with 49 of 98 groups skipped entirely because every
leaf in them came back false.

That gate is what took hallucination from 4.8% to 1.6% — the single largest quality move in these
runs. The mechanism it was built on: asking for "a verbatim quote, or null" is a _string-shaped_
question, and a small model asked for a string tends to produce one. When nothing in the
transcript matches, returning `null` is a kind of refusal, and the model would rather invent a
plausible quote. A boolean has no text to invent.

## 5. Grounding buys provenance integrity, not accuracy

`isSpanGrounded` has been exported from `ribo-core` since the provenance envelope was designed,
and **no extraction path has ever called it** — its only callers are tests asserting the fixtures
are grounded. Wiring it in drops any leaf whose span is not a verbatim substring, along with the
value that span was supposed to justify.

The result is not what was predicted:

- **Hallucination barely moved: 1.6% → 1.3%.** Most hallucinated values had _grounded_ spans — the
  model quoted something real and drew the wrong conclusion from it. Fabricated evidence and wrong
  conclusions are largely separate problems, and grounding addresses only the first.
- **Miss rate rose sharply: 46.4% → 53.0%**, because grounding is strict about case and whitespace
  and so drops near-miss paraphrases along with outright fabrications (9 and 7 respectively).
- **Span fidelity went to 100%**, from 83.7%.

That last row is categorical rather than marginal, and is the reason to adopt it anyway. The
provenance envelope exists so a reviewer can check the quote against the transcript. At 83.7% a
reviewer who finds one fabricated citation has no reason to trust the others; at 100% every value
shown carries evidence that can be verified. Review is this feature's entire safety net, and a
citation that cannot be trusted does not provide one.

## 6. What is still bad

**The miss rate. 53% means more than half of stated values come back null**, against a frontier
baseline of 0.8%. This is by far the largest remaining gap and it is not close.

It is defensible for the offline case — the alternative today is that the item parks in
`extracting` and the auditor gets _nothing_ — and the direction of the error is the safe one: a
reviewer can fill a blank, but cannot easily catch a plausible invention carrying a citation. But
"better than nothing" is a lower bar than a shipped product may want, and this number should not
be quoted without it.

**Hallucinated health passes are down but not gone** (6 → 2). Asserting that a combustion-safety
test passed when it did not is the failure with real-world consequences, and doc 18 records both
CLI backends scoring zero. Human review is the only thing standing behind it.

**Health state accuracy sits at ~77%** across every strategy — the one axis the question-shape
changes barely moved.

## 6a. The promoted extractor reproduces the spike

The strategy was measured as a spike, then moved into
`packages/ribo-extractor-ondevice/src/three-phase-extractor.ts` — ~500 lines relocated, with the
schema source changed from a hardcoded adapter import to `target.extractionSchema` so it works for
any adapter. Unit tests cover the behaviours; only a corpus run confirms the numbers survived the
move. It was re-run through the production object the composite actually wires:

|                            | spike (grounded) |    production |
| -------------------------- | ---------------: | ------------: |
| transcripts completed      |            13/13 |         13/13 |
| source-span verbatim       |             100% |      **100%** |
| hard hallucination         |             1.3% |          1.1% |
| enum member accuracy       |            95.7% |         93.8% |
| accuracy, both non-null    |            95.2% |         93.8% |
| hallucinated health passes |                2 |             1 |
| miss rate                  |            53.0% |         52.4% |
| calls / wall clock         |    283 / 4.5 min | 282 / 4.6 min |

The two structural properties held: 100% span fidelity means grounding survived, and 13/13 at 282
calls means the phase-skipping survived. The rest is single-digit counts on 13 transcripts against
a non-deterministic model — 45/48 against 44/46 is noise, and neither run should be quoted as
"the" number without the other beside it.

## 7. What this does and does not settle

**Settled.** The degenerate loop is a property of how the question is asked, not an inherent model
defect; smaller questions eliminate it. A presence gate materially reduces hallucination and does
not rubber-stamp. Span grounding delivers 100% provenance integrity at a real cost in misses.
Question shape dominates retry engineering.

**Not settled.** Whether output length or grammar shape drives the loop (§3). Whether these
numbers hold on the target Surface Go 3 — every figure here is from an M-series laptop. Whether
they hold in Edge, which ships a different model and which the API guarantees nothing about.
Whether the 53% miss rate is acceptable to the people who would use this.

**Not measured at all.** Any strategy beyond these four — per-leaf questions, self-consistency
sampling over repeated calls, or restricting the on-device path to the field groups it handles
well (band mapping scored 100%, health matrix ~77%). The last of those was designed and never run.

## Sources

- `spikes/ondevice-acceptance/` — the runner and the three strategy implementations.
- `spikes/extraction-snuggpro/results/{ondevice-run1,ondevice,ondevice-two-phase,ondevice-three-phase,ondevice-grounded}/`
  — the raw result files and run logs for all five runs.
- `spikes/extraction-snuggpro/score.mjs` — the scorer, reused verbatim.
- [Doc 16](16-extraction-schema-scale.md) §5 — the frontier baselines quoted above, and the
  earlier finding that decomposition was a wash _for frontier models_, which is the premise this
  document overturns for a small one.
- [Doc 18](18-first-extraction-measurement.md) — the shape-versus-accuracy split this follows.
- [The on-device extraction spec](../superpowers/specs/2026-08-17-ondevice-extraction-design.md)
  §10 — the earlier bench measurements, including the toy-schema degeneration rate that led to the
  wrong retry budget.
