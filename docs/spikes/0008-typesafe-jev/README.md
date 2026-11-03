# 0008 — TypeSafe / Jev for ribo

**Status:** Answered, one measurement still open · **Date:** 2026-09-21 · **Target:**
`api.typesafe.ai`, model `jev-1.13.0`

## The answer

**Two of the four surfaces probed are worth building; two are not, and the negatives are the more
useful half.**

- **Corroboration — build it.** One `choice` per committed value, asking whether the transcript
  `supports` / `contradicts` / `says_nothing` about it, catches 97.9% of substituted values at an
  8.4% false-escalation rate. It shipped as `corroborateExtractor` (ADR 0021).
- **Presence — build it.** Every leaf of every group answered in one ~570ms request, where core's
  chat-backed phase asks one call per group. Recall 1.000, at a threshold that must sit well below
  the obvious one.
- **Enum extraction — do not.** The model invents a value for **100%** of fields nobody mentioned,
  and its confidence is _higher_ on silence (0.939) than on speech (0.929). No threshold separates
  them.
- **A per-leaf review flag — do not.** Identical mappings score 0.41 and 0.61 across transcripts.
  A flag an auditor sees on one leaf and not its twin is one they learn to ignore — the way
  `confidence` already failed here.

Two constraints bind anything built on this: the hosted API sends **no CORS headers for any
origin**, so a browser host needs a proxy; and the rejection ratio is **unmeasured on the current
schema** because producing the input is credential-limited, not merely expensive.

## The method

Eleven probes, run against `jev-1.13.0`. Nothing here is a package, and nothing here should be
promoted to one without being rewritten. What survives is the evidence behind ADR 0020 and ADR
0021, and a harness that finishes the open measurement when a credential allows.

Everything is scored against the **existing annotated corpus** in
[`../0001-extraction-snuggpro/`](../0001-extraction-snuggpro/) — 14 real audit transcripts with ground truth
in the `leaves` format, over the real 51-leaf schema. Enum members come from the built adapter
via that spike's `schema-leaves.mjs`; no member list is hand-copied here.

```bash
pnpm build:packages            # schema-leaves.mjs reads the built adapter
node run-1-reachability.mjs
node run-1b-cors.mjs
node run-2-router.mjs
node run-3-enums.mjs escape && node run-3-enums.mjs bare && node score-enums.mjs
node run-4-triage.mjs
node run-5-cascade.mjs
node run-6-grounded-vs-supported.mjs codex
node run-7-vocab.mjs
node run-8-extract.mjs claude-haiku-4-5   # current-schema fixtures; see probe 8/9
node run-9-fraction.mjs claude-haiku-4-5
```

Needs `TYPESAFE_API_KEY` in the repo-root `.env.local`; probe 8 also needs `HELIX_DEV_TOKEN`.
Probes 1–7 are ~110 requests to Jev and cost nothing at an extraction endpoint.

## What Jev is

`POST https://api.typesafe.ai/v1/systemone` takes a `state` (text only) and a map of questions,
each `noul` (yes-probability), `choice` (member + per-option probabilities + confidence) or
`score` (rubric level + probabilities + confidence). All questions in a request are evaluated in
parallel against the same state. There is **no primitive that fills a schema** — it answers typed
questions, it does not extract. Measured: 61 choice questions returned in ~480ms.

## Probe 1 — reachability

Works from Node (~730ms). **No CORS for any origin.** Preflight returns 400 and no
`access-control-allow-origin` for `http://localhost:5173`, an https origin, `app.typesafe.ai`,
`example.com` or `null`; `access-control-allow-headers` and `-allow-methods` _are_ sent, so CORS
is half-configured server-side. A browser blocks the response regardless.

**Consequence:** Jev can never be called directly from ribo's browser context. Proxy-only, through
the host's transport — the `ribo-transcriber-managed` shape (endpoint + injected `fetch`, no
capacity to authenticate). It is an online rung, never an offline one.

## Probe 2 — router (5 nouls, "does this transcript touch this group?")

One request per transcript, mean **292ms**. 70 transcript×group cells, 34 present / 36 absent.

| threshold | precision | recall | wrongly skipped |
| --------- | --------- | ------ | --------------- |
| 0.50      | 0.850     | 1.000  | none            |
| 0.70      | 1.000     | 0.971  | `08:wall`       |

False positives cluster at 0.50–0.68 — a real uncertainty band, not noise. For a plan phase, where
a false negative is silent data loss and a false positive is a wasted call, 0.5 is the operating
point: nothing skipped, 6 spurious groups of 70.

## Probe 3 — enum leaves (61 choice questions per transcript)

