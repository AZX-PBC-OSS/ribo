# Reconciliation report: merging the 13 double-annotated transcripts

This document records how the 26 blind annotations (13 transcripts × 2 annotators, `a/` and `b/`)
were merged into the 13 committed `ground-truth/NN-slug.json` files, replacing the OLD flat
snake_case files that used to live there. `11-ambiguous-attic.json` was already in the new format
(the worked reference) and was left untouched.

The pre-existing OLD-format files (one hand annotation per transcript, against a field set that no
longer exists) were read as a **third opinion** — evidence, never authority, since the two blind
annotators were deliberately barred from seeing them and their independence would be worthless if
this reconciliation just deferred to them anyway. Where the old file is mentioned below, it is
because it corroborates, contradicts, or is simply orthogonal to the A/B disagreement at hand.

## Method

For every transcript: read the transcript, both annotations, and the old file; diffed every leaf
`a` and `b` wrote (including `arguable`/`retracted` shape, not just `status`/`member`/`value`); and
additionally ran a mechanical check of every one of the 12 **number-kind** leaves
(`basedata.yearBuilt`, `conditionedArea`, `floorsAboveGrade`, `numberOfBedrooms`, `blowerDoorReading`;
`hvac.hvacHeatingSystemModelYear`, `hvacHeatingCapacity`, `hvacCoolingCapacity`,
`hvacDuctLeakageValue`; `attic.atticInsulation`; `wall.wallCavityInsulation`; `dhw.dhwTankSize`)
across all 13 pairs for presence/value mismatches, per the task's rule 3 (a leaf one annotator
wrote a number for and the other silently omitted is invisible to the validator and easy to miss by
eye alone).

## Rulings applied uniformly (given, not re-litigated)

1. **Unlisted enum member on an enum WITH a catch-all → `member: "Other"`**, never `noFittingMember`
   (reserved for enums with no catch-all at all).
2. **Blanket negation narrower than a group → the WIDEST scope the auditor's stated reason
   supports**, relying on explicit leaf entries to structurally override it.
3. **Number leaves: diff coverage, not just values.** Checked mechanically (see Method); see the
   Summary for the result — it came back clean.
4. **Ambient CO vs. undiluted flue CO**: `healthUndilutedFlueCo` only when the flue, a probe, or
   combustion gas is explicitly named; otherwise `healthAmbientCarbonMonoxide`. Not annotation-fixable
   — reported below as a schema finding.
5. **Two real HVAC systems, one instance slot** (08, 12): record the chosen instance, document the
   loss prominently, do not pretend the format solved it.

---

## Per-transcript disagreement inventory

Only leaves/disclaimers where the two annotators' files actually differed are listed. Everything
else in each pair was byte-identical or differed only in cosmetic span choice — which, per the
annotator guide's own stated goal ("byte-identical on the unambiguous, legible disagreement on the
arguable"), is exactly the intended outcome and is not itemized here.

### 01 — attic-r-value-shell

| Leaf/disclaimer      | A said                                                                                                                                            | B said                             | Chosen              | Why                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `disclaimers` (wall) | `{ kind: "unresolved" }` — reasoned that `group: "wall"` would incorrectly also negate the separately, positively stated `wallExteriorWallSiding` | `{ kind: "group", group: "wall" }` | **`group: "wall"`** | Ruling 2. The auditor's stated reason ("I didn't open anything up... I can't tell you on the wall insulation") is at least as wide as the whole wall group; the format's structural override (an explicit leaf entry always beats a group disclaimer) already handles the siding leaf correctly without needing `unresolved`. This is the canonical instance ruling 2 was written to resolve. |

1 disagreement.

### 02 — oil-boiler-basement

