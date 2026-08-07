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
  "schemaVersion": "snuggpro-51-leaf-v1",
  "transcript": "transcripts/NN-slug.txt",
  "stresses": "free-text summary of what this transcript is built to exercise",
  "leaves": {
    "<dotted leaf path>": LeafTruth, // one entry for EVERY ONE of schema.ts's 51 leaves, always
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

### When nothing fits: `noFittingMember`

Several enums have no catch-all member at all — `hvacSystemEquipmentType` (17 members, no "Other"),
`dhwType2` (4 members, no "Other"), `atticRoofType`, `hvacUpgradeAction`, and others. An auditor can
say something real that fits none of them (a solar water heater; a metal roof). For these cases the
leaf is `status: "asserted"` with `noFittingMember: { auditorMeaning: "<what they actually said>" }`
instead of `member`. There is deliberately no invented sentinel value pretending to be a real member.

When you use `noFittingMember`, also set `arguable.acceptableAlternatives` to whatever real member(s)
would be the best available imperfect answer (often the enum's actual catch-all when one exists on a
_different_ member — e.g. "Other" on an enum that has one but where the specific auditor's word
doesn't fit any NAMED member either). If truly nothing is even a defensible imperfect answer, leave
`acceptableAlternatives` empty: the scorer reports the leaf separately as **unscorable** rather than
silently grading a run's real, defensible answer as wrong against a ground truth that has no correct
answer to offer.

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

## What the scorer does with all of this

`score.mjs` reports the same eight measures the spike has always reported — hallucination rate, miss
rate, axis-split, enum-mapping accuracy, band-mapping accuracy, health-matrix state accuracy,
sourceSpan validity, confidence separation — computed leaf-by-leaf against this format, resolved
through either vocabulary. It adds exactly one new one: a **vocabulary mix** count (how many correct
enum matches resolved via the API literal vs the derived slug), which is the measurement this whole
rewrite exists to make possible. See `score.mjs`'s own header and `score.test.mjs` for the mutation
tests proving each of these can actually fail.
