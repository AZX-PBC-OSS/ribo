# Snugg Pro extraction spike

A cheap, offline test of the project's **central technical risk**, run against the **real** Snugg
Pro capture model instead of an invented one. The question is: can a
single schema-constrained LLM call pull an auditor's dictation into a fixed field set without
inventing the parts that were never said? What matters here is the schema — and the schema is the point.

> **Ground truth has been re-annotated (track-b0 complete).** All 14 corpus transcripts now have
> ground-truth files in the vocabulary-neutral `leaves` format described in
> [`ground-truth-format.md`](ground-truth-format.md) and [`ANNOTATOR_GUIDE.md`](ANNOTATOR_GUIDE.md).
> `schema.ts`, `prompt.md` and `normalization.md` in this directory still describe the PRE-REBUILD
> field set — 23 flat snake_case fields plus an 11-test `healthSafety` object. The real authority
> is now [`packages/ribo-adapter-snuggpro/src/schema.ts`](../../packages/ribo-adapter-snuggpro/src/schema.ts)
> (51 leaves under 7 resource groups, the API's own literal enum strings). `score.mjs` and
> `score.test.mjs` have been rebuilt against the real schema — see
> [`ground-truth-format.md`](ground-truth-format.md) for the format and its rationale.
> `schema.ts`/`prompt.md`/`normalization.md`/the extraction-running instructions below are **not
> yet updated** for the new schema — that is a separate, follow-on task; the four hazards they
> describe are still real, but the field names, enum members and test count they quote are the
> old ones. Do not hand a model `schema.ts` from this directory expecting new-schema output.

## Why the schema is the point

An earlier, throwaway extraction attempt scored well against a convenient invented schema, but
[doc 12 — Snugg Pro Data Model](../../docs/implementation/12-snuggpro-data-model.md) then showed that
schema was **structurally wrong on real data, four ways**, and that a good score against it partly
measured the schema being _convenient_ rather than the extractor being _good_. Doc 12's one-line
thesis: **"just pass the schema" is materially wrong**, because the gap between what an auditor says
and what Snugg stores is not a formatting nicety a JSON Schema absorbs — it is a **normalization
layer** (spoken form → Snugg enum / depth band / split axis) that a schema-only approach skips
entirely.

This spike is built to stress exactly that layer. The four hazards are deliberately **in** the
schema, not smoothed away:

1. **Fuel is a separate axis.** `heatingEquipmentType` and `heatingFuel` are two fields. "Oil boiler"
   must land as `{ boiler, fuel_oil }`. The old fused `HeatingSystemType` enum could not represent it.
2. **Attic insulation is a depth band in inches** (`0` … `16+`) plus a material — not an R-value
   number. The auditor says "R-38"; there is no R-value write target.
3. **Health & safety is a fixed 4-state matrix** of ~11 named tests (`passed` / `failed` / `warning`
   / `not_tested`), not a free-text field. "CO was clean" is `passed`; silence is not a pass.
4. **Efficiency (AFUE/SEER) is not a capture field.** The sheet records make / model / year / BTU;
   efficiency is derived. There is deliberately no AFUE slot to hallucinate into.

If a single schema-constrained call handles these, the adapter design in
[doc 05](../../docs/implementation/05-adapter-snuggpro.md) stands. If it does not, the failure tells
us whether the fix is prompt-level or a second, deterministic (or LLM) normalization pass — see
[normalization.md](normalization.md), which frames the whole thing as a falsifiable hypothesis.

## What this test measures

Two things at once, and the second is why the spike had to be rebuilt:

- **The old headline: hallucination on genuinely-absent fields.** Does nullable+required + the
  provenance envelope suppress invention? Still the load-bearing number.
- **New, schema-specific correctness the old spike could not measure:** did the extractor perform the
  four structural transforms — split the fuel axis, band the depth, hold the matrix states apart? A
  schema that fuses these (the old one) cannot even pose the question. This one can.

## ⚠️ Leak discipline — read before running anything

The whole spike is worthless if the model that authors the corpus also scores against itself. The
discipline is stricter than "use a different model" — it is a **three-way separation of authorship**:

1. **The corpus (transcripts) and the ground truth are authored by a DIFFERENT agent than this one.**
   This agent (the one that built `schema.ts`, `prompt.md`, `normalization.md`, this README) authored
   the **extraction target only**. It did **not** write, and must not write, any transcript or any
   ground-truth file. That is a separate agent's job, done separately, on purpose — leak isolation.
   An author who knows the target's exact enum members and hazard framing plants transcripts that the
   target trivially aces.
2. **The extractor is a DIFFERENT model than either author** — different from the schema/prompt
   author and different from the corpus/ground-truth author. Prefer **two or more** extractor models
   from different vendors: a single extractor is one datum with no variance; a divergence between two
   on the same transcript is itself a finding (the transcript is genuinely ambiguous, or a field is
   underspecified).
3. **Ground truth lives in its own files and is NEVER shown to the extractor.** The extractor gets
   `prompt.md`, `schema.ts`, and one transcript. Nothing else — not the ground truth, not the other
   transcripts, not `normalization.md`, not this README. An agent doing the extraction must not have
   read access to the ground-truth directory.

Ground truth is not neutral scripture. Where the corpus author judged a case genuinely arguable, the
per-field notes should say so and set partial-credit rules; honour them. If an extractor produces a
defensible answer the ground truth calls wrong, **fix the ground truth and say you did** — that is a
finding about schema or prompt underspecification, not a point for the scoreboard.

## Running the blind extraction

Give the extractor the prompt, the schema, and exactly one transcript. Never the ground truth.

```bash
cd spikes/extraction-snuggpro
mkdir -p results/<model>

# one transcript, one model — schema.ts appended so the run needs no repo access
codex exec "$(cat prompt.md)

--- schema.ts ---
$(cat schema.ts)

--- transcript ---
$(cat transcripts/NN-slug.txt)" < /dev/null > results/<model>/NN-slug.json 2>&1
```

`< /dev/null` is **not optional**: both `codex exec` and `opencode run` read stdin, and a closed
input pipe makes them print their plan and exit 0 — a truncated file with a success status, the
worst possible failure for a batch run. Then sanity-check every output parses as JSON before scoring:

```bash
for f in results/*/*.json; do node -e "JSON.parse(require('fs').readFileSync('$f','utf8'))" \
  || echo "BAD: $f"; done
```

Write raw model output unedited. If a model wraps its JSON in a fence or adds a preamble, keep the
raw file and strip it in the scorer — "did it obey the output contract" is itself a result.

## Score metrics

Compute per model, over all slots, and also per transcript so the probe transcripts read on their
own. **They are not equally important.** The first is the headline; the four after it are what this
schema newly makes measurable.

### 1. Hallucination rate — the headline

> Fraction of genuinely-absent slots (ground-truth `value: null`) where the model emitted a **non-null**
> value. Computed over the scalar/enum fields (the 23 top-level fields).

The entire architecture rests on the claim that one schema-constrained call with nullable+required
fields suppresses invention. A wrong value the auditor catches is an annoyance; a plausible invented
value they do not catch is a defect in a customer report. Read it three ways: overall; on the
absent-heavy probe transcripts alone; and **weighted by temptation** (an error on a baited null — the
"assuming gas meter", the spoken "92% furnace" with no AFUE slot to hold it — is worth more than an
error on an unmentioned field).

Report **wrong-but-grounded** separately from ungrounded: a non-null value that is _quoted somewhere
in the transcript but not asserted by the auditor_ is a real error but a milder one, and it tells you
whether to fix the prompt (grounded — the model isn't tracking assertion vs mention) or reconsider
the design (ungrounded — the model is generating).

**Read it alongside the miss rate, always.** A model that emits nothing but `null` scores a perfect
0% and is useless. The pair is the result.

### 2. Miss rate

> Fraction of ground-truth-non-null slots where the model emitted `null`. Exclude slots the notes
> mark null-`ACCEPTABLE`, and say how many you excluded.

A miss costs the auditor a few seconds of typing — recoverable, and the acceptable side of the trade
the prompt biases toward. High miss rate still means the tool saves no time.

### 3. Axis-split correctness — NEW (hazard 1)

> On every transcript that states a heating (or DHW) system with a fuel, did the extractor land the
> **equipment on the equipment axis and the fuel on the fuel axis**, independently and both non-null?

Scored as a small confusion matrix over the fused mentions in the corpus:

- **Both correct** — "oil boiler" → `{ boiler, fuel_oil }`. The target.
- **Fuel dropped** — equipment right, `heatingFuel: null` when a fuel was stated (even only as an
  adjective). The predicted #1 failure — the fuel was spoken as an adjective and the model treated it
  as decoration. This is the single highest-value rule; weight it.
- **Axis-confused** — fuel folded into the equipment token (a model reaching for an `oil_boiler`-style
  answer and picking `other`, or putting the fuel word in the wrong field).
- **Wrong member** — right axis, wrong enum (e.g. `boiler` read as `furnace_central_ac`).

Report the "both correct" rate and, separately, the fuel-drop rate — the drop rate is the number that
says whether the fuel axis survives a single call.

### 4. Enum-mapping accuracy — NEW

> Of enum fields where ground truth is a specific member, the fraction the extractor mapped to the
> **correct member** — scored on the paraphrase cases specifically, where the spoken form ≠ the stored
> token ("clad" → `wood_or_metal_clad`, "power-vented" → `power_vented_at_unit`, "some but thin" →
> `poorly`).

Separate three outcomes: correct member; **wrong member** (mapped to a real but incorrect enum —
the dangerous case, e.g. collapsing the 3-state `poorly` to `yes`); and **`other`-dumping** (a
mappable phrase parked in `other`, or a genuinely-unlisted answer correctly in `other`). `poorly`↔`yes`
and `other`-when-a-member-fit are the errors to watch.

### 5. Band-mapping accuracy — NEW (hazard 2)

> For banded fields (`atticInsulationDepthIn`, `dhwAgeBand`): given a stated depth/thickness or age,
> did the extractor pick the band whose range contains it?

Score three things distinctly:

- **Correct band** from a stated number ("six inches" → `4-6`, "twelve years" → `11-15`).
- **Boundary error** — off-by-one bucket at a range edge ("exactly 15 years"). Predictable; report it
  as its own bucket, not as a flat wrong.
- **R-value handling** — when the auditor states an R-value and no depth, the target is
  `atticInsulationDepthIn: null` **with the R-value captured in `atticInsulationSpokenRValue`**. A
  model that _converts_ R-38 → `10-12` on its own is a specific, important failure (it did an unsafe,
  lossy conversion the design forbids). Count conversions separately — they are the thing
  [normalization.md](normalization.md) predicts and the corpus is built to expose.

### 6. Health-matrix state accuracy — NEW (hazard 3)

> Per named test, did the extractor emit the correct state? Scored over the 11-test matrix across all
> transcripts.

The two failures that matter most, called out and counted on their own:

- **clean → passed** — an affirmative clean result ("CO was clean", "no spillage") must be `passed`,
  **not** dropped to `null`. The old free-text field dropped these; catching the regression is half
  the reason the matrix exists. Report the rate at which clean results are correctly `passed` vs lost
  to `null`.
- **silence → not a pass** — a test never mentioned must be `null` (which the write layer defaults to
  `Not Tested`), **never** `passed`. A `passed` on a silent test is a **hallucinated pass** — the
  health analog of the headline hallucination, and just as damaging (it asserts a safety test was run
  and clean when nobody said so). Count these explicitly; they are the crux
  [normalization.md](normalization.md) frames.

Accept either `null` **or** `not_tested` for a silent test only if the ground truth marks it so;
otherwise a silent test's ground truth is `null` and `not_tested` on it is a mild miss, not a
hallucination. `failed`/`warning` are scored on whether the reported problem's severity is read right
per the per-field notes.

### 7. sourceSpan validity

> Of non-null values emitted, the fraction whose `sourceSpan` is a **verbatim substring** of the
> transcript (`transcript.includes(span)`, normalising nothing but trailing whitespace).

A model that fabricates provenance is a distinct and serious failure — worse in kind than a wrong
value, because the span is the auditor's only handle for verifying the extraction. Report near-miss
spans (paraphrase, cleaned grammar, normalised numerals, two phrases joined) separately from
wholly-invented ones. Note that for the **axis-split** fields the same fused span legitimately
justifies both `heatingEquipmentType` and `heatingFuel` — a repeated span across those two is
correct, not a defect.

### Confidence is scored indirectly

Ground truth carries no confidence values. What is measurable is **separation**: mean confidence on
correct values vs wrong ones, and on correct `null`s vs hallucinated non-nulls. If there is no
separation — or the common failure, uniformly high confidence including on hallucinations — say so
plainly and do not build review-card flagging on the number. The deterministic fallback signals
(`value != null && sourceSpan == null`, a span that fails the verbatim check) cannot be miscalibrated.

## Reading the result

- **What would invalidate the one-call design.** A hallucination rate materially above zero on the
  absent-heavy probes after a prompt iteration or two — or a **fuel-drop rate** or **hallucinated-pass
  rate** that stays high. Any of these says the schema constraint is not doing the work the design
  assigns it, and the response is a **second validation pass** per non-null field (doc 03's named
  escalation), which changes the latency and cost story.
- **What would suggest the field set is too large.** Accuracy that degrades toward the end of the
  schema or on the longest transcript, or values landing in the wrong-but-adjacent field (CFM25 in
  the CFM50 slot, a depth in the R-value holding-pen). Cross-field bleed is the signature of a model
  juggling more slots than it can hold; the response is to split the call by section (shell /
  mechanicals / safety), not to shrink the pilot set.
- **What would suggest the prompt, not the design, is the problem.** Errors that cluster on one rule —
  all fuel-drops, or all R-value conversions, or all second-speaker attributions. Rule-shaped clusters
  are cheap to fix and say nothing about the architecture. Diffuse errors across every rule are the
  ones to worry about.
- **These numbers are a floor, not a forecast.** Clean text written to be hard is easier than real
  audio through a WASM Whisper model with an un-fine-tuned HVAC vocabulary, recorded next to a running
  furnace. Treat a good result as "the design is not obviously broken, proceed", never as "extraction
  is solved."

## Files

| Path                        | What                                                                                                                                                                       |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema.ts`                 | STALE — pre-rebuild 23-field/11-test copy; kept only because `prompt.md`'s run instructions reference it. The authority is `packages/ribo-adapter-snuggpro/src/schema.ts`. |
| `prompt.md`                 | STALE — the extraction prompt, still written against the pre-rebuild field set; not yet updated                                                                            |
| `normalization.md`          | Design note: LLM-vs-code split. The 4 hazards it names are still real; the field names it quotes are old                                                                   |
| `ground-truth-format.md`    | **The vocabulary-neutral ground-truth format and its rationale** — read this before annotating                                                                             |
| `ANNOTATOR_GUIDE.md`        | **How to re-annotate one transcript** — span rules, retraction, group-negation, the health matrix                                                                          |
| `schema-leaves.mjs`         | Introspects the REAL adapter schema for the leaf list + both enum vocabularies — the resolver                                                                              |
| `ground-truth.mjs`          | The new format's runtime shape check; `isNewFormat` distinguishes new vs. old format files (all 14 are now new)                                                            |
| `validate-ground-truth.mjs` | CLI: `node validate-ground-truth.mjs ground-truth/NN-slug.json` — run this before submitting                                                                               |
| `transcripts/`              | Synthetic auditor dictations — **authored by a different agent** (not built here)                                                                                          |
| `ground-truth/`             | Expected values, all 14 in the new `leaves` format                                                                                                                         |
| `results/<model>/`          | Raw extraction output, one file per transcript (not committed); predates the schema rebuild — stale until re-run                                                           |

Nothing here is production code; nothing is imported by a package. Once the accuracy harness exists
against real recordings, this directory's job is done and the corpus becomes at most a regression
fixture.
