# The vocabulary-neutral ground-truth format

This document specifies the shape every `ground-truth/NN-slug.json` file must have going forward,
and why. Read this before annotating anything — [`ANNOTATOR_GUIDE.md`](ANNOTATOR_GUIDE.md) tells
you _how_ to fill it in from a transcript; this file tells you _what_ each part means and why it is
shaped the way it is. [`schema-leaves.mjs`](schema-leaves.mjs) and [`ground-truth.mjs`](ground-truth.mjs)
enforce this shape at runtime — `node validate-ground-truth.mjs <file>` checks a file against it.

## Why the old format had to go

The 14 existing `ground-truth/*.json` files were annotated against the adapter's OLD field set: 23
flat, snake_cased top-level keys (`heatingFuel: "fuel_oil"`) plus an 11-test `healthSafety` object.
The adapter was rebuilt from Snugg Pro's machine-readable spec
(`packages/ribo-adapter-snuggpro/src/schema.ts`, **the authority** — read its file header before
anything else) into **51 leaves nested under 7 endpoint groups**
(`basedata`/`hvac`/`attic`/`wall`/`window`/`dhw`/`health`), with the API's own literal enum strings
(`"6% - Well sealed"`, `"Not Tested"`, `"Furnace / Central AC (shared ducts)"`) rather than
hand-chosen snake_case tokens. The old ground truth cannot be mechanically translated into the new
shape — the field SET changed (some leaves are new, like the 13th/14th health tests and
`hvacUpgradeAction`; some old fields' MEANING changed, like attic R-value moving from a fake
"holding pen" to a real write target) — so it has to be re-read from the transcripts by a human (or
an agent) who understands both the transcript and the new schema.

The owner's further requirement is what this format is actually designed around: **snake_case
tokens may extract better on small local models than the API's literal strings** (fewer tokens, no
punctuation), and the corpus should be able to test that hypothesis **without a second annotation
pass**. That means the ground truth cannot store either vocabulary's spelling as the thing being
graded — it has to store what the auditor **meant**, in a form both vocabularies can be checked
against.

## The shape

```jsonc
{
  "schemaVersion": "snuggpro-51-leaf-v2",
  "transcript": "transcripts/NN-slug.txt",
  "stresses": "free-text summary of what this transcript is built to exercise",
  "disclaimers": [
    // blanket/generic negations, recorded as DATA — see "Disclaimers" below. Optional; most
    // transcripts will have zero to a handful.
    { "span": "no water heater", "topic": "the water heater", "scope": { "kind": "group", "group": "dhw" } },
  ],
  "leaves": {
    // SPARSE: one entry per leaf the annotator can address SPECIFICALLY — not all 51. Every leaf
    // NOT here, and not covered by a disclaimer's scope, resolves to "unmentioned". An explicit
    // entry always overrides a disclaimer covering the same leaf (see "Resolution" below).
    "<dotted leaf path>": LeafTruth,
    // ...
  },
  "notes": {
    "<dotted leaf path or _general>": "free-text commentary — NOT consumed by the scorer"
  }
}
```

The **leaf path** is the group key and the leaf key joined by a dot — `"hvac.hvacSystemEquipmentType"`,
`"health.healthAmbientCarbonMonoxide"` — exactly mirroring `schema.ts`'s nesting, because that
nesting is real: it is Snugg Pro's own per-endpoint resource layout, not an artifact of this
annotation format. [`schema-leaves.mjs`](schema-leaves.mjs)'s `LEAF_PATHS` is the literal list, walked
out of the built `snuggValuesSchema`, so it is impossible for this format to describe a leaf that
doesn't exist or to omit one that does.

**`leaves` is sparse by design — v2 dropped the v1 requirement that all 51 keys be present.** See
"Disclaimers" below for why: an annotator only writes a `leaves` entry for a leaf they can address
specifically. `resolveGroundTruth` (`ground-truth.mjs`) is what materializes the full 51-leaf map
the scorer actually scores against, by layering `disclaimers` under the explicit `leaves` entries.

### `LeafTruth`

```ts
type LeafTruth = {
  /** Was the field addressed at all, and if so, in what way? */
  status: "unmentioned" | "declared_absent" | "asserted";

  /** The verbatim, character-for-character transcript quote — null iff status is "unmentioned". */
  sourceSpan: string | null;

  // --- present only when status === "asserted", and shaped by the leaf's kind ---
  value?: number | string; // number/string leaves
  member?: string; // enum leaves: the EXACT literal string from schema.ts
  noFittingMember?: { auditorMeaning: string }; // enum leaves ONLY: see "when nothing fits" below

  // --- optional, at ANY status ---
  retracted?: { value: number | string; note: string }[];
  arguable?: {
    acceptableAlternatives?: (number | string)[];
    acceptableMiss?: boolean;
    note: string; // required whenever `arguable` is present
  };
};
```

