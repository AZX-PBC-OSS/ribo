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

| Shape                                                | Split result                                              |
| ---------------------------------------------------- | --------------------------------------------------------- |
| No operations — the raw flat schema                  | 38 pieces                                                 |
| Drops + retypes, no nests                            | 30 pieces                                                 |
| **The model's proposal — 14 nests, 47 leaves loose** | **fails**                                                 |
| Every leaf nested — no loose leaves left             | 27 pieces, oversized groups partitioned within themselves |

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

## 7. One failure the naive schema caused, and the real adapter already avoids

`customFields` is Snugg Pro's per-account extension point. The model filled it with **49 entries
missing a required key**, and the extraction failed parsing them — on the nest-derived shape and
on the flat baseline alike. It had to be dropped by hand for §6 to run.

**This was first recorded here as "a real obstacle belonging to none of the three designs". That
was wrong, and the correction is the useful part.** The hand-built adapter already excludes the
field, deliberately and on the record: `schema.ts` carries no `customFields` leaf, and two
comments say why — "every `formData` parameter of the endpoint but the malformed `customFields`"
and "`customFields` is response-only". What hit the field was **this probe's naive schema
builder**, which maps the Swagger definition straight to zod with none of that scoping. That is
the builder working as intended — the probe exists to ask what a model does with an unscoped
generated schema — so neither the adapter nor `naive-zod.mjs` needs a fix.

**Why the vendor's declaration defeats a generator.** The parameter is underspecified twice over
(Swagger 2.0, verified against the live spec):

```json
{
  "name": "customFields",
  "type": "array",
  "description": "It accepts array of objects with key and value as strings, e.g. [ { \"key\": …, \"value\": … } ]"
}
```

No `in`, which every Parameter Object requires and which says where the value goes; and
`type: "array"` with no `items`, which a non-body array parameter requires. The real contract
lives only in the English `description`, which no generator reads. A strict validator rejects the
object; a generator that tolerates it emits an array of anything and hands the model a field with
no constraints.

**What is worth keeping from this.** Both halves of the problem are deterministic, which is easy
to assume they are not:

- The malformed parameter is detectable structurally — a parameter with no `in` cannot be placed,
  so a generator can refuse or drop it without asking a model anything.
- An account's real custom fields are generatable mechanically: the `customField` definition
  carries `key`, `valueType` ("string, integer, decimal or datetime"), `min`, `max` and `options`
  per field, which maps to zod by table.

What needs a model is the part that already has one — deciding which of 294 fields a speaker
actually dictates, which is the human's 163-of-294 scoping and what `proposeShapeOperations`'
`drop` approximates. Doc 17 §4 ("Custom fields — confirmed present, and they matter") argues
custom fields are a capability rather than noise.

**Decided 2026-09-24: leave them dropped.** Not because they are worthless — doc 17's argument
stands — but because supporting them needs three things and only the first is cheap. There is no
way to _enumerate_ an account's fields (no `/custom-fields` path exists; you read them off a job's
response, and the definition says "if present", so a defined-but-unset field may be invisible).
Nobody has verified a write actually lands, and this vendor's spec has been wrong about writes
before — spike 0007 found `Idempotency-Key` ignored despite the documentation. And extracting them
_well_ wants each field as a leaf carrying its own enum and bounds, while the API wants
`[{ key, value }]` — a leaves-to-keyed-array transform the shape mapping cannot express, because
its transform set is closed at one member (string→number). That third one would be a good
addition, being invertible in both directions, but it is not written.

The order if this is ever picked up: **probe the write first**, the way spike 0007 probed merge
semantics. If writes do not land, the other two questions are moot.

## 8. What the diagnostic would have saved

Six throwaway probe scripts were written to answer questions `describeExtraction` reports directly:
which top-level keys are groups, which are loose, which split path applies, how many pieces, and
whether construction succeeds. Three of this file's sections are that helper's output, obtained the
expensive way.
