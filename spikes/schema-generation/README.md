# Schema-generation mapping spike

**Question.** Can an LLM produce the **field mapping** — for each of our concepts, which Snugg Pro
spec field is it, what are its enum members, what is its type — well enough to generate committed
types from, at build time? Not "can it extract values from a dictation" (that's
`spikes/extraction-snuggpro/`) and not "can it fit the whole spec in one schema" (that's closed on
hard limits — [doc 16](../../docs/implementation/16-extraction-schema-scale.md)). This is a third,
narrower question: **spec-to-code mapping**, the thing `pnpm snugg:refresh` (R1.7) would need to do
unattended.

**Hypothesis.** Given the relevant slice of the spec plus our patch schema, a single-shot LLM call
can locate the correct spec property for most of our 34 leaves and get most enum vocabularies right,
because the mapping problem is mostly **lookup with fuzzy name-matching**
(`heatingManufacturer` → `hvacHeatingSystemManufacturer`) — a task LLMs are typically strong at, and
categorically easier than the extraction spike's problem (parsing a spoken paraphrase into a token),
since here the source text is already structured JSON with descriptions, not free speech.

**Counter-hypothesis, taken seriously.** The mapping task's failure mode is worse than extraction's.
An extraction miss produces `null` — an auditor sees a blank field and types it in. A **mapping**
miss that goes undetected produces a wrong committed line of generated TypeScript that nobody
re-checks, because the whole point of "generate at build time" is to stop hand-checking it. A model
under time pressure to answer for all 34 leaves has every incentive to output _something_
plausible-sounding for the hard cases rather than admit it isn't sure — exactly the
nearest-neighbour-invention failure this spike is built to catch, and doc 17 shows five real cases
where the honest answer is "the naive nearest neighbour is wrong." If the model's errors cluster
there, a positive-looking aggregate score is actively dangerous: it would license shipping a
generator whose output looks committable and is wrong exactly where it matters.

