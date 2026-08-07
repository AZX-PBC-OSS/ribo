# Annotator guide — re-annotating a transcript in the new format

You are one of 26 independent, parallel annotation tasks (two per transcript, blind to each other).
Your only inputs are: one transcript (`transcripts/NN-slug.txt`), `packages/ribo-adapter-snuggpro/src/schema.ts`
(the authority for what a leaf means and what its members are), [`ground-truth-format.md`](ground-truth-format.md)
(what the output shape means), and this guide (how to fill it in). You do **not** have the old
ground truth for your transcript, and you must not go looking for it — it was annotated against a
field set that no longer exists, and even where a leaf name looks familiar, its meaning may have
changed (attic R-value is the standing example: read `schema.ts`'s HAZARD 2b note before you touch
`attic.atticInsulation`).

**Read [`ground-truth/11-ambiguous-attic.json`](ground-truth/11-ambiguous-attic.json) end to end
before you start.** It is the worked reference every rule below is illustrated against, chosen
because it hits nearly every hard case in this guide in one short transcript: two retractions, a
health-matrix trap, two whole-group negations, and a genuinely new ambiguity the schema rebuild
introduced. Where this guide says "see the worked example," it means that file.

**Run `node validate-ground-truth.mjs ground-truth/NN-slug.json` before you consider yourself done.**
It catches every mechanical mistake below (missing leaf, typo'd member, wrong-shaped envelope) in
seconds, so the only disagreements two annotators surface are real ones.

## The goal: byte-identical on the unambiguous, legible disagreement on the arguable

Two careful annotators reading the same transcript should produce **identical** output for every
leaf where the transcript is not actually ambiguous. Where it genuinely is, they should each be able
to point at the exact sentence that makes it arguable, and one annotator's `arguable.note` should be
enough for the other to say "yes, I see why you could read it that way" even while disagreeing. If
you find yourself unsure whether a call is "the obviously right answer" or "arguable," write it up as
arguable — a spurious `arguable` costs a reviewer thirty seconds; a silently-swallowed genuine
ambiguity costs the whole point of running this twice per transcript.

## 1. Every one of the 51 leaves gets an entry — always

Walk `schema-leaves.mjs`'s `LEAF_PATHS` (or just run the validator, which tells you what's missing)
and produce a `LeafTruth` for every one, even the ones the transcript never comes near. "Never
discussed" is not an omission from the file — it is `{ "status": "unmentioned", "sourceSpan": null }`,
a real, correct answer for the large majority of leaves on any short transcript.

## 2. Choosing a `sourceSpan`

- It must be a **character-for-character substring of the transcript file**, exactly as written
  there (same casing, same punctuation, same contractions). Copy it; do not clean up grammar, do not
  normalize spoken numbers, do not join two non-adjacent phrases into one span. If you cannot
  literally find it with a text search over the transcript, it is not a valid span.
- Keep it **short** — the smallest contiguous clause that justifies the value, not the whole
  sentence around it. `"R-13, final answer."` is a better span for the final R-value than the whole
  three-sentence run-up that includes the retracted `R-11`.
- One span is allowed to justify **two different leaves** when the two leaves are two axes of the
  same fused mention — `"it's a furnace, a gas furnace"` legitimately backs both
  `hvac.hvacSystemEquipmentType` and `hvac.hvacHeatingEnergySource` in the worked example. This is
  correct, not a defect; do not invent two different sub-spans to avoid the repeat.
- For `status: "declared_absent"` or a group-negation cascade (rule 4), the span is whatever
  sentence explicitly addresses the absence — `"no water heater"`, `"I'm giving you the R-value, not
a depth"`. For `"unmentioned"`, the span is `null`, always — there is no sentence to point at.

## 3. Stated vs. inferred — the line that matters most

Extract only what the auditor **actually says**, in their own words, about their own observations.
Never:

- Derive one field from another (an ACH50 from a CFM50, a model year from "the plate looked worn").
- Supply a typical/standard value because the auditor gestured at one without committing
  ("whatever's standard on these" is **not** a stated value).
- Record an assumption the auditor themselves labels as an assumption ("there's a gas meter, so I'm
  assuming gas, but I never got to the unit" is **not** `hvacHeatingEnergySource: "Natural Gas"`).
- Apply domain knowledge the auditor didn't say out loud. The worked example's
  `hvac.combustionVentType` case (not annotated there, but see transcript 12/07's precedent in the
  old corpus) is the template: "ninety-plus, condensing" implies a sealed vent system to anyone who
  knows HVAC, but no vent-system word was spoken, so the leaf is `"unmentioned"`, not an inferred
  member. **If you catch yourself reasoning from what the fact WOULD imply rather than what was
  SAID, stop — that is inference, and it is exactly what this corpus exists to keep out of ground
  truth as much as out of a model's output.**
- Attribute a value to the auditor's own assertion when only a second speaker (a homeowner, a
  colleague) said it. A bracketed `[homeowner]` line, or an unbracketed second voice you can tell
  from context, becomes a field value **only if the auditor independently confirms it in their own
  words** — "I hear you, but I need to read the plate myself" followed by the auditor's own reading
  is fine; repeating the homeowner's number back uncritically is not.

