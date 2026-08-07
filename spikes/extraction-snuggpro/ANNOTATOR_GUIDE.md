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
health-matrix trap, three blanket disclaimers recorded as data rather than resolved by judgment, and
a genuinely new ambiguity the schema rebuild introduced. Where this guide says "see the worked
example," it means that file.

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

## 1. Write a `leaves` entry only for what you can address SPECIFICALLY

`leaves` is sparse. Write an entry for a leaf when the transcript says something specific enough to
name that exact leaf — an asserted value, or an individually-addressed absence
(`"I'm leaving the year blank"`). Do **not** write `{ "status": "unmentioned", "sourceSpan": null }`
entries for every leaf the transcript never touches — that is the default every leaf gets
automatically; writing it out changes nothing and just adds noise to diff against. A leaf that a
BLANKET statement covers ("no water heater," "No tests") is not addressed by you at all — see rule 4.
When in doubt, write less: an unwritten leaf is either the plain default or a disclaimer's default,
never an error.

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
- For `status: "declared_absent"` on a leaf you address individually, the span is whatever sentence
  explicitly addresses the absence — `"I'm giving you the R-value, not a depth"`. For a BLANKET
  negation covering many leaves at once ("no water heater"), that span goes on a `disclaimers` entry
  instead (rule 4) — not repeated across every leaf it covers. For `"unmentioned"`, the span is
  `null`, always — there is no sentence to point at.

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

## 4. Blanket negations: record them as a `disclaimer`, never decide their reach yourself

When the auditor says a whole **thing** does not exist, was not done, or was skipped ("no water
heater", "No tests, no blower door", "the rest of the shell next visit"), do **not** decide for
yourself which leaves that reaches and do **not** write `declared_absent`/`"Not Tested"` onto each
one by hand. Add an entry to the top-level `disclaimers` array instead:

```jsonc
{
  "span": "no water heater",
  "topic": "the water heater",
  "scope": { "kind": "group", "group": "dhw" },
}
```

This is the single most important mechanical rule in this guide, because the alternative — "prefer
the narrower reading, flag the broader one as arguable" — asks for a judgment call, and judgment
calls do not converge across 26 independent, blind annotators. Two annotators who each pick a
DIFFERENT scope for every blanket statement in their transcript produce files that look like ordinary
careful disagreement but are actually a systematic split, invisible to a disagreement count and far
worse than noise. Recording the disclaimer as data sidesteps the question entirely: which leaves it
reaches is decided once, centrally, by `disclaimer-policy.mjs` — the same policy for every transcript
— not by you.

**How to pick `scope`** (see `ground-truth-format.md`'s "Disclaimers" section for the full rationale):

1. If the auditor names a whole **resource** that maps to one of the 7 `schema.ts` groups and
   nothing outside it (a water heater → `dhw`; an attic → `attic`), use
   `{ "kind": "group", "group": "<name>" }`.
2. If the auditor's statement is narrower than a full group — the standing cases are the blower-door
   pair (`namedSet: "blowerDoor"`), the 13-test health battery specifically (`namedSet: "healthTests"`
   — the word "tests," bare and unqualified, conventionally means this in an energy-audit
   transcript), or the whole building envelope (`namedSet: "shell"`) — use
   `{ "kind": "namedSet", "set": "<name>" }`. These three are the complete list today; do not invent
   a fourth without a second real transcript needing the same one (see `disclaimer-policy.mjs`'s own
   comment).
3. If neither fits, use `{ "kind": "unresolved" }`. The disclaimer is still recorded (a future policy
   update may resolve it); it simply reaches no leaf today. Do not force it into the nearest
   approximation.
4. A trailing, topic-free "nothing else today" needs **no disclaimer at all** — "unmentioned" is
   already every leaf's default, so a statement that names nothing specific changes nothing.

**A leaf you address individually always overrides a disclaimer covering it** — this is structural
(`resolveGroundTruth`'s resolution order), not something you have to manage. The worked example's
`healthAmbientCarbonMonoxide` leaf is covered by the "No tests" disclaimer AND has its own, more
specific `leaves` entry; the explicit entry wins, with no conflict and no judgment call about which
should apply.

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

**When the schema conflates two independently-addressable facts into ONE enum axis, and the
transcript addresses only one of them, this is a MECHANICAL rule, not a per-transcript judgment
call.** `hvacSystemEquipmentType` is the standing example: `"Furnace with standalone ducts"` and
`"Furnace / Central AC (shared ducts)"` differ only on whether the furnace shares ducts with a
central AC unit — an axis the pre-rebuild field set never had to distinguish. An auditor who says "a
gas furnace" and nothing else about cooling has stated the equipment family and left that axis
completely unaddressed; **neither member is more supportable than the other**, because both are
correct about the part that was said and neither is contradicted by anything that wasn't.

The rule: **pick either one of the conflated members as `member`, list the other in
`arguable.acceptableAlternatives`, and write the note stating explicitly that the two are symmetric —
not that one is preferred.** Do not use `noFittingMember` here — that is for when NOTHING fits (rule
above); this is the opposite problem, where something fits equally well in two ways, and
`noFittingMember` would incorrectly make ANY real member (including a genuinely wrong one, like
`"Boiler"`) score as merely "unscorable" instead of "wrong." The symmetry is what
`acceptableAlternatives` is for: a run landing on either member is never penalized, while a run
landing on a real but genuinely different equipment family is still a hard wrong answer, because
something real actually was contradicted. If you hit this pattern on your transcript, note in the
`arguable.note` that it is a schema-rebuild-introduced ambiguity, not something the transcript itself
is unclear about — that distinction is a finding about the schema, worth escalating, and is different
in kind from an ordinary contested reading.

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
  (`Good`/`Potential Issues`/`NA`), scored like any other enum leaf, and is NOT part of the
  `healthTests` named set (rule 4) — a blanket "no tests" does not touch it.
- A BARE, unqualified "tests" in a blanket disclaimer ("No tests," "no safety tests") means the
  `healthTests` named set — record it as a disclaimer (rule 4), not as 13 individual `"Not Tested"`
  leaf entries. Only write an individual leaf entry when the auditor names that specific test.

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