`validateGroundTruth` in `ground-truth.mjs` enforces every constraint above (which fields are
required/forbidden per status and kind, that `member` is one of the leaf's real options, that
`arguable`/`retracted` carry a non-empty `note`). Run it before you trust a file you hand-wrote.

## Rationale, one decision at a time

### Three states, not two — preserving what the old corpus already distinguished

The old format used a two-field envelope (`value`, `sourceSpan`), both nullable independently, to
encode three real situations the scorer already measured differently:

| Old encoding                       | Meaning                               | New `status`        |
| ---------------------------------- | ------------------------------------- | ------------------- |
| `value: null, sourceSpan: null`    | Topic never came up                   | `"unmentioned"`     |
| `value: null, sourceSpan: "quote"` | Explicitly declined / reported absent | `"declared_absent"` |
| `value: <X>, sourceSpan: "quote"`  | Genuinely stated                      | `"asserted"`        |

This format makes the three states an explicit enum (`status`) instead of two independently-nullable
fields, because the OLD encoding let you construct a fourth, nonsensical combination
(`value: <X>, sourceSpan: null` — a value with no grounds for it) that the scorer had to treat as a
provenance defect after the fact. An explicit `status` makes that combination a validation error
instead of a runtime inference — no information is lost, and one wrong-shaped state is no longer
representable at all.

**`declared_absent` is reserved for leaves where no schema member represents "explicitly did not
happen."** Number and string leaves (there is no "N/A" number), and most enums, fall here — "no
blower door" means `basedata.blowerDoorReading` has nothing to report, full stop.
**It is never used for the 13 health-matrix tests**, because `HealthTestState` already has a
dedicated member for exactly this situation: `"Not Tested"`. An auditor who says "didn't get to
worst-case depressurization today" is **asserting** `member: "Not Tested"`, not declaring the leaf
absent — the value `"Not Tested"` is real, representable, gradable information, not a null. Treating
an explicit skip as `declared_absent` on those 13 leaves would throw away exactly the distinction
(explicitly-skipped vs never-discussed) the health matrix exists to keep — see
[`normalization.md`](normalization.md)'s hazard-3 discussion, which predates the schema rebuild but
still states the design intent correctly.

### The enum problem: what "vocabulary-neutral" means for a member

An enum leaf's ground truth stores `member`: **the exact literal string from `schema.ts`** — e.g.
`"6% - Well sealed"`, not `well_sealed` and not some third invented token. This is not a concession
to one vocabulary over the other; it is the least-committal choice available, for a concrete reason:
`schema.ts` is authoritative and exhaustive — every real answer for that leaf is already one of its
listed members, spelled exactly one way, by definition. There is no need to invent a third, "more
neutral" identifier for "the auditor meant Snugg's well-sealed duct-leakage tier" when schema.ts
already assigns that meaning a single, unambiguous name. Recording anything else (an index, a
hand-invented slug) would be a second name for something that already has exactly one true name, and
second names are how a corpus drifts from its schema.

What makes this vocabulary-**neutral** is not the stored value — it's the **resolver**
(`resolveEnumMember` in `schema-leaves.mjs`) that sits between the ground truth and a run's output.
A run may emit either the API's literal string OR a mechanically-derived snake_case alternative (see
below); the resolver maps either one back to the same canonical member before comparing it to
`member`. The ground truth never has to know, or care, which vocabulary produced the value it is
being checked against.