93 spoken cells (ground truth asserts a member), 761 silent ones — every `*Improved` field and
every `windowExteriorTreatment*`, which no transcript mentions.

| arm                       | exact member | wrong member | invented on silent cells |
| ------------------------- | ------------ | ------------ | ------------------------ |
| `bare` (members only)     | 94.6%        | 5.4%         | **761/761 — 100%**       |
| `escape` (+ "Not stated") | 84.9%        | 1.1%         | 11/761 — 1.4%            |

**`choice` confidence does not detect silence.** In the bare arm mean confidence is 0.929 on spoken
cells and **0.939 on silent ones** — silence scores _higher_. Eight inventions came back at
confidence 1.00 (`atticRadiantBarrier = "No"`, `hvacHeatPumpInverter = "No"`, …). Gating at 0.95
still admits 77% of them. Any design that plans to use `choice` confidence as a
did-they-say-it signal is dead on arrival.

An explicit "Not stated" option fixes it (98.6% suppression) at a cost of ~10 points: 14% of
genuinely-spoken leaves get wrongly suppressed.

Not chased: the corpus's `arguable.acceptableAlternatives` path scored zero hits in both arms.
Plausible with 1 and 5 wrong members, but unproven — the scorer's reading of that field is
untested.

## Probe 4 — review triage (a noul per extracted field/value pair)

Three populations: `supported` (ground truth's own value), `corrupted` (same leaf, a different
member of its own enum), `invented` (a silent leaf paired with the value **the bare arm actually
produced** — a real hallucination from this model, not a synthetic one).

| population | n   | mean noul | median |
| ---------- | --- | --------- | ------ |
| supported  | 95  | 0.804     | 0.95   |
| corrupted  | 95  | 0.035     | 0.02   |
| invented   | 761 | 0.146     | 0.07   |

| gate | supported kept | corrupted caught | invented caught |
| ---- | -------------- | ---------------- | --------------- |
| 0.50 | 84.2%          | 98.9%            | 91.7%           |
| 0.60 | 82.1%          | 100.0%           | 94.0%           |
| 0.70 | 80.0%          | 100.0%           | 94.9%           |

A purpose-built verification question sees what `choice` confidence could not: wrong-member
substitution is caught completely, and 94% of the model's own hallucinations are caught.

**The residual leaks are not random.** Of the 46 inventions surviving a 0.60 gate, 21 are
`*Improved` fields — the model inferring a post-upgrade value from the stated existing one — and
most of the rest are inference-shaped: `hvacHeatingIsCondensing` from a high-efficiency furnace,
`atticInsulationDepth` from an R-value. That last one is **the hazard the corpus already annotates
by name** (HAZARD 2b in transcript 01). Jev is treating _implication_ as _support_; the noul's
instructions say "supports", and it answered that question honestly. Tightening to "stated, not
implied" is the obvious next probe and is not run here.

## Probe 5 — the SDE-cascade verifier formulation