> **The design below is written and committed before any evaluation runs.** That is the
> anti-overfitting control this repo's other spikes use
> (`spikes/extraction-search-plan/README.md`): the scope, the input slice, the prompt, and the
> scoring rubric are fixed now, before anyone has seen a model's answer. Any change made after
> seeing output is disclosed in [Results](#results), with counts, same as that spike's convention.

---

## Established facts this spike relies on, not re-derives

- **The answer key.** [Doc 17](../../docs/implementation/17-snuggpro-field-reconciliation.md) is a
  hand-done, field-by-field reconciliation of all 34 leaves of
  `packages/ribo-adapter-snuggpro/src/schema.ts` (`snuggValuesSchema`) against the live
  `https://app.snuggpro.com/apidocs/swagger.json`. It records, per leaf: the matching spec property
  and endpoint (or "not found"), the verbatim spec enum, and a verdict (match / match (format) /
  partial / mismatch / not found).
- **Whole-spec extraction is closed on hard limits, not quality** —
  [doc 16](../../docs/implementation/16-extraction-schema-scale.md): `allJobData` enveloped is
  ~5,360 properties / ~1,490 enum values against OpenAI's 5,000/1,000 caps. That finding is about
  the **extraction** schema (what a model is asked to fill from a transcript). This spike asks a
  different question — feeding spec _text_ to a model as **reference material for a mapping task**,
  answered with a small JSON object, not asked to fill a giant schema — so doc 16's property/enum
  ceilings don't directly bind here. What still binds is context size and signal-to-noise, addressed
  under [Input strategy](#input-strategy-the-variable-that-likely-dominates).
- **The scoping arithmetic.** `basedata` alone is 294 form fields; after excluding 122 `*Improved`
  retrofit-proposal fields and 9 self-described auto-calculated fields, the auditor-dictatable
  capture surface is **163** fields (doc 17 §Scoping). This spike maps the current **34**, not the
  163 — see [Scope](#scope-the-34-leaves-taken-as-input).
- **The roadmap context.** R1.6/R1.7 (`docs/roadmap/index.md`) are the reason this question matters:
  R1.7 plans a `pnpm snugg:refresh` script that generates wire field names and leaf types from the
  spec into a committed `*.generated.ts`, following the `pnpm target:refresh` precedent — a script
  whose real logic is typechecked and unit-tested, not run by CI, so a vendor change lands in a
  reviewable diff. Enum vocabularies are **deliberately out of R1.7's first cut** for exactly the
  reason this spike exists: nobody has yet measured whether a model can produce them reliably enough
  to trust in that diff.

---

## Scope: the 34 leaves, taken as input

The field **set** is not this spike's question — see
[Selection is out of scope](#selection-is-explicitly-out-of-scope). The 34 leaves are the existing
23 top-level fields of `snuggValuesSchema` plus the 11-test `healthSafety` matrix, exactly as
committed in `packages/ribo-adapter-snuggpro/src/schema.ts` today:

```
heatingEquipmentType, heatingFuel, heatingManufacturer, heatingModelNumber, heatingModelYear,
heatingOutputCapacityBtuh, coolingEquipmentType, ductLocation, ductSealing, ductInsulation,
ductLeakageCfm25, atticInsulationDepthIn, atticInsulationType, atticInsulationSpokenRValue,
wallInsulated, wallConstruction, blowerDoorCfm50, windowGlazing, windowFrame, dhwFuel,
dhwSystemType, dhwAgeBand, combustionVentType
+ healthSafety.{ambientCo, venting, naturalConditionSpillage, worstCaseDepressurization,
  worstCaseSpillage, draftPressure, gasLeak, moldMoisture, asbestos, lead, electrical}
```

Doc 17 already produced a verdict for every one of these against the live spec. That is what makes
the spike answerable **now**, without waiting on the fill-rate-driven next tranche: there is a
hand-built answer key sitting in the repo already, for exactly this field set.

---

## The three hard cases (weight these; don't average them away)

An aggregate accuracy number over 34 leaves can look good while being wrong on the cases that
matter. These three are called out by name and scored/reported individually, not folded into one
headline percentage:

1. **Enum-membership divergence** (not mere format), on the ~5 leaves doc 17 identifies where the
   spec's option list is not a superset/relabeling of ours: `ductInsulation` (spec has 9 members,
   ours 6 — missing `Duct Board 1"`, `Duct Board 2"`, `Reflective bubble wrap`, `Measured (R Value)`),
   `windowGlazing` (spec adds a triple-pane + storm/low-e members we don't have), `dhwFuel` (spec
   adds `Pellets`/`Wood`), `wallInsulated` (spec is 4-state — `Well` distinct from generic `Yes` —
   ours is 3-state), and the health matrix (spec has 13 tests on the 4-state enum, not 11 — missing
   `healthUndilutedFlueCo` and `healthRadon`). A correct answer here must report the **actual spec
   member list**, not our list relabeled into Title Case — getting the format transform right while
   missing an added/removed member is a **partial**, not a match, and is exactly the "plausible but
   wrong" failure this spike exists to detect.
2. **`combustionVentType` has no write target.** The `caz` resource is GET-only; no vent-type field
   or value list exists anywhere in the 1.2 MB document. The correct answer is an explicit,
   evidenced "not found" — not a guess at the nearest-sounding property, and not a silent omission
   from the model's output (see [scoring](#distinguishing-no-match-from-silence) for how "correctly
   found nothing" is told apart from "didn't look").
3. **The heating/cooling fusion.** `heatingEquipmentType` and `coolingEquipmentType` are not two
   spec fields — they are the **same** `hvacSystemEquipmentType` property on a per-HVAC-system
   record (which can itself represent a combined heat-pump unit), and that property is `required`
   with 17 members against our combined 14 (7 + 7, one shared: `central_heat_pump`). A model that
   reports two independent spec fields — even if each individually resembles a plausible property
   name — has made a structural error the others don't have a name for. This is scored as its own
   category, separate from "wrong field" and separate from "membership divergence," because the
   defect isn't which field, it's the **cardinality**: one spec field standing in for two of ours.

---

## Input strategy: the variable that likely dominates

The spec is ~1.2 MB, Swagger 2.0, 91 paths, 61 definitions. Three options, in the order they were
considered and rejected/chosen:

**Rejected — whole spec, as-is.** Even setting aside raw size, most of the document is irrelevant to
these 34 leaves: financing, incentives, recommendations (other than the one row noted below), work
orders, utility accounts, PV, pool/EV/dishwasher basedata fields. Handing all of it to the model
dilutes attention across ~40 resource types when only ~8 matter, and — per doc 16 — even the parts of
this repo's _own_ pipeline that do have to obey hard property/enum limits treat "the whole spec" as
infeasible for exactly this reason (signal-to-noise, not raw byte count, degrades a model's account
of "what matters here"). Untested cost of a genuinely bad answer (a hallucinated but plausible
mapping) is high enough that "give the model everything and hope it filters well" is not an
acceptable default to test first.

**Rejected — index-then-fetch (agentic tool-use loop).** Give the model the list of 91
paths/61 definition names + one-line descriptions, let it request specific definitions to inspect
before answering. Rejected for this spike specifically because it conflates two different abilities:
_can the model find the right part of the spec_ and _can it map correctly once it has the right
part_. This spike's question is the second one. An index-then-fetch design would need its own
scoring for "found the right resource in how many hops," which is a legitimate but different
question — worth a follow-up, not this spike (also: it introduces run-to-run variance from tool-call
ordering that a single-shot design doesn't have, and the search-plan spike already found that
decomposing a single call into stages introduces new failure modes rather than removing them).

**Chosen — a pre-filtered, curated subset.** Give the model the **full, unabridged** JSON
definitions for exactly the resources doc 17's own reconciliation needed to answer all 34 rows:
`basedata` (294 formData parameters — the largest single slice, included whole because trimming it
further would presuppose the answer), `hvac`, `attic`, `wall`, `window`, `dhw`, `health`, and `caz`
(GET-only — included specifically so the model can observe, not assume, that it has no write verb
and no vent-type field, which is what makes a correct `combustionVentType` "not found" verdict
_evidenced_ rather than a shrug). Each resource's full property list is included — not just the
properties that happen to match one of our 34 leaves — so the model still has to **disambiguate**
among dozens of candidates per resource (`hvac` alone has 73 properties) rather than being handed an
answer key with the noise stripped out.

**Why this isn't the "selection is out of scope" problem in disguise.** Choosing _which spec
resources are plausibly relevant to an already-fixed 34-leaf field set_ is a different act from an
LLM reading the spec and deciding _which of the spec's 294+ fields are worth capturing at all_ — the
latter is the product decision this spike explicitly declines to make (next section). The resource
list here is fixed by us, from the field set we already have, the same way doc 17's own author
picked which endpoints to search; it does not select fields, and it does not tell the model which
property within a resource is the answer.

**Reproducibility caveat, inherited from doc 17.** No spec snapshot is committed to this repo (doc 17
explicitly declines to commit one, deferring that decision to R1.7). Running this spike means
fetching the live URL fresh; if Snugg Pro changes the spec between the design being written and the
run happening, doc 17 and the run's input could disagree for a reason that has nothing to do with
the model. Record the fetch date and, ideally, a hash of the fetched document alongside results.

---

## Selection is explicitly out of scope

This spike answers "can a model map a fixed field to a fixed spec correctly," not "which fields
should we ask it to map." Those are different questions with different failure costs, and
conflating them would make a bad mapping result look like a bad field-set result or vice versa.

The repo owner has already decided how the _next_ field tranche gets chosen — from real fill-rate
data (the 14-transcript corpus for what auditors _say_, and the Snugg Pro API for what real jobs
_contain_) — precisely because the spec cannot answer that question: it has no way to say a field is
filled on 3% of jobs versus 90%. An LLM reading the spec and picking what "looks important" would be
substituting spec-shape intuition for the fill-rate evidence that decision explicitly requires. This
spike takes the field set as a given input and never asks the model to propose one.

**A correction this design does not bake the superseded version of.** Doc 17's closing section
records that auditors _narrate recommendations_ — "there's an oil boiler here, we should get rid of
it" carries `hvacUpgradeAction: "Remove a system permanently"` as directly as it carries `Boiler` —
which makes `hvacUpgradeAction` extractable and supersedes doc 15's recommendation to hard-code it.
That means the 163-field capture surface is a **floor, not a ceiling**: the `*Improved`-exclusion
reasoning it rested on ("a retrofit decision, not a walkthrough observation") was too broad, and the
finer cut is that upgrade _intent_ is dictated while improved _specs_ are not. This spike's field set
(the current 34) doesn't include `hvacUpgradeAction`, so the correction doesn't change today's input
list — but it is noted here so nobody reads a positive mapping result on the current 34 as evidence
that the 163-field floor (or `hvacUpgradeAction` specifically) is the right or complete next set.
Incidentally: doc 17's required-field table already shows `hvacUpgradeAction` is a **required**
property on the same `hvac` resource this spike's input slice already includes in full — so if/when
the field set grows to include it, this spike's chosen input strategy would not need to change to
cover it.

---

## Method

One call per model, cold, no iteration. Both models get identical input:

1. **The spec slice** — the eight resources' full JSON definitions, as described above, fetched
   fresh from `https://app.snuggpro.com/apidocs/swagger.json`.
2. **The patch schema** — `packages/ribo-adapter-snuggpro/src/schema.ts` verbatim (source of truth
   for the 34 leaves, their current types, and their current enum vocabularies), so the model knows
   exactly what "our concept" means for each leaf without us re-describing it in prose (and risking
   a description drifting from the real schema).
3. **The prompt** below, asking for a structured answer per leaf.

No ground truth, no doc 17, no hints about which cases are hard — the model sees only what a real
`snugg:refresh` run would see.

### Prompt (fixed before running)

```
You are mapping our internal Snugg Pro field set onto Snugg Pro's real API, described by the
attached OpenAPI (Swagger 2.0) JSON definitions for these resources: basedata, hvac, attic, wall,
window, dhw, health, caz.

Our field set is the attached schema.ts (`snuggValuesSchema`). For EACH of the 34 leaves listed
below, decide which spec property (if any) is the correct write target, and answer in the JSON
shape given.

Leaves (dot-path for the nested health matrix):
heatingEquipmentType, heatingFuel, heatingManufacturer, heatingModelNumber, heatingModelYear,
heatingOutputCapacityBtuh, coolingEquipmentType, ductLocation, ductSealing, ductInsulation,
ductLeakageCfm25, atticInsulationDepthIn, atticInsulationType, atticInsulationSpokenRValue,
wallInsulated, wallConstruction, blowerDoorCfm50, windowGlazing, windowFrame, dhwFuel,
dhwSystemType, dhwAgeBand, combustionVentType, healthSafety.ambientCo, healthSafety.venting,
healthSafety.naturalConditionSpillage, healthSafety.worstCaseDepressurization,
healthSafety.worstCaseSpillage, healthSafety.draftPressure, healthSafety.gasLeak,
healthSafety.moldMoisture, healthSafety.asbestos, healthSafety.lead, healthSafety.electrical

For each leaf, output an object:
{
  "leaf": "<name>",
  "matchFound": true | false,
  "specProperty": "<exact property name>" | null,
  "specEndpoint": "<path>" | null,
  "specType": "string" | "integer" | "number" | "enum" | null,
  "specEnumMembers": ["<verbatim spec string>", ...] | null,
  "sharedWith": "<other leaf name, if this spec property is the SAME property as another leaf's
    answer>" | null,
  "evidenceNote": "<what you checked, in one sentence — required whenever matchFound is false, or
    whenever a resource you'd expect to hold this field turned out not to>"
}

Rules:
- If no corresponding property exists anywhere in the attached resources, set matchFound: false,
  specProperty: null, and use evidenceNote to say what you checked and ruled out. Do not guess a
  nearest-sounding property and report it as found.
- If two of our leaves map to the exact same spec property, say so via `sharedWith` on both —
  do not invent two separate spec properties to keep them apart.
- specEnumMembers must be the spec's own strings, verbatim (exact casing/punctuation), not our
  tokens relabeled. If the spec's enum list is empty/dynamic (declared but no static members),
  set specEnumMembers: [] and say so in evidenceNote.
- Output all 34 objects as a single JSON array. No prose outside the array.
```

### Models

Run on at least two models from different vendors, for the same reason
`spikes/extraction-search-plan/` insists on it: a single model is one datum with no variance, and a
disagreement between two models on the same leaf is itself informative (it flags an ambiguous or
underspecified case worth a closer look, independent of which one — or neither — matches doc 17).
Reuse whichever two currently-available models the corpus spikes already track, so results are
comparable across this repo's spikes rather than introducing a third, unrelated model family.

---

## Scoring (fixed before results exist)

### Per-leaf verdict

Each leaf gets exactly one of these outcomes, in order of severity **worst first** — because the
aggregate number this spike should be judged on is not "% correct," it is the **count in the bottom
tier**:

| Tier      | Outcome                                  | Definition                                                                                                                                                                                                                        |
| --------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4 (worst) | **Hallucinated match**                   | `matchFound: true` pointing at a spec property that does not exist in the attached resources, or at a real property that is not the correct write target and the model gave no evidence it considered alternatives.               |
| 3         | **Miss**                                 | `matchFound: false` on a leaf doc 17 (or its adjudicated correction — see below) found a real spec property for, when the evidence note shows no meaningful search happened (see [below](#distinguishing-no-match-from-silence)). |
| 2         | **Wrong field**                          | `matchFound: true`, a real spec property, but not the one doc 17/adjudication says is correct, **with** an evidence note showing genuine (if mistaken) reasoning.                                                                 |
| 1         | **Correct field, wrong enum membership** | Right spec property and endpoint, but `specEnumMembers` is our list relabeled rather than the spec's real list, or omits/adds members materially (see next section).                                                              |
| 0 (best)  | **Match**                                | Right spec property, right endpoint, and — for enum leaves — the verbatim spec member list, or an honestly-flagged empty/dynamic enum.                                                                                            |

Report the **count in tier 4 and tier 3 first**, ahead of any overall percentage — a model that
scores 30/34 at tier 0 but 2/34 at tier 4 (two confident, wrong, undetected mappings) is a worse
result for "generate committed types from this" than a model at 25/34 tier-0 with zero tier-4s. The
whole premise of the counter-hypothesis is that these two models could look similar on a naive
accuracy percentage while being very different in how safe they are to automate.

### Enum verdict, scored independently for enum-typed leaves

For each leaf where doc 17 lists a spec enum: exact-set match / partial (model's list is a subset or
superset of the true list, i.e. it found the right idea but not the right boundary) / wrong (model's
list bears no real resemblance — invented values, or the format-transform applied to our tokens
without checking the spec's actual options). The five hard cases in
[the section above](#the-three-hard-cases-weight-these-dont-average-them-away) are reported by name,
individually, not folded into this table's aggregate — a model can score 100% "exact-set match" on
the other ~22 enum leaves (which, per doc 17, are mostly a mechanical Title-Case transform) and still
fail the harder five, and that split is the entire point of calling them out.

### Distinguishing "no match" from "didn't look"

A bare `matchFound: false` with no evidence is not credited as a correct negative, even when it
happens to agree with doc 17 — an unexamined guess that happens to be "no" is not the same
capability as `combustionVentType`'s correctly-evidenced negative (doc 17: searched the full
document text for `"Induced Draft"`, `"Power Vented"`, `"Direct Vented"`, `"ventSystemType"` — zero
matches; confirmed `caz` is GET-only with no write verb). Concretely: a `matchFound: false` is scored
as **tier 2 (correctly-evidenced no-match)** only if `evidenceNote` names a specific resource/property
it expected the answer to be in and says why it isn't there (or explicitly notes the endpoint has no
write verb, as the prompt asks for `caz`). A `matchFound: false` with a generic or missing
`evidenceNote` is scored as **inconclusive** and reported as its own bucket — not silently merged
into either "correct" or "miss" — because the prompt's evidence-note requirement exists precisely to
make this distinction checkable rather than assumed.

### Fusion, scored as its own category

`heatingEquipmentType` and `coolingEquipmentType` are scored as a **pair**, not two independent
leaves. Outcomes: **correctly fused** (`sharedWith` set on both, pointing at each other, same
`specProperty`); **silently fused** (right property on both, `sharedWith` empty — got the answer by
coincidence without noticing the structural fact, which matters for the review-time consequence doc
17 flags — same field on one per-HVAC-system record, not two independent house-level values);
**split** (two different specProperty answers reported, the wrong shape entirely). Only the first
counts as a match at tier 0.

---

## Ground truth of convenience, and how disagreements get adjudicated

Doc 17 is **not gospel** — it is an earlier agent's reconciliation pass, and its own verdicts are
explicitly hedged (match / partial / not found), not certified. It has already self-corrected once
within its own text (row 14, `atticInsulationSpokenRValue`, marked "overturned" against an earlier
doc's claim) and carries a late correction from the repo owner in its closing section. Treating it as
an infallible answer key would make every disagreement read as "the model is wrong," which begs the
question this spike exists to ask.

**Adjudication protocol, decided now, before any disagreement exists to bias it:**

1. When a model's answer for a leaf disagrees with doc 17, re-derive that one leaf directly from the
   fetched `swagger.json` text — the same method doc 17 itself used (grep the document for the
   candidate property names/strings, read the surrounding definition, check `required`/`enum`).
2. Classify the disagreement as exactly one of:
   - **Doc 17 error** — the model is right; doc 17 missed or misread something. Correct doc 17 and
     say so in the results, with the specific line changed — this repo's own convention
     (`spikes/extraction-snuggpro/README.md`: "if an extractor produces a defensible answer the
     ground truth calls wrong, fix the ground truth and say you did").
   - **Model error** — doc 17 is right; the model's answer doesn't hold up against the raw spec
     text.
   - **Genuinely arguable** — both readings are defensible from the spec text alone (e.g., a
     property whose description is ambiguous about whether it is the intended write target). Record
     as arguable, give neither side credit or blame, and say why.
3. Every adjudicated case is logged individually in Results — leaf, both answers, the resolution, and
   the one-sentence reasoning — not silently absorbed into a score. A model that surfaces a real doc
   17 error is a **positive** finding about the model, not a scoring anomaly to explain away.

The ultimate arbiter is the raw spec text, not doc 17 as an artifact — doc 17 is a cached, hedged
summary of that text, and this protocol exists so a disagreement gets checked against the primary
source rather than resolved by whichever document was written first.

---

## What a positive result would (and would not) license

**Would license:** enough confidence to try using an LLM to **draft** the mapping table (property
names, endpoints, and enum vocabularies) that `pnpm snugg:refresh` needs, with a human diff review
before merge — i.e., "good enough to draft, not good enough to auto-merge unreviewed," consistent
with R1.7's existing design of a script whose output lands in a reviewable diff rather than running
in CI.

**Would not license:**

- **That the same approach works at 163 fields, or at `basedata`'s full 294.** 34 leaves against 8
  curated resources is a much smaller disambiguation problem than 163+ leaves against a much larger
  slice (or the whole spec). Doc 16's own reasoning about signal getting diluted as schema size grows
  applies here by analogy even though doc 16's numbers are about a different schema (the extraction
  schema, not a mapping-input slice) — nothing here re-measures it at that scale.
- **Anything about extraction quality at any schema size.** This spike is about mapping spec text to
  code, not about pulling values out of a dictation. Doc 16 carries the separate, already-settled
  reasoning about why extraction at `basedata` scale is structurally infeasible/costly regardless of
  how good spec-mapping turns out to be.
- **That the 34 (or the eventual 163) is the right field set.** Selection is out of scope by design
  (see above); a good mapping score says nothing about whether these are the fields worth capturing.
- **Coverage of custom fields.** Doc 17 §4 already established these are per-account, runtime-
  discovered, and not enumerable from a static spec fetch — no mapping spike over a static document
  can speak to them.

---

## Files

| Path        | What                                                          |
| ----------- | ------------------------------------------------------------- |
| `README.md` | This document — design, prompt, scoring, fixed before any run |

No `prompts/`, `results/`, or runner script exists yet — writing one before a run would either sit
unused or invite silent drift from the design above between being written and being executed. When
this spike runs, the prompt in this document is copied verbatim (not re-derived from memory) into
whatever runner script is added at that time, and results are committed alongside a fetch-date/hash
of the spec snapshot used.

---

## Results

**Not yet run.** No model has seen the prompt above; no score exists. This section is a placeholder
so the document's shape matches `spikes/extraction-search-plan/README.md`'s convention of a Results
section that is either filled in after a single, disclosed scoring pass, or explicitly marked empty
— never silently omitted.
