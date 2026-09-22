# Live-run evidence for the three shape designs

**Date:** 2026-09-22
**Status:** Findings — measured, not designed. Cited by the partial-application, mixed-schema-split
and `describeExtraction` designs.
**What ran:** `docs/spikes/0009-basedata-proposer/` against Snugg Pro's live Swagger and the Helix
dev gateway (`claude-haiku-4-5`), then a follow-up extraction driven from the saved proposal.

The three designs beside this file were each argued from the source. This file is what happened
when the pipeline was actually run end to end. Nothing here is a proposal; every number is
measured, and the shapes that produced them are reproducible from the spike's saved
`proposer-trace.json`.

---

## 1. The proposal

Pointed at `definitions.basedata` — **294 flat top-level properties** — the model proposed **91
operations**: 64 `drop`, 14 `nest`, 13 `retype`. It reached for `nest` **unprompted**: the spike's
domain instructions mention drops, retypes and regrouping, never nesting. The directive alone
carried it.

The 14 nest groups, covering 203 leaves: `thermostat`, `clothesWasher`, `dishwasher`, `pool`,
`ventilation`, `lighting`, `basement`, `crawlspace`, `floor`, `ev`, `heatTape`, `waterHeater`,
`ashrae62`, `hvac`.

## 2. One invalid operation cost all ninety-one

The applier refused the set because **one** `retype` named `ashraeRequiredAdditionalCfmImproved`, a
leaf the same proposal also dropped. The repair turn did not find it, and the run exhausted to `[]`
— no drops, no retypes, and none of the fourteen good nests.

Two things this measures, both of which the partial-application design argues from the source:

- **The economics.** A large proposal has as many chances to contain one bad operation as it has
  operations. All-or-nothing application means the cost of one is the whole set.
- **The blame.** The refusal named the victim (the retype), not the culprit (the drop). A repair
  model reading it cannot tell which of the two to retract.

The repair budget's default was raised 1 → 3 in response. That is a mitigation; it does not change
the economics.

## 3. A partially nested schema could not be split at all

With the one bad retype removed by hand, the 14 nests apply. The resulting schema **fails to
split**:

```
splitExtractionSchema: schema has a property "pool" that cannot fit any piece —
one piece carrying it alone is 24 nullable unions and 7090 serialized characters,
over the caps (maxNullableUnionsPerGroup 16, maxSerializedCharsPerGroup 19000)
```

Four shapes from the same vendor schema, same caps (union 16, bytes 19 000):

| Shape                                             | Split result                                          |
| ------------------------------------------------- | ----------------------------------------------------- |
| No operations — the raw flat schema               | 38 pieces                                             |
| Drops + retypes, no nests                         | 30 pieces                                             |
| **The model's proposal — 14 nests, 47 leaves loose** | **fails**                                          |
| Every leaf nested — no loose leaves left          | 27 pieces, oversized groups partitioned within themselves |

The last row is the important one: the per-group path handles an oversized group correctly. It is
only the **mixed** schema that has nowhere to go, because the flat fallback treats every top-level
key as atomic and a group is not atomic.

**This is not a defect `nest` introduces.** A hand-written schema with an oversized group beside a
loose top-level leaf fails identically, with no nest anywhere near it — measured directly. What
`nest` does is make the shape easy and likely to reach, because a partially nested schema is the
proposer's natural output.

## 4. The sweep works, and is the wrong answer

A workaround was measured before the mixed-schema design was read: append one deterministic `nest`
gathering every top-level leaf no other nest claimed into an invented group (`other`). Every
top-level key is then a group, so the existing all-groups path applies.

It works — 16 top-level keys, 34 pieces, no `""` piece, mapping and patch schema identical to the
unswept derivation. **And it should not be built.** The invented key is not confined to the split:
it reaches `groupInstructions(key)`, the few-shot projection, the review tree's group nodes and
`statedEmptyGroups`. The mixed-schema design's §1 states this leak; the measurement here only
confirms the workaround is available, not that it is right.

Recorded so nobody re-derives it and ships it.

## 5. The wiring is not enough on its own

Sending each key to the packer that already fits it — `partitionGroupTwoCaps` for groups,
`partitionFlatTwoCaps` for loose leaves — makes the split succeed (34 pieces, named groups). It is
about 25 lines and needs no new packing algorithm.

It then fails one layer down:

```
groupedExtractor: the "" key declares the non-grouped fallback — one entry covering
the whole schema — and cannot be combined with per-key entries ("customFields",
"thermostat", "clothesWasher", …)
```

And it **breaks a shape that works today**: a mixed schema whose group fits the caps currently
packs atomically under `""` and is accepted; with the split changed and the map contract unchanged,
it emits `["small", ""]` and is refused. The splitter change and the `""` contract change are one
change, not two — the mixed-schema design's §4.2 is the necessary half.

## 6. End to end, it reaches a valid submission

With the bad retype removed, `customFields` dropped, and the leaves swept (§4), the full pipeline
runs:

- 15 extraction top-level keys, 229 mapping leaves
- **33 chat calls, 36 seconds**
- reversed through `reverseShapedFields` to 229 patch top-level keys, 36 non-null
- **valid against the original POST body schema**

A sample of what survived the round trip, at the vendor's own flat paths:

```
conditionedArea = 1800            numberOfOccupants = 2
typeOfHome = "Single Family Detached"
programmableThermostatInstalled = "Yes"
heatingSetpointHigh = "68"        coolingSetpointHigh = "76"
blowerDoorReading = 1250          basementCavityInsulation = 19
```

This is the "maps back to submit" claim spike 0009 set out to test, and the first time it has been
demonstrated on a real API body.

## 7. One failure none of the three designs covers

`customFields` is a vendor-extension collection. The model filled it with **49 entries missing a
required key**, and the extraction failed parsing them — on the nest-derived shape and on the flat
baseline alike. It had to be dropped by hand for §6 to run.

It is unrelated to nesting, to the split and to partial application. Recorded here because it is a
real obstacle on the path this work exists to open, and it belongs to none of the three designs.

## 8. What the diagnostic would have saved

Six throwaway probe scripts were written to answer questions `describeExtraction` reports directly:
which top-level keys are groups, which are loose, which split path applies, how many pieces, and
whether construction succeeds. Three of this file's sections are that helper's output, obtained the
expensive way.