## 4. Group-negation: when "no X" answers every leaf about X

When the auditor explicitly says a whole **thing** does not exist, was not done, or does not apply
("no water heater", "no blower door", "no ducts, it's hydronic"), every leaf that describes an
attribute of that specific thing is `"declared_absent"` with that same span — not `"unmentioned"`.
The worked example cascades `"no water heater"` across all six `dhw.*` leaves, and `"no blower
door"` across both `basedata.blowerDoorReading` and `basedata.blowerDoorTestPerformed` (the latter
is a qualifier of a measurement that doesn't exist, so the question is moot, not merely unaddressed).

**Scope this to the THING named, not to the JSON object it happens to live in.** `basedata` also
holds `yearBuilt`, `numberOfBedrooms`, and other leaves with nothing to do with a blower door — "no
blower door" does not cascade to those just because they share a resource group in `schema.ts`.

**A generic, uncommitted disclaimer does NOT cascade as broadly as a specific one.** The worked
example's `notes._general` walks through exactly this: "No tests, no blower door, no water heater,
none of that stuff" names two specific things (blower door, water heater) and cascades to both — but
"no tests" names no specific test, and the file treats the other 12 health-matrix leaves as
`"unmentioned"` rather than asserting `"Not Tested"` on all of them. Naming twelve tests the auditor
never individually mentions is closer to inference than transcription (rule 3), even under a
blanket disclaimer. **This is a genuinely arguable scope call — a broader cascade is defensible.**
If you make the broader call on your transcript, that is fine; flag it with `arguable` on the leaves
you cascade to, so a reviewer sees you made a deliberate choice rather than missing the disclaimer
entirely, and so the other annotator's narrower reading is a legible, expected disagreement rather
than an error.

## 5. Self-correction: the LAST assertion wins, always

Dictation is full of retractions and second attempts. "Oil — no, it's propane, I saw the tank" is
`Propane`, full stop; "boiler at first... no, it's a furnace... scratch the boiler" is
`"Furnace with standalone ducts"` (or whichever member fits), full stop. The retracted value is not
a partial answer, not a `50/50`, and not worth hedging over — it is simply wrong, and the ground
truth records only the final value.

Record the withdrawn value in `retracted` (see `ground-truth-format.md`) so a run that emits the
withdrawn value gets a more specific diagnostic than a bare "wrong" — but the `status`/`member`/
`value` fields themselves only ever reflect the LAST assertion. Use the LAST assertion's own span,
not the retracted one's — `"R-13, final answer."`, not `"I want to say R-11"`.

## 6. Enums: pick the schema.ts member, not a description of one

`member` must be copied **exactly** from `schema.ts`'s enum list for that leaf — same casing, same
punctuation, same percent signs and inch marks. Do not paraphrase, and do not "clean up" a member
you find odd (`'Duct Board 1.5"'` keeps its inch mark). The validator checks this for you; a member
it flags as unrecognized is either a typo or a sign you're looking at the wrong leaf.

**When the auditor's words fit no member at all** (several enums have no "Other"/"Don't Know"
escape hatch — see `ground-truth-format.md`'s "when nothing fits"), use `noFittingMember` with a
plain-English gloss of what was actually said, and set `arguable.acceptableAlternatives` to the best
available real member(s) if any exist, so a run can still be scored against something. Do not force
the auditor's words into the nearest wrong member, and do not drop a real, stated answer to
`"unmentioned"` just because it doesn't fit.

**When the schema rebuild introduced a distinction the auditor's words don't resolve**, that is a
new, first-class kind of ambiguity this corpus has never had before, and you should expect to hit it
occasionally: the schema now encodes an axis the pre-rebuild field set collapsed. The worked
example's `hvac.hvacSystemEquipmentType` call is the template — the auditor says "a gas furnace" and
nothing else about cooling, and the rebuilt schema splits furnaces into a standalone-ducts member and
a shared-ducts-with-AC member. Pick the reading closest to what was actually said (here: no cooling
mentioned → standalone), flag the untouched-by-the-transcript alternative as `arguable`, and say in
the note that this is a rebuild-introduced ambiguity, not something the transcript itself is unclear
about — that distinction matters to whoever triages disagreements later.

## 7. Bands and axes: no arithmetic, no fused tokens

- **Fuel is never fused with equipment.** "Oil boiler" is TWO leaves —
  `hvacSystemEquipmentType: "Boiler"` and `hvacHeatingEnergySource: "Fuel Oil"` — never one token.
  Same pattern for `dhwType2`/`dhwFuel2`. The fused phrase's span backs both leaves (rule 2).
- **A stated depth/thickness maps to the band containing it** (`atticInsulationDepth`,
  `dhwAge`); **a stated R-value is a real, independent value of its own**
  (`atticInsulation`, a number — NOT a band, and NOT converted to one; see `schema.ts`'s HAZARD 2b
  and the worked example's `attic.atticInsulation` leaf, which is asserted precisely because the
  rebuilt schema gives it a real write target the pre-rebuild schema did not have). If the auditor
  gives both a depth and an R-value, both leaves are asserted independently. **You never convert
  between them** — that conversion is climate/material-dependent and belongs to a reviewed
  deterministic table, not to an annotator's judgment call.
- Do not bucket a number into a band yourself if the auditor gave the raw number and the schema
  leaf is a band — read `schema.ts`'s comment on that specific leaf; some bands (attic depth, DHW
  age) are meant to be picked directly from a stated depth/age because the band members are few
  enough, per `normalization.md`.

