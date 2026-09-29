# Field descriptions travel in the prompt, not the schema

**Date:** 2026-09-25
**Status:** Implemented, opt-in. The emission and the strip are one behaviour with one switch
(`fieldDescriptions: "prompt" | "schema"`, default `"schema"`, ADR 0030); the split, the caps
and `maxSerializedCharsPerGroup` are untouched. Measurements below are from this repo's real
Snugg Pro adapter under the split configuration the consumer app runs.

## The problem

`@azx/ribo-core` constrains extraction with a JSON Schema in
`response_format: { type: "json_schema", strict: true }`. The adapter schemas it is given are
spec-generated and carry a `description` on nearly every field — guidance written for the model
("fuel is a separate field, so decompose 'oil boiler' into 'Boiler' here and 'Fuel Oil' in
`hvacHeatingEnergySource` — never a fused token"). Hosted structured-output routes cap the
_schema_, not the messages: one measured route rejects a schema past 32,768 serialized
characters. A description is prompt material sitting inside a schema budget, and the two budgets
are different — a word emitted into the system message costs nothing against the schema cap.

The cost of getting this wrong was measured twice. A consumer app stripped every description
before the request (schema budget), and a live extraction labelled a furnace with no central AC
as `"Furnace / Central AC (shared ducts)"` — the correct member
(`"Furnace with standalone ducts"`) was present the whole time, and the sentence distinguishing
them was the description the model never saw. Same transcript with descriptions restored:
correct.

## Decisions

### 1. Emission lives in `buildMessages`, with one shared helper

The three prompt assembly entry points are `buildMessages`, `buildGroupMessages` (which
delegates to `buildMessages` over a projected target) and `buildFillMessages`. Emission is ONE
helper — `renderFieldGuidance(schema)` / `withFieldGuidance(instructions, schema)` in
`extraction/field-guidance.ts` — called from `buildMessages` and from `buildFillMessages`.

The scale requirement falls out and needs no special case: `buildMessages` walks the schema of
the target it is HANDED, and a per-group call hands it the projected target whose
`extractionSchema` is its one group (or partitioned piece). A per-group call carries only its
own group's guidance; a partitioned piece only its piece's. `buildFillMessages` walks the
prepared group's own schema (passed as a new trailing `pieceSchema` parameter — the exact shape
the call is pinned to, a collection's single-instance wrapper included), so a fill carries only
its piece's guidance too.

**The inventory roster takes no emission and needs none.** `extractInventory` composes its own
messages and its roster schema is synthetic and adapter-owned — it carries no field
descriptions, so the emission helper would render nothing and the strip is a no-op there. No
special case was added; if a future roster schema grew descriptions, the honest move would be
emission at that call site, decided then.

### 2. The form is the leaf inventory's own format

`renderFieldGuidance` reuses `walkLeafInventory` + `renderLeafInventory` — the shape proposer's
existing inventory walk and renderer — filtered to the described entries. One format, not two:
`- path (kind) — "description"`, bucketed under top-level segment headers. The walk is the
enveloped schema's, so a description surfaces at the coordinates the model writes
(`hvacSystemEquipmentType.value` under `"leaf"` provenance, at the leaf directly under
`"row"`). Two properties pinned by test:

- A description-less schema renders `null`, and the builders then change nothing — every
  synthetic schema (roster, presence, ask, classify, gap-fill) and any adapter without
  descriptions emits byte-identical prompts to before this change.
- The walk refuses unsupported shapes (unions, records) — that refusal exists for the shape
  proposer, where a loud rejection IS the point. The extraction path only needs the bonus
  text, so `renderFieldGuidance` catches it and degrades to "no block"; a schema built through
  `enveloped()` never refuses.

The block is appended AFTER the target's instructions, matching the gap-fill directives' existing
precedent for core text following adapter instructions in one system message. Because an
adapter's instructions conventionally end with its transcript-boundary sentence, the block opens
by naming itself guidance and closes by restating the boundary — the last word before the
transcript is the boundary's. The structural guarantee (the transcript is the final MESSAGE,
never part of the system text) is unchanged; the adapter's mid-message boundary sentence becomes
redundant rather than false. This is the one real wrinkle in the design and the reason the block
carries its own framing text.

### 3. Stripping is ribo's job — at the render site, paired with the emission

The caller cannot strip: it hands over a zod schema, and the schema→JSON rendering happens
inside the extractors (`singleShotExtractor`, `schemaRetryExtractor`, `prepareGroups`). Rebuilding
a zod schema without descriptions is not practical, and a JSON-side strip by the caller would
reimplement the trap below per app. So the render sites go through
`toJsonSchemaForWire(schema)` (`extraction/schema/wire-schema.ts`), which strips descriptions
from the draft-2020-12 rendering; `fieldDescriptions: "schema"` opts out of BOTH halves and
restores the historical bytes exactly.