| Leaf                          | A said                           | B said                                                                                                                      | Chosen                      | Why                                                                                                                                                                                                                                                                                          |
| ----------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hvac.hvacHeatingSystemModel` | value `"V8, V-eight series"`     | value `"V8"`                                                                                                                | **`"V8"`**                  | The plate reads "V8"; "V-eight series" is the auditor phonetically re-spelling the same model number for dictation, not a second detail.                                                                                                                                                     |
| `health.healthGasLeak`        | asserted `Passed`, no `arguable` | asserted `Passed`, `arguable.acceptableMiss: true` (worried the oil-system sniff sweep might not be a true "gas" leak test) | **`Passed`, no `arguable`** | "no gas smell... but no leaks at the fittings either, all dry" is rule 8's own "gas sniffer was quiet" example almost verbatim — a real, performed, clean check. Flagging it arguable is a mild instance of rule 10's overuse warning; the old GT agreed with a confident `passed` here too. |

2 disagreements (both minor/stylistic — this pair converged almost completely).

### 03 — quick-exterior-short

| Leaf/disclaimer                                          | A said                                                         | B said                                                                                                 | Chosen                   | Why                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `window.windowType` `arguable` shape                     | `acceptableMiss: true` (a model leaving it null is defensible) | `acceptableAlternatives: ["Don't Know"]` (a model answering the enum's own escape hatch is defensible) | **both**                 | Neither excludes the other — a hedged-but-stated "double pane" licenses either a null miss or the enum's real `"Don't Know"` member. Merged, same pattern as the `dhw.dhwLocation` merge on 05.                                                                                       |
| `disclaimers` (3rd entry, "nothing on the inside today") | included as `{ kind: "unresolved" }`, with a note              | omitted — read as rule 4.4's topic-free trailing statement                                             | **included, unresolved** | It names a real (if broad) scope — "the inside" as contrasted with the exterior-only visit just described — closer to rule 4.3's "worth recording, reaches no leaf today" than to 4.4's genuinely topic-free "that's it for today." Costs nothing: it resolves to no leaf either way. |

2 disagreements.

### 04 — fuel-stated-separately

**THE ruling-1 fork site.** Across the corpus, both annotators on transcript 02 discussed the
`Other`-vs-`noFittingMember` tension in their notes (and agreed on `Other` for "Burnham"); on 04,
they actually split.

| Leaf                                 | A said                                                                                              | B said                                                   | Chosen                | Why       |
| ------------------------------------ | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | --------------------- | --------- |
| `hvac.hvacHeatingSystemManufacturer` | `noFittingMember: { auditorMeaning: "Weil-McLain" }` + `arguable.acceptableAlternatives: ["Other"]` | `member: "Other"`, with a note flagging the same tension | **`member: "Other"`** | Ruling 1. |

The attic disclaimer ("No attic access from inside... nothing on attic insulation") is **not** a
disagreement — both annotators independently chose `group: "attic"` over a narrower reading, each
reasoning explicitly through the "widest scope the stated reason supports" logic ruling 2 later
stated generally. Cited in the task prompt as one of the two transcripts ruling 2 resolves; recorded
here for accuracy as a case of _agreement_, not conflict — 01's wall disclaimer is the actual split.

1 disagreement.

### 05 — full-walkthrough

The richest transcript; also converges near-completely on the two headline findings (the
hvac cardinality collision, the CFM50/ACH50 derivation trap) while producing several smaller,
real disagreements in the `arguable` margins:

| Leaf                                     | A said                                                                                                     | B said                                                                                                                                   | Chosen                                              | Why                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hvac.hvacUpgradeAction`                 | `member: "Replace with a newer model"`, `arguable.acceptableAlternatives: ["Remove a system permanently"]` | same `member`, `arguable` with no alternatives — explicitly argued "Remove" does NOT fit, since a replacement (the heat pump) is planned | **no alternatives, `acceptableMiss: true` instead** | B's textual argument is correct — "remove permanently" implies no replacement, contradicted by "swap this out for a heat pump." The genuine doubt is attribution (homeowner's plan vs. auditor's own recommendation), which `acceptableMiss` captures better than a wrong-fit alternative member.                     |
| `hvac.hvacDuctLeakage`                   | clean `member: "Measured (CFM25)"`, no `arguable`/`retracted`                                              | `retracted: [{ value: "30% - Very leaky" }]` + `arguable.acceptableAlternatives: ["30% - Very leaky"]`                                   | **clean, no `arguable`/`retracted`**                | No "no wait"/"scratch that" language was ever used (B's own note admits this), so it isn't a rule-5 retraction; schema.ts's own per-leaf comment says to pick `"Measured (CFM25)"` mechanically whenever a duct-blaster number was read. Same resolution applied to the structurally identical case on transcript 10. |
| `attic.atticInsulation` `arguable` shape | `acceptableMiss: true`                                                                                     | prose-only, no explicit `acceptableMiss` field (though the note argues for the same leniency)                                            | **`acceptableMiss: true`**                          | B's own prose already supports it; made mechanical.                                                                                                                                                                                                                                                                   |
| `dhw.dhwAge`                             | `declared_absent`, no `arguable`                                                                           | `declared_absent`, `arguable.acceptableAlternatives: ["0-5"]` (from "it's newer though")                                                 | **include the alternative**                         | "it's newer though" is a real gesture rule 3 says not to promote to an asserted value, but it is concrete enough to be worth a sanctioned alternative, not silence.                                                                                                                                                   |
| `dhw.dhwLocation` `arguable` shape       | `acceptableMiss: true`                                                                                     | `acceptableAlternatives: ["Don't Know"]`                                                                                                 | **both**                                            | Same merge as 03's `windowType`.                                                                                                                                                                                                                                                                                      |

5 disagreements, all in the `arguable` margins — no disagreement on any asserted `status`/`member`/`value`.

### 06 — homeowner-crosstalk

**Zero leaf-level disagreements.** A and B converged completely, including the symmetric furnace
tie-break, the asbestos hearsay trap, and the `shell` named-set disclaimer. B additionally documented
(in `notes`, not as a leaf) a near-miss consideration — whether "we bought the house in twenty-fifteen
and it was brand new then" could support `basedata.yearBuilt: 2015` — and correctly declined it
under rule 3's attribution rule (the auditor never independently confirms it). Carried into the
merged file as documentation, not as a disagreement.

0 disagreements.

### 07 — combustion-safety

**One of the two explicit CO-leaf splits** (ruling 4) plus a leaf-omission-vs-`noFittingMember` split:

| Leaf                           | A said                                                                                                                      | B said             | Chosen                | Why                                                                                                                                                 |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ------------------ | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `health.healthUndilutedFlueCo` | left unmentioned (read "The furnace flue itself was fine" as possibly describing physical condition, not a CO reading)      | `member: "Passed"` | **`Passed`**          | Ruling 4 — the flue is explicitly named, in direct contrast against the ambient figure in the same sentence.                                        |
| `dhw.dhwLocation`              | `noFittingMember: { auditorMeaning: "the utility room, conditioning status unstated" }` + `arguable.acceptableAlternatives` | left unmentioned   | **`noFittingMember`** | THE ONE RULE: something concrete WAS said ("the utility room"); omitting because the exact member is unclear is the guide's own named failure mode. |

2 disagreements.

### 08 — no-fuel-silent-drop

The **first** of the two task-flagged single-hvac-instance transcripts. Both annotators converged on
which system occupies the slot (the furnace) and on documenting the loss; one real disagreement:

| Leaf                          | A said                                                                                                                  | B said                                                              | Chosen                       | Why                                                                                                                                                                                                                                                                                    |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hvac.hvacHeatingSystemModel` | `declared_absent` (span: "I couldn't get the full model number..."), `arguable.acceptableAlternatives: ["G-something"]` | `asserted`, `value: "G-something"`, `arguable.acceptableMiss: true` | **`asserted "G-something"`** | The auditor DID read something off the plate ("model G-something") before explaining it was incomplete — a real, if partial, fragment, closer to a grounded partial value than a pure non-answer (contrast the model YEAR on the same leaf cluster, where nothing at all was legible). |

1 disagreement. See the file's own prominent loss note for the cardinality finding itself (not a disagreement — both annotators agreed on the shape of the problem).

### 09 — chatter-and-scheduling

**Zero A/B leaf disagreements** — full convergence on the DHW leaves, both compound disclaimers, and
(most notably) on declining to assert `dhw.dhwAge` from "Yeah, two years, so no concern on that one at
all." That last point is a genuine **old-GT vs. new-consensus** conflict worth flagging on its own:
the pre-existing old-format file asserted `dhwAgeBand: "0-5"` here, apparently by design, as a
deliberate contrast case against transcript 06's outright refusal. Both new, independent annotators
read the auditor's line as an uncritical echo, not an independent confirming act (no plate-read
equivalent), and declined to assert it — read as evidence that rule 3's bar ("independently confirms
... in their own words") is stricter than a bare repeat-back, even a warm one. Resolved in favor of the
new consensus; recorded in the file's own notes.

0 A/B disagreements (1 old-GT-vs-new-consensus conflict, resolved toward the new consensus).

### 10 — crawlspace-loose-units

Three disagreements, all shape-only (no `status`/`member`/`value` conflicts):

| Leaf                               | A said                                                                   | B said                                                                                      | Chosen                     | Why                                                                                                                                                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hvac.hvacDuctLeakage` `arguable`  | `acceptableAlternatives: ["15% - Somewhat leaky"]`                       | note-only, no alternatives (treats schema.ts's mechanical instruction as fully settling it) | **no `arguable` at all**   | Same resolution as 05's identical pattern — mechanical, not contested.                                                                                                                                          |
| `basedata.blowerDoorTestPerformed` | `arguable.acceptableMiss: true` (no literal "test"/"estimate" word used) | clean `Tested`, no `arguable`                                                               | **clean `Tested`**         | "I duct-blasted it... let me be careful reading my numbers back" plus a precisely-reported CFM50 reads as a real instrument result, not a guess; flagging it hedges a call that isn't actually close (rule 10). |
| `dhw.dhwLocation` `arguable` shape | note-only                                                                | `acceptableMiss: true`                                                                      | **`acceptableMiss: true`** | B's more complete, mechanically-checked shape; same underlying call either way.                                                                                                                                 |

3 disagreements, all in the `arguable` margins.

### 12 — wrong-field-old-unit

The **second** task-flagged single-hvac-instance transcript — but structurally a _contrast_ to 08,
not a duplicate: only one system (the new furnace) is current, and the old boiler is unambiguously
decommissioned, so this is cleanly resolvable with zero information loss (see the merged file's own
note contrasting it with 08).

| Leaf/disclaimer      | A said                                                   | B said                                                           | Chosen                                    | Why                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------- | -------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Old-boiler exclusion | recorded as a third disclaimer, `{ kind: "unresolved" }` | not recorded as a disclaimer at all — documented only in `notes` | **not a disclaimer; documented in notes** | Consistency with how the corpus's other same-shape decoys are handled — the decommissioned floor furnace on 05 and the neighbor's boiler on 10 are both handled by documentation alone, with no disclaimer entry, because the excluded unit negates no leaf of the file's single hvac record (the real record's own leaves are all individually asserted, not swept by a negation). |

Both annotators independently flagged `health.healthAmbientCarbonMonoxide` ("CO check by the new
furnace, clean, zero ppm") as a leaf-choice ambiguity against `healthUndilutedFlueCo` — but both
landed on the SAME leaf and member (ambient, Passed), so this is not a disagreement; it is the third
of the four ambient/flue-confusable sites, resolved the same way by ruling 4.

1 disagreement.

### 13 — enum-paraphrase

**The other explicit CO-leaf split** (ruling 4) — and the corpus's most literal match to the ruling's
own illustrative phrasing ("CO at both appliances... zero ppm" vs. the ruling's "CO at both
appliances, zero ppm"):

| Leaf    | A said                                             | B said                                                                                    | Chosen                                   | Why                                                                                                                                |
| ------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| CO leaf | `health.healthUndilutedFlueCo`, `member: "Passed"` | `health.healthAmbientCarbonMonoxide`, `member: "Passed"`, `arguable.acceptableMiss: true` | **`health.healthAmbientCarbonMonoxide`** | Ruling 4 — neither the flue, a probe, nor combustion gas is named; "at both appliances" describes location, not measurement point. |

1 disagreement.

### 14 — rapid-recap

**Zero disagreements.** Full convergence, including the 4-way compound-disclaimer split (rule 4's
own cited example transcript), the DHW leaves, the declined `dhwAge` band, and the excluded comfort
complaint.

0 disagreements.

---

## Summary counts

| Transcript | Disagreements |
| ---------- | ------------- |
| 01         | 1             |
| 02         | 2             |
| 03         | 2             |
| 04         | 1             |
| 05         | 5             |
| 06         | 0             |
| 07         | 2             |
| 08         | 1             |
| 09         | 0             |
| 10         | 3             |
| 12         | 1             |
| 13         | 1             |
| 14         | 0             |
| **Total**  | **19**        |

**Rule 3 (invisible-by-omission number-leaf coverage): 0 found.** Every one of the 12 number-kind
leaves (`basedata.yearBuilt`/`conditionedArea`/`floorsAboveGrade`/`numberOfBedrooms`/
`blowerDoorReading`, `hvac.hvacHeatingSystemModelYear`/`hvacHeatingCapacity`/`hvacCoolingCapacity`/
`hvacDuctLeakageValue`, `attic.atticInsulation`, `wall.wallCavityInsulation`, `dhw.dhwTankSize`) was
checked mechanically for presence and value across all 13 pairs (156 checks); every pair that
asserted a number leaf at all asserted the identical value on both sides. This is a genuine null
result, not an oversight — both a manual per-transcript read and a script-driven diff (comparing
`leaves` key presence and `value`/`status` for every number path in every pair) came back clean. It
means this particular 13-transcript corpus, as annotated, does not happen to exhibit the
spoken-number-omission hazard rule 3 warns about — worth knowing precisely because the hazard is real
and the corpus is small; a larger corpus should not assume the same.

**Ambient-vs-undiluted-flue CO (ruling 4):** the CO leaf was asserted by at least one annotator on 7
transcripts (01, 04, 05, 06, 07, 12, 13). Of those, 3 (01, 04, 05) explicitly say "ambient" and are
not confusable. The remaining **4** (06, 07, 12, 13) are genuinely confusable — no "ambient"/"flue"
word is used — and of those 4, the annotators actually **split** on **2** (07, 13); on the other 2
(06, 12) both independently landed on the same (ambient) reading despite recognizing the ambiguity.
(The task brief's framing suggested five confusable sites; a systematic grep of both annotation
directories for every leaf-path occurrence found exactly four — reported as found, not adjusted to
match the expectation.)

---

## Schema findings

Findings below are corpus evidence that the **schema itself**, not the transcripts or the
annotators, cannot represent something real and commonly said. None of these were "fixed" by
annotation — per the task, that would misrepresent what actually happened.

### 1. Ambient CO vs. undiluted flue CO (ruling 4) — the headline finding

`health.healthAmbientCarbonMonoxide` and `health.healthUndilutedFlueCo` are textually
indistinguishable whenever an auditor reports a CO reading "at the appliance"/"by the appliance"
without saying the word "flue," "probe," or naming combustion gas specifically. Four transcripts (06,
07, 12, 13) hit this pattern; two pairs of independent, expert-grade annotators split on it outright
(07, 13), each with an internally consistent, defensible rationale pointing the opposite way. This is
reported here, not resolved by cleverer annotation, because **a small local model will do worse than
these annotators did, and cannot flag its own doubt** — an annotator who splits 50/50 on a genuinely
underdetermined phrase is behaving correctly; a model that silently picks one is indistinguishable
from a model that got it right by luck. This is the single finding most deserving the owner's
attention (see the top-level report).

### 2. Sub-group scope gap: no `namedSet` for "insulation, not siding"

Transcript 01's "I can't tell you on the wall insulation" and transcript 13's wall-insulation
disclaimer both negate a slice of the `wall` group (the insulation leaves) that is narrower than the
whole group but doesn't match any of the three closed `NAMED_SETS` (`blowerDoor`/`healthTests`/
`shell`). Ruling 2 makes this resolvable today (group scope + the structural leaf-entry override),
but the underlying gap is real: if this pattern recurs enough, a fourth named set
(`wallInsulationOnly` or similar) would let the annotator stop relying on the override coincidence
that the siding leaf happens to always be positively stated in the same breath.

### 3. Cardinality collisions: one hvac instance, sometimes two real systems

Transcripts 05, 08, and 12 all narrate two distinct HVAC systems in one dictation. In 05 and 08, both
narrated systems are **current**, and the schema's single hvac instance genuinely cannot represent
the house — the merged files for both transcripts document a real information loss (duct-detail
leaves describing a different physical system than the identity leaves) rather than pretending the
format solved it. 12 is a useful contrast: there, only one system is current (the other is
decommissioned and explicitly excluded), so the collision is a clean wrong-field trap, not a
representability problem — the same surface pattern, two different severities. `schema.ts`'s own file
header already documents this as a known, deliberate divergence (not an oversight); this corpus
supplies three concrete instances of it actually firing.

### 4. Real utterances with no leaf at all

- **Wall framing/assembly material** (transcripts 01, 03, 13): "a two-by-six frame," "concrete
  block... a masonry house," and (01) the pre-rebuild schema's now-dead `wallConstruction` concept.
  `WallFields` has siding and insulation leaves but nothing for the assembly itself.
- **Roof geometry vs. covering material** (transcript 04): "it's a flat roof" describes shape;
  `atticRoofType` is a 4-member covering-material enum (shingles/tile/shakes/tar-and-gravel) with no
  catch-all and no geometry axis at all.
- **DHW model number** (transcript 09): "Navien NPE-something" — `DhwFields` has `dhwManufacturer`
  but no model-number leaf, unlike `hvac.hvacHeatingSystemModel`.
- **DHW venting** (transcripts 06, 09, 13, all independently): "natural draft up the flue,"
  "power-vented... PVC going out the wall" — no DHW vent-type/hardware leaf exists at all (HVAC has
  none either, per `ANNOTATOR_GUIDE.md` rule 3's own `combustionVentType` example, but DHW's absence
  is a separate, independently-recurring gap).
- **Comfort complaints** (transcript 14): "the upstairs is always cold in winter" — a real, common
  audit-visit utterance (usually second-hand, from the homeowner) with no leaf anywhere in the 51,
  and (independently) unconfirmed by the auditor per rule 3 even if one existed.

### 5. The `Other`-vs-`noFittingMember` documentation fork (ruling 1)

Resolved uniformly by this reconciliation, but worth recording as a real ambiguity in the _source
documents_, not just the annotators: `schema.ts`'s own docstring on `hvacHeatingSystemManufacturer`
says an unlisted real manufacturer "maps to `Other` instead, which is a real answer," while
`ground-truth-format.md`'s general "when nothing fits" section, read in isolation, points at
`noFittingMember`. Four annotator-instances across two transcripts (02, 04) surfaced this tension in
their own notes; only 04 actually produced a file-level split. The two documents should be reconciled
directly (a cross-reference from `ground-truth-format.md`'s `noFittingMember` section to the
`Other`-catch-all case would suffice) so a 27th annotator does not have to rediscover this.