## 8. The health matrix: four real states, plus silence

Every one of the 13 named tests takes exactly one of `"Passed"` / `"Failed"` / `"Warning"` /
`"Not Tested"` when the auditor addresses it, or is `"unmentioned"` when they never do. There is no
`declared_absent` on these 13 leaves (see `ground-truth-format.md` — `"Not Tested"` already IS the
schema's own "explicitly did not happen" state).

- **A clean result is `"Passed"`, not silence.** "CO was clean," "no spillage," "gas sniffer was
  quiet" are real, positive data — asserting them is not optional.
- **A skip/deferral the auditor states is `"Not Tested"`**, with the span where they said so.
- **Total silence on a test is `"unmentioned"`, never `"Passed"` and never `"Not Tested"`.** The
  worked example's `health.healthAmbientCarbonMonoxide` leaf is the crux case: a personal CO monitor
  that "never went off" is tempting to read as `"Passed"`, but the auditor explicitly says it is NOT
  a real test — the correct reading is `"Not Tested"` (an addressed, explicit non-performance), and
  a model that stamps `"Passed"` there is committing the exact failure mode this leaf exists to
  catch. Read the worked example's `arguable` block on that leaf for how to phrase this kind of trap
  once you've spotted one on your own transcript.
- `health.healthRoofCondition` is **not** one of the 13 — it's a separate, 3-member condition enum
  (`Good`/`Potential Issues`/`NA`), scored like any other enum leaf.

## 9. Fields with no write target — say nothing, not something nearby

Some things auditors say out loud have **no corresponding leaf at all** — spoken AFUE/SEER
efficiency ("ninety-two percent furnace") is the standing example; `schema.ts`'s HAZARD 4 note
explains why there is deliberately no slot for it. When you hit one of these:

- Do **not** park it in an adjacent leaf that happens to be nearby (efficiency is not a BTU output,
  a model number, or anything else).
- Do **not** invent a field or a key that isn't one of the 51 `LEAF_PATHS` — the validator will
  reject it outright.
- **Do** mention it in `notes._general` if it's notable, purely so a reviewer can tell you saw it and
  deliberately excluded it, rather than missed it. This is documentation only; the scorer never reads
  `notes`.

## 10. `arguable` and `retracted` are not busywork — but don't reach for them by default

Use `arguable.acceptableAlternatives` / `acceptableMiss` only when you can write a `note` that names
the specific sentence making the call genuinely contestable, in the style of the worked example's
notes. If a leaf's answer is simply, unambiguously correct once you've read the transcript
carefully, it needs no `arguable` block at all — most leaves on most transcripts will have none.
Overusing `arguable` to hedge on calls that aren't actually close defeats its purpose just as
thoroughly as underusing it to paper over a real ambiguity.

## Before you submit

1. Run `node validate-ground-truth.mjs ground-truth/NN-slug.json` — fix everything it flags.
2. Re-read your file against the transcript once, leaf by leaf, specifically hunting for: a span
   that isn't actually verbatim, a member that's close-but-not-exact to the real `schema.ts` string,
   and any leaf where you inferred rather than transcribed (rule 3).
3. If anything felt genuinely uncertain and you didn't mark it `arguable`, go back and mark it.