**Emission and stripping are deliberately NOT separable knobs.** Both separable states are
strictly worse: emit-without-strip pays both budgets for one text and keeps the cap; and
strip-without-emit is the measured accuracy regression this whole change exists to undo. One
switch, both halves move together. On the scoped-instance path the switch is `prepareGroups`'
option, and each `PreparedGroup` records the mode its `jsonSchema` was rendered in; `fillPhase`
reads it from the group and takes no option of its own, so a caller composing the two by hand
cannot set them apart.

**The strip is a walk over known schema positions, never a key-name filter.** The naive strip —
recurse the rendered JSON and delete every key named `description` — also deletes a field
genuinely _named_ `description` (a key inside a `properties` map), leaves it behind in
`required`, and produces an invalid schema whose 400 is very hard to trace. The walk only
treats `description` as a keyword at schema positions: the root, the VALUES of
`properties`/`$defs`/`patternProperties` (never their keys), the arms of
`anyOf`/`oneOf`/`allOf`/`prefixItems`, and the single-schema positions. Data positions (`enum`,
`const`, `default`, `examples`) are never descended into, and `required` is never touched.
Pinned in `wire-schema.test.ts` against exactly the trap.

**Untouched on purpose:**

- **The split, the caps, `maxSerializedCharsPerGroup`** (non-goal). `splitExtractionSchema` and
  `serializedCharCount` keep packing against the FULL rendering — descriptions included — which
  is now a conservative upper bound of the wire size: a stripped wire schema only ever lands
  further under a byte cap than the split measured. The split's boundaries are pinned by
  regression gates that this change does not move.
- **`cachedExtractor`'s cache key** keeps the FULL serialization. Descriptions still affect
  behaviour (through the prompt now), so a description change SHOULD miss the cache; stripping
  at that site would have silently stale-keyed it.
- **The gap-fill follow-up and the roster** keep descriptions in their wire schemas. Their
  prompts do not emit guidance (the builders are not in their path), and the invariant this
  change implements is: _descriptions move off the schema exactly where the prompt carries
  them._ Both calls' schemas are small (a handful of leaves), never near the cap, and their
  guidance is not lost.
- **The enum-quote substitution** — independent; it lives at the transport in consumer apps.

## The measurement

Real adapter (`snuggExtractionSchema`, 441 described leaves across 20 groups, `"leaf"`
provenance), split with `maxSerializedCharsPerGroup: 32_768` and nothing else. That is the
configuration the consumer app runs, and it reproduces the app's reported figures exactly: 22
calls, worst piece 32,639 chars. Token figures are chars ÷ 4, an estimate, not a tokenizer count.

**Schema budget (the one that hard-fails at 32,768):**

|                                      | before        | after (wire)  |
| ------------------------------------ | ------------- | ------------- |
| whole schema, single-shot's one call | 290,335 chars | 149,249 chars |
| `basedata` group alone               | 94,727 chars  | 52,943 chars  |
| worst piece across the 22 calls      | 32,639 chars  | 20,300 chars  |
| sum across the 22 calls              | 293,280 chars | 152,194 chars |

Descriptions are ~48% of the per-call wire bytes. The worst piece goes from 129 chars of
headroom to 12,468, about 1.6× under the cap. The split still packs against the full rendering,
so the call count stays at 22: the strip buys headroom, not fewer calls.

The brief's `basedata` figures (40,636 with, 17,510 without) do not reproduce under either
provenance here (`"row"` gives 61,058 → 19,274), so their source is unknown; the 22-call and
32,639 figures do reproduce and are the ones this section is anchored to.

**Prompt budget (billed, not capped):** the guidance block totals 161,780 chars ≈ 40k tokens
across the 22 calls, ~1,840 tokens a call on average and ~5,000 on the largest (19,934 chars).
For the single-shot call it is ~154,579 chars ≈ 39k tokens.

**The honest cost statement:** a tier sends more bytes, not fewer. The schema side sheds
141,086 chars and the prompt side gains 161,780, a net ~20,700 chars (~5k tokens) per tier,
because the block's path/kind framing costs more than the JSON keys it replaces. What that buys
is budget shape: the capped budget gets room, and the text moves to the budget that only bills.
A caller one adapter away from a schema where descriptions and structure cannot both fit any
partition has a lever other than dropping the guidance.

## What makes this worse than it looks

- **The placement wrinkle** (§2): the block lands after the adapter's transcript-boundary
  sentence; core cannot insert before text it does not own. Mitigated in the block itself, at
  the cost of a duplicated boundary statement.
- **Prompt tokens are billed on every retry** — a transient-failure retry re-sends the guidance.
  Same was true of the schema, so nothing is newly at risk; the amounts moved, not the
  multiplicity.
- **The renderer's group header for a flat schema is a leaf.** For a schema whose top-level keys
  are envelopes (all-flat, `"leaf"` provenance), the inventory's top-level-segment grouping
  renders each leaf as a one-member "group" — accurate in content, generous in headers. The
  real adapters are grouped; a flat-schema adapter would want a tighter rendering first.
- **Nobody has measured accuracy with the guidance in the prompt.** The furnace case shows
  descriptions matter; it does not show they work as well in the system message as in the
  schema. That is why the mode is opt-in: flipping the default changes every consumer's prompts
  on evidence we do not have.