**The second vocabulary is a formula, not a table.** `slugifyMember()` derives a snake_case token
from any API string by dropping a leading `"N% - "` qualifier, lowercasing, stripping
quote/apostrophe/inch marks, and collapsing every other run of non-alphanumerics to one underscore.
It is **not** a reproduction of the pre-rebuild spike schema's hand-chosen tokens — that schema
hand-added unit suffixes (`well_sealed` → the old schema literally had no equivalent; `duct_board_1_5in`
added an "in" the API string doesn't contain) and hand-dropped qualifiers, which is real editorial
judgment applied 233 times, i.e. exactly the hand-maintained parallel table this whole rewrite exists
to avoid. `slugifyMember` instead applies one formula uniformly; if it produces a slightly longer or
less idiomatic token than a human would have chosen (`furnace_central_ac_shared_ducts` instead of the
old schema's bare `furnace_central_ac`), that is the accepted cost of the token being **derived**
rather than **maintained**. A future slug-vocabulary extraction run must generate its own enum lists
with this exact function, so its output matches this vocabulary by construction — the resolver does
not, and cannot, guess what token style an unconstrained model would invent on its own.

Two small tables in `score.mjs` (`BAND_LEAVES`, `AXIS_PAIRS`) are still hand-kept, and are named there
for exactly this reason: "these members form an ordered band" and "these two leaves are one thing's
two axes" are facts about what the leaves MEAN, invisible in a bare zod enum's shape. They cannot be
derived from `schema.ts` the way the leaf list and the 233 members can — but they are two short,
named facts, not a parallel enumeration of every member.

**Attribution is exact-match, in both directions — a near-miss resolves to unrecognized, not to a
vocabulary it didn't use.** `resolveEnumMember` checks whether a run's (trimmed) raw value equals the
literal API string, or equals one of the PRECOMPUTED slugs, character for character — it does not
slugify the raw value and then compare, which an earlier version did. That distinction matters
because slugifying-then-comparing accepts any near-miss of the API string that happens to slugify to
a real slug (altered casing, dropped punctuation, re-spaced) and reports it as `"slug"`, even though
it is really a mangled `"api"` attempt that used neither vocabulary correctly. Exact matching makes
that string resolve to `null` (unrecognized) instead — correct for SCORING (an unrecognized value was
already `wrong` either way) and now also correct for ATTRIBUTION, which is the number the vocabulary
question actually depends on. One residual, irreducible case: a member whose literal API spelling
already IS its own slug (`AtticInsulationDepth`'s `"0"`; `slugifyMember("0") === "0"`) makes the two
vocabularies coincide for that one string — reported as `"api"` (that check runs first), not a
resolution bug, since the two vocabularies are genuinely indistinguishable for that specific member
and no exact-match scheme can attribute it either way.

**The vocabulary-mix count itself is gated on a TRUE match, never on a sanctioned or otherwise
tolerated one.** `score.mjs` increments `vocabApi`/`vocabSlug` only when `compareValue`'s verdict is
literally `"correct"` — not on the broader `ok` flag that also covers sanctioned alternatives, and
not merely because `resolveEnumMember` found some real member. An earlier version counted vocabulary
on any resolved member regardless of whether it matched GT, which meant a wrong answer spelled in
slug form (e.g. GT `"Natural Gas"`, model `"fuel_oil"`) silently counted as a "CORRECT match" in the
slug column — corrupting the one measurement this whole format exists to produce. See
`score.test.mjs`'s EITHER-VOCABULARY gate for the mutation that proves a wrong slug-spelled value is
now excluded from both `vocabApi` and `vocabSlug`.

### Disclaimers: blanket negations are DATA, not an annotator's judgment call

An auditor sometimes negates a whole topic at once — "no water heater," "No tests, no blower door,"
"the rest of the shell next visit." The v1 format asked the annotator to decide, per transcript,
which leaves such a statement reaches, with the guide saying "prefer the narrower reading." That is
a **judgment call**, and judgment calls do not converge across 26 independent, blind annotators. The
specific danger is not ordinary disagreement — it is a **systematic split**: half the annotators
read every blanket disclaimer broadly, half read every one narrowly, and the result is 26
individually-defensible files that disagree on scope for a reason invisible to a disagreement count.
Reconciling that degenerates into re-annotating everything by hand.

**v2's fix: the annotator records a disclaimer as data (a verbatim `span` plus a mechanical `scope`)
and never decides which leaves it reaches.** Resolution — turning a scope into leaf paths, and those
leaf paths into a default `LeafTruth` — is a single, versioned POLICY (`disclaimer-policy.mjs`),
applied uniformly to every transcript. Change the policy and every ground-truth file's SCORED
meaning changes with it — no re-annotation, the same property vocabulary-neutrality gets enums, one
level up.

```ts
type Disclaimer = {
  span: string; // verbatim, same rules as any sourceSpan
  topic: string; // free-text gloss for humans — NOT mechanically applied, see below
  scope:
    | { kind: "group"; group: string } // every leaf under one of the 7 resource groups
    | { kind: "namedSet"; set: string } // a key of disclaimer-policy.mjs's NAMED_SETS
    | { kind: "unresolved" }; // real, worth recording — reaches no leaf today
};
```

**Why `scope` is a closed mechanical vocabulary and not free text.** Free text ("the topic is: the
combustion tests") is the easiest thing for an annotator to write and the hardest thing to apply the
same way twice — resolving it mechanically would need string-matching or an LLM call, reintroducing
exactly the judgment-call problem this feature exists to remove. A **resource group name** is the
opposite extreme: fully mechanical (a `LEAF_PATHS` prefix match) and requires no named list at all,
but is sometimes too coarse — `"no blower door"` under `group: "basedata"` would incorrectly sweep in
`yearBuilt`, `numberOfBedrooms`, and every other basedata leaf that has nothing to do with a blower
door. **`namedSet`** is the deliberate middle ground: a SMALL, closed, hand-named table
(`disclaimer-policy.mjs`'s `NAMED_SETS`) for the few scopes that recur but are narrower than a whole
group — today: `healthTests` (the 13 pass/fail/warning/not-tested matrix leaves, narrower than
`group: "health"` because it excludes `healthRoofCondition`), `blowerDoor` (the two basedata leaves
about the blower-door reading), and `shell` (the building envelope: attic + wall + window +
blower-door, justified by real corpus text — see that file's own comments). This is domain knowledge
about what recurs, exactly like `BAND_LEAVES`/`AXIS_PAIRS` in `score.mjs` — a few short, named facts,
not a parallel enumeration of leaves.

**When a disclaimer genuinely cannot be captured by a group or a named set, it is `{ kind:
"unresolved" }`, not forced into the nearest approximation.** The disclaimer is still recorded (span

- topic, for a human or a future policy update to act on); it simply reaches no leaf today, and every
  leaf it might plausibly cover stays at its ordinary default. On inspection of all 14 transcripts,
  every real blanket disclaimer found so far resolves cleanly to a group or one of the three named sets
  above — `unresolved` exists as a safety valve for a case none of the 14 has actually needed yet, not
  a workaround for one that has.

**Resolution order (`resolveGroundTruth` in `ground-truth.mjs`), most to least specific:** (1) an
explicit `leaves[path]` entry the annotator wrote, (2) a disclaimer whose scope covers `path`, (3) the
default, `{ status: "unmentioned", sourceSpan: null }`. This is "most specific wins," now structural
rather than a guideline: `ANNOTATOR_GUIDE.md`'s worked example uses it directly — a generic `"No
tests"` disclaimer covers all 13 health-matrix leaves, and the transcript's own, separately-addressed
statement about `healthAmbientCarbonMonoxide` overrides the disclaimer's default for that one leaf
with a more specific span and an `arguable` block, without the two ever conflicting or requiring the
annotator to decide which "wins" — the format decides.

**Disclaimer scopes must not overlap.** Two disclaimers both claiming the same leaf is either a
redundant annotation or a sign that one should be narrowed and the other's target leaf given its own
explicit `leaves` entry instead; `validateGroundTruth` rejects the overlap rather than picking a
winner silently.

### When nothing fits: `noFittingMember`

Several enums have no catch-all member at all — `hvacSystemEquipmentType` (17 members, no "Other"),
`dhwType2` (4 members, no "Other"), `atticRoofType`, and others. An auditor can say something real
that fits **none** of them (a solar water heater; a metal roof). For these cases the leaf is
`status: "asserted"` with `noFittingMember: { auditorMeaning: "<what they actually said>" }` instead
of `member`. There is deliberately no invented sentinel value pretending to be a real member.

When you use `noFittingMember`, also set `arguable.acceptableAlternatives` to whatever real member(s)
would be the best available imperfect answer (often the enum's actual catch-all when one exists on a
_different_ member — e.g. "Other" on an enum that has one but where the specific auditor's word
doesn't fit any NAMED member either). If truly nothing is even a defensible imperfect answer, leave
`acceptableAlternatives` empty: the scorer reports the leaf separately as **unscorable** rather than
silently grading a run's real, defensible answer as wrong against a ground truth that has no correct
answer to offer.

**`noFittingMember` is specifically for "nothing fits" — not for "more than one thing fits equally
well."** Those are different problems and this format does not conflate them (an earlier draft of
the worked example did, and it broke in a revealing way — see the next section).

### When TOO MANY things fit: a schema-forced axis ambiguity

`hvacSystemEquipmentType` conflates two independent facts into one enum axis: a furnace's identity,
and whether it shares ducts with a central AC unit (`"Furnace with standalone ducts"` vs `"Furnace /
Central AC (shared ducts)"`). An auditor who says "it's a gas furnace" and nothing else about cooling
has stated the identity and left the ducts-sharing axis completely unaddressed — and unlike the
"nothing fits" case, **two real members fit equally well**, because both are correct about the part
that WAS said and neither is contradicted by anything that wasn't.

The first draft of the worked example used `noFittingMember` here, reasoning "neither is fully
supportable, so nothing fits." That broke a real property once tested: `noFittingMember` makes
`compareValue` return `"unscorable"` for **any** real member a run emits, including a genuinely wrong
one — a model answering `"Boiler"` (a different equipment family entirely, contradicting what was
said) was reported as merely "unscorable" instead of "wrong," which is not honest. "Nothing fits" and
"two things fit, so a genuinely different third thing is still wrong" are different claims, and
`noFittingMember` can only make the first one.

**The rule: `member` is whichever of the co-equally-fitting members appears FIRST in `schema.ts`'s
own enum-list order for that leaf; every other one goes in `arguable.acceptableAlternatives`, with a
note stating explicitly that they are symmetric.** An earlier version of this rule said "pick either
one" — which is itself a choice, and a second reviewer caught that two independent annotators each
"picking either one" will disagree on WHICH member sits in `member` even though their files score
identically. That is a smaller version of the exact systematic-split risk the whole disclaimer
mechanism exists to eliminate, just relocated to a single field instead of a whole leaf's resolution
scope — so it gets the same fix: make the choice mechanical. "First in schema.ts's enum-list order"
needs no judgment call; it is not a preference for that member, it is a deterministic tie-break
applied to a case where either answer scores identically, and `acceptableAlternatives` proves the
scoring symmetry structurally: a run landing on either member scores identically (never penalized),
while a run landing on a genuinely different equipment family (`"Boiler"`, `"Electric Resistance"`, a
heat pump — anything real but NOT one of the conflated pair) is still scored as a hard wrong answer,
because something real actually was contradicted. `ANNOTATOR_GUIDE.md` states this as a mechanical
rule, not a per-transcript judgment call — and the underlying finding (schema.ts fuses two
independently-addressable facts onto one axis, so a very common style of utterance is now inherently
underdetermined by the schema itself, not by the transcript) is reported as what it is: a consequence
of the schema rebuild's design, not an annotation gap.

### `retracted` and `arguable`: information the old corpus carried in the SCORER, not the ground truth

The old `score.mjs` had four hand-maintained, slug-keyed tables — `TOP_PARTIAL`, `MISS_EXCUSED`,
`RETRACTED`, `HEALTH_PARTIAL` — recording exactly this kind of per-field judgment call
("`double_pane` on transcript 03's windowGlazing is wrong-but-grounded, not a hard hallucination").
That design does not survive a 26-way blind fan-out: two independent annotators re-reading the SAME
transcript cannot both add an entry to a table that lives in a file neither of them is meant to
touch, and a third annotator on a DIFFERENT transcript has no table entry to consult at all for a
judgment call that is genuinely the same shape.

This format moves that information onto the leaf it describes:

- **`retracted`** records a withdrawn earlier assertion ("I thought boiler at first... no, it's a
  furnace" → `retracted: [{ value: "Boiler", note: "..." }]`). This is purely a reporting nicety —
  a retracted value that reappears in a run's output is already `wrong` by the ordinary comparison;
  `retracted` just lets the scorer label it "retracted (last-value-wins)" instead of a generic wrong,
  which is a better diagnostic for the exact failure mode `ANNOTATOR_GUIDE.md`'s rule 5 exists to
  catch.
- **`arguable`** records a genuinely-contested call, in the annotator's own words, at the moment they
  made it. `acceptableAlternatives` lists other values the scorer should NOT penalize (whether the
  leaf's ground truth is null or asserted); `acceptableMiss: true` says a model leaving this leaf
  `null` is a defensible caution, not a penalized miss. Both require a `note` — the note is not
  decoration, it is the artifact a second annotator or a reviewer reads to understand why the call
  was made, and it is exactly the kind of "disagree legibly" surface the annotator guide asks for.

**A sanctioned alternative on a GT-NULL leaf and one on a GT-ASSERTED leaf are not the same kind of
event, and `score.mjs` no longer reports them as if they were.** GT null + a sanctioned non-null is a
genuine (if tolerated) overreach — the model asserted something nobody said, and the leaf's own
`arguable` happens to excuse that specific value; this stays in the `hallucinationSoft` bucket and
the HALLUCINATION section, because it is, categorically, a mild hallucination. GT asserted + a
sanctioned DIFFERENT value (the furnace/cooling case above) is not a hallucination at all — nothing
was invented, GT itself is non-null, and the schema forced an arbitrary pick the model happened to
land on the other side of. This gets its own counter (`enumSanctioned`) and its own detail section,
reported under ENUM-MAPPING. An earlier version of `score.mjs` used the SAME bucket for both, which
meant a leaf like `hvacSystemEquipmentType` — and every leaf sharing its conflated-pair shape, which
includes the shared-ducts heat-pump and ground-source-heat-pump variants — inflated a
hallucination-flavored count across the whole corpus for something that was never a hallucination.

## What the scorer does with all of this

`score.mjs` reports the same eight measures the spike has always reported — hallucination rate, miss
rate, axis-split, enum-mapping accuracy, band-mapping accuracy, health-matrix state accuracy,
sourceSpan validity, confidence separation — computed leaf-by-leaf against this format, resolved
through either vocabulary. It adds two new ones: a **vocabulary mix** count (how many TRUE-correct
enum matches resolved via the API literal vs the derived slug — never counting a wrong or merely
sanctioned answer, see above), which is the measurement this whole rewrite exists to make possible;
and an **enum-sanctioned** count, reported under enum-mapping rather than hallucination, for the
schema-forced-arbitrary-pick case. A missing or unparseable model result is scored exactly as if the
extractor had emitted an empty object — every leaf reads as a miss (or an excused miss, where the
leaf's own `arguable.acceptableMiss` says so), never as a silent zero; an extractor that returns
nothing can no longer score better than one that tried and got some answers wrong. See `score.mjs`'s
own header and `score.test.mjs` for the mutation tests proving each of these can actually fail.

## What `validate-ground-truth.mjs` catches mechanically

Run it before submitting; it is the fast, solo feedback loop that catches these WITHOUT waiting for
a second annotator's file to diff against. It never throws — a malformed value anywhere in the file
(e.g. `arguable: "oops"`) becomes a reported error, not an uncaught exception, and the CLI wraps the
call anyway so a defect in the validator itself degrades one file's check rather than crashing the
whole batch:

- a wrong or missing `schemaVersion` (must exactly equal the current format version)
- `leaves` (or an individual leaf's `retracted[i]`, or `arguable`) being an array or any other
  non-object shape where an object is required — including the specific case of `leaves: []`, which
  is an array and therefore rejected, not silently treated as "no leaves"
- an unknown leaf path (typo, or a leaf from the old schema that no longer exists)
- a `member` that is not one of that leaf's real `schema.ts` options — i.e. anything outside the
  neutral vocabulary this format is built around
- a leaf carrying a field that belongs to a DIFFERENT leaf kind — an enum leaf with a stray `value`,
  or a number/string leaf with a stray `member`/`noFittingMember`
- a leaf's shape inconsistent with its `status` (a value where "unmentioned" forbids one, a missing
  `sourceSpan` where "asserted"/"declared_absent" require one, an asserted enum leaf with neither
  `member` nor `noFittingMember`)
- a `retracted[i].value` that isn't a number or string (an object/array value is rejected)
- a `sourceSpan` — on a leaf OR a disclaimer — that is **not a verbatim substring of the actual
  transcript file** (checked against the real transcript text, not trusted to a careful re-read)
- a disclaimer with an empty/missing `span` or `topic`, or a `scope` that isn't a recognized group,
  a recognized `namedSet`, or `"unresolved"`
- an `"unresolved"` scope with no `note` explaining why nothing else fits
- two disclaimers whose scopes overlap
- (defense in depth) the fully RESOLVED 51-leaf map is re-validated after applying the disclaimer
  policy, so a bug in the policy itself — not just in one annotator's file — is still caught

It also prints (non-fatal) **warnings**: a `topic` that doesn't obviously match its `scope` (a
copy-paste mistake, or the wrong scope in a multi-part disclaimer sentence), and every `"unresolved"`
disclaimer, every time, flagged as needing human reconciliation rather than merely "valid."

Sparse `leaves` means a leaf simply absent from the file (and not covered by any disclaimer) is
**valid** — it resolves to `"unmentioned"`. This is not a "missing leaf" checker in the sense of
requiring all 51 keys; nothing here enforces that.