[The SDE cascade cookbook](https://docs.typesafe.ai/cookbooks/sde_cascade) formulates verification
two ways probe 4 did not: it asks **P(wrong)** rather than P(supported), and it asks several
orthogonal questions per field, aggregated with `any(p > FIRE_T)` so one strong signal is never
averaged into silence. Run on probe 4's exact cells, so the two are comparable.

Four checks (the cookbook's set minus `type_mismatch`, `format_violation` and `incomplete`, all
vacuous here — every value is an enum member by construction and these leaves are single-valued):

| population | hallucinated | off_target | name_desc | unreasonable | max   |
| ---------- | ------------ | ---------- | --------- | ------------ | ----- |
| supported  | 0.200        | 0.310      | 0.339     | 0.164        | 0.389 |
| corrupted  | 0.909        | 0.848      | 0.783     | 0.875        | 0.934 |
| invented   | 0.893        | 0.862      | 0.619     | 0.344        | 0.919 |

Inverting the polarity is what matters. At `FIRE_T = 0.70` it beats probe 4 on both axes at once —
96.2% of inventions caught vs 94.9%, while wrongly escalating 17.9% of good values vs 20.0%. The
residual leak drops from 46 cells to 29, and the `*Improved` share from 21 to 14.

**Two of the four checks are doing the work.** Scoring subsets offline from `results/cascade.json`:

| subset                      | FIRE_T | supported escalated | corrupted caught | invented caught |
| --------------------------- | ------ | ------------------- | ---------------- | --------------- |
| all four                    | 0.60   | 21.1%               | 100.0%           | 98.0%           |
| `hallucinated + off_target` | 0.60   | **14.7%**           | **100.0%**       | **97.6%**       |

Dropping `name_desc_mismatch` and `unreasonable` cuts false escalation by a third for ~0.4 points
of catch, and halves the question count. `name_desc_mismatch` is the noise source — it fires at
0.339 on values that are correct. `unreasonable` is near-blind to inventions (0.344), which stands
to reason: an invented value is plausible, and that is exactly why the model invented it.

## Probe 6 — grounded x supported, on real extractions

Run against `../0001-extraction-snuggpro/results/codex`, the only extractions in the repo carrying
real model-produced `sourceSpan`s. 124 committed leaves.

| groundedness | supported | unsupported |
| ------------ | --------- | ----------- |
| grounded     | 108       | 16          |
| near-miss    | 0         | 0           |
| ungrounded   | 0         | 0           |

**Every committed leaf is grounded**, so there is no 2x2 — `groundedness` discriminates nothing
on this corpus, matching what `provenance.ts` already records ("every one of the 77 spans checked
was verbatim"). Every leaf also carries `confidence: 1`.

Of the 16 flagged, inspection (not ground truth — these results are old-schema and cannot be
scored against the re-annotated corpus) shows a mix: five are the documented equipment/duct axis
conflation, but several are _correct_ — `dhwAgeBand = "0-5"` for "Yeah, two years",
`heatingFuel = "natural_gas"` for "a gas furnace". The verifier was measuring **schema-mapping
distance**, not hallucination.

## Probe 7 — telling the verifier the vocabulary

The extractor is told the enum members when it chooses; probe 6's verifier was not, so it was
asked a harder question. Probe 7 hands it the same member list and states that a faithful
encoding counts as supported. Same 124 leaves.

**16 flagged -> 10.** The six that cleared are exactly the mapping category:

| leaf                          | span                          | before | after |
| ----------------------------- | ----------------------------- | ------ | ----- |
| `dhwAgeBand = "0-5"`          | "Yeah, two years"             | 0.74   | 0.54  |
| `heatingFuel = "natural_gas"` | "Heat's a gas furnace"        | 0.70   | 0.38  |
| `dhwAgeBand = "11-15"`        | "it's maybe twelve years old" | 0.68   | 0.41  |

Of the 10 that remain, **five are the same field** — `heatingEquipmentType = "furnace_central_ac"`
against a span that says only "furnace" — plus a sixth, `coolingEquipmentType = "other"` for
"Central AC on the same ducts", which is the same defect from the cooling side. That is the axis
conflation the corpus annotates as a SCHEMA FINDING, not a model error.

**The residue is inconsistent, and that is the limiting result.** `heatingFuel = "natural_gas"`
from "a gas furnace" scores 0.38 in transcript 01 and 0.65 in transcript 07. `dhwAgeBand = "11-15"`
scores 0.41 for "maybe twelve years old" and 0.61 for "About fifteen years old". Identical
mappings land on both sides of the threshold. That is variance, not a threshold to tune.

**Caveat:** this measures the OLD 23-field schema, which the 51-leaf rebuild already partly fixed.
The conflation persists in the new schema (`hvacSystemEquipmentType` carries `arguable` in the
re-annotated ground truth), but the flagged population on new-schema extractions is unmeasured.

## Probe 10 — presence at leaf granularity

Probe 2 measured whether a transcript touches a GROUP. That is not what core's `presencePhase`
produces: it emits per-group maps of per-LEAF booleans. This asks the per-leaf question for all
159 leaves of the five covered groups, in **one request per transcript (~570ms)** rather than
`presencePhase`'s one call per group. 2226 transcript x leaf cells, 135 discussed (6.1%).

| threshold | precision | recall | wasted items/transcript |
| --------- | --------- | ------ | ----------------------- |
| 0.20      | 0.326     | 1.000  | 19.9                    |
| 0.30      | 0.421     | 1.000  | 13.3                    |
| 0.40      | 0.487     | 0.978  | 9.9                     |
| 0.50      | 0.551     | 0.956  | 7.5                     |

**Probe 2's threshold does not transfer.** At 0.50 — the group-level operating point — six leaves
are silently dropped, including `hvac.hvacSystemEquipmentType` at 0.32. A false negative here is
silent data loss: the leaf is seeded null and no later phase ever plans an item for it.

**And recall 1.000 is one leaf wide.** The populations overlap — discussed leaves score as low as
0.30 (median 0.93, p5 0.51) while undiscussed ones reach 0.98. The lowest true positive _is_ 0.30,
so a new transcript could easily land a discussed leaf below it. 0.20 is the defensible setting:
recall 1.000 with headroom.

Precision is the wrong lens. The alternative to a presence phase is planning an item for all 159
leaves; at 0.20 it plans ~33. The phase's job is shrinking 159 to a few dozen without losing
anything, and it does that.

Not measured: head-to-head against core's chat-based `presencePhase`, which needs extraction calls
and hits the same wall as probe 8.

## Probe 11 — one three-way choice, against two nouls

[The citation-check cookbook](https://docs.typesafe.ai/cookbooks/citation_check.md) splits
verification differently: a string match for whether the quote exists, then ONE choice asking
whether the context `supports` / `contradicts` / `says_nothing` about the claim. Step 1 is
`spanGroundedness`, and the limitation the cookbook names — a truncated or reworded quote reading
as fabricated — is what this repo's `near-miss` tier already solves. Only step 2 was missing.

Run on probe 4's exact cells, so it is directly comparable to probe 5.

| population | n   | supports | contradicts | says_nothing |
| ---------- | --- | -------- | ----------- | ------------ |
| supported  | 95  | 91.6%    | 5.3%        | 3.2%         |
| corrupted  | 95  | 2.1%     | **97.9%**   | 0.0%         |
| invented   | 761 | 7.9%     | 1.1%        | **91.1%**    |

Compared at a **matched false-escalation rate**, the only fair comparison since the two-noul form
has a tunable threshold and "escalate when not `supports`" does not:

| at 8.4% of good values escalated | corrupted caught | invented caught |
| -------------------------------- | ---------------- | --------------- |
| two nouls, max (FIRE_T 0.79)     | 87.4%            | 92.4%           |
| one three-way choice             | **97.9%**        | 92.1%           |

+10.5 points on substituted values, a tie on inventions, same cost. And it makes a distinction two
nouls structurally cannot: `contradicts` (the field was discussed and the value is wrong — a
re-ask can fix it) versus `says_nothing` (never mentioned — the honest repair is null).

Confidence works as a second axis but is not needed: gating at 0.70 cuts false escalation to 1.1%
while dropping invented catch to 83.7%.

## Read

Router and cascade-style verification both land. The naive enum extractor does not, and its
failure is sharp enough to be useful: silence is invisible to `choice` confidence but plainly
visible to a `noul` that asks about absence directly.

The shape that fits ribo is the cookbook's, not a new extractor: the existing single-shot
`ribo-extractor-openai` stays the cheap stage, a two-question verifier scores each extracted
field, and too large a ratio over threshold escalates to the next rung. That is an
arbitration policy over seams ribo already has, not a new extraction path.

## Where this landed

**`corroborateExtractor` — the second judging combinator** (`validateExtractor` is the first;
ADR 0002, `sp2-judging-combinators-design.md` §4.2). Same factory shape: wrap an `Extractor`,
take a census, hand it to a synchronous policy, return the result by identity or throw a
`TerminalError` so `terminalFallsThrough` continues to the next rung. The SDE cascade's
escalation is then just `fallbackExtractor([corroborated(cheap), reasoning])` — no new
scheduling, no arbiter change, no new seam.

It differs from `validateExtractor` in exactly one way: one async step between census and
policy, because the measurement needs a network call. `validateExtractor` stays pure and
emits no observer units; this one cannot borrow those properties.

Deliberately NOT built, on probe 6/7 evidence: no `ReviewField` flag, no
`BuildReviewRequestOptions` member, no envelope change, no migration. The judgement picks a
rung; it never reaches an auditor. Per-leaf scores are too inconsistent to show a human — the
policy thresholds a **ratio of committed leaves**, never a single one.

**One client for both providers.** kev implements the same System One API, so `SystemOneClient`
takes `endpoint` + injected `fetch` + `model` and nothing provider-specific. Hosted Jev, a
self-hosted `kev.serve`, or a future in-browser rung are the same seam with a different
implementation — the combinator never learns which.

**On-device is later, not never.** The kev HuggingFace Space is `sdk: gradio` on `zero-a10g`
hardware — server-side Python inference, with the browser as UI only. No ONNX, no
transformers.js, no WASM. Kev-0.8B could in principle be ONNX-exported and run under WebGPU the
way `ribo-transcriber-ondevice` does, but nothing like that exists today and 0.8B is the only
plausible size.

> **Superseded, 2026-09-22 — see [spike 0010](../0010-kev-ondevice/).** An ONNX export
> (`onnx-community/kev-0.6b-ONNX`, the 0.6B Qwen3-generation checkpoint) now exists and runs under
> transformers.js/WebGPU at 860 ms a pass. The paragraph above is left as written; what it got
> wrong was the availability, not the conclusion. 0010 measured the model on these same cells and
> still says do not build: `contradicts` wins 0 of 951 cells.

## Probe 8/9 — the ratio on the current schema

Blocked, and worth recording why. Measuring the rejection ratio needs current-schema extractions;
none exist, because everything in `../0001-extraction-snuggpro/results/` predates the 51-leaf rebuild.
Producing them means the production path — `perGroupExtractor` over `snuggProAdapter`, which
carries the 467-leaf schema through all 20 groups for **376k input tokens and 66 calls per
transcript**. Group scoping cannot trim it (ADR 0009).

That exhausts the Helix dev token's **burst spend budget** on the first transcript: of 28 attempts
across two rungs, 1 succeeded and 27 returned `429 burst spend budget exhausted`. The Azure Foundry
resource in `.env.local` is no alternative — its catalog lists 474 models and has zero deployments,
so every id returns `DeploymentNotFound` — and the `OPENAI_API_KEY` there is rejected as invalid.

The one transcript that completed (`claude-haiku-4-5`, `01-attic-r-value-shell`): **23 committed
leaves, 5 uncorroborated at 0.6, ratio 0.217**, with **22 of 23 grounded**. The second figure is
the useful one — probe 6's degenerate-groundedness result reproduces on the shipped schema. The
ratio is a magnitude, not a distribution.

`run-8-extract.mjs` and `run-9-fraction.mjs` are the working harness; a credential without a burst
cap, or a drip of one transcript per budget window, completes this whenever it is wanted.

Open before implementation: `enumMembersAt` (gap-fill's `leafSchemaAtPath` already walks a leaf's
schema, so it would move to core). The rejection ratio is deliberately **not** defaulted — see
ADR 0021.

## Addendum, 2026-10-29 — Microsoft-Decision-1

Microsoft released Decision-1 on 2026-10-09: a 9B model post-trained from Qwen3.5 and served on
the same System One wire as Jev. On Foundry it is `POST <resource>/providers/microsoft/v1/systemone`,
so `systemOneClient`'s `endpoint` is `<resource>/providers/microsoft` and `model` is the
deployment name. It authenticates with an `api-key` header, so the host `fetch` drops the SDK's
placeholder `Authorization`. No client change was needed. The resource in `.env.local` now has a
deployment, `md-1`, so the "zero deployments" above no longer holds.

Probes 2–7, 10 and 11 were re-run on today's corpus against both models, plus a new probe 12
(`run-12-stability.mjs`: the same questions asked again, and asked with each option list
reversed). `SYSTEMONE=jev|md-1` picks the model. A set target writes `results/<target>/`, which is
not committed; the table below is the record. Unset still reads and writes the September results
above, which are untouched.

| Use in ribo                                       | Jev                    | Decision-1                    |
| ------------------------------------------------- | ---------------------- | ----------------------------- |
| Leaf presence (probe 10): recall 1.000 up to      | 0.30 (0.941 at 0.50)   | **0.40** (0.985 even at 0.70) |
| Corroboration (probe 11): wrongly escalated       | **8.1%**               | 10.1%                         |
| … corrupted caught / invented caught              | 98.0% / 91.2%          | 99.0% / 88.4%                 |
| Two-question verifier (probe 5, 0.60): escalated  | **19.2%**              | 33.3%                         |
| Group router (probe 2, 0.50): precision / recall  | 0.872 / 1.000          | 0.810 / 1.000                 |
| Confidence on spoken vs silent fields (probe 3)   | 0.932 vs 0.932         | 0.978 vs 0.772                |
| Enum with a "not stated" escape: exact / invented | 85.6% / 2.1%           | 95.9% / 5.6%                  |
| Flips when asked again: choice / presence         | 0.78% / 0.67%          | 1.56% / 0.90%                 |
| Flips with options reversed                       | 2.68%                  | 1.00%                         |
| Latency per request: router / 64 enums / presence | **208 / 255 / 439 ms** | 344 / 737 / 1435 ms           |

Decision-1 is better at leaf presence, where its recall survives a much higher threshold. Jev is
better at verification and 1.6–3× faster from here, though the Decision-1 deployment is an eastus2
`GlobalStandard` one. Decision-1's confidence separates spoken fields from silent ones, where
Jev's does not, but a 0.95 gate still lets 39% of inventions through. So ADR 0021's finding
stands. Microsoft's launch claim of zero flips under reordered options did not reproduce (1.00%).

[Spike 0012](../0012-narrowing-end-to-end/) runs both as the presence model behind
`presenceNarrowedExtractor`, end to end. There, after three fixes, the two are level on
extraction accuracy.
