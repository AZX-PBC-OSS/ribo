# Splitting a mixed schema: one entry per group, plus the loose leaves

**Date:** 2026-09-22
**Status:** Draft — for review. No implementation plan written yet.
**Question answered:** `splitExtractionSchema` groups only when every top-level key is a group; a
schema that is 14 groups plus a few loose leaves collapses to the flat fallback. How does the
split — and every consumer of its `""` marker — handle groups and loose leaves in one schema?
**Depends on:** R3 (`r3-per-group-extraction-design.md`), per-group composition
(`per-group-composition-design.md`, especially §4.7), the byte cap (`split-schema.ts`,
ADR 0015), the over-cap-leaf refusal (ADR 0013).

---

## 1. The problem

`splitExtractionSchema` (`packages/ribo-extractor-openai/src/schema/split-schema.ts:636`) takes
the grouped path only when **every** top-level key is a group — the `everyKeyIsGroup` test at
`split-schema.ts:656-659`, where a group is a `ZodObject` (or an array of one) that is not itself
a leaf envelope (`isGroupObject`, `split-schema.ts:591-592`). One loose top-level leaf anywhere
and the whole schema falls to the non-grouped fallback: a single entry with `key === ""` whose
schema is the whole input (`split-schema.ts:675-677`), or — with a byte cap supplied — several
flat pieces sharing `key === ""` that partition over the top-level keys via
`partitionFlatTwoCaps` (`split-schema.ts:681`, `508-572`), where a whole group is one opaque
property among the leaves.

So a caller who reshapes a flat schema into 14 groups and leaves a few leaves loose gets none of
the grouping: every group rides inside one oversized or description-stripped call, which is
exactly the failure per-group extraction exists to remove (R3 §2's 39,741-byte request against a
32,768 cap). The workaround available to a consuming app today is a **sweep** at the patch-schema
level: move every loose leaf into an invented group before `enveloped()` runs. That group means
nothing semantically, and the leak is real — the invented key appears in the enveloped schema's
top-level keys, so it reaches `groupInstructions(key)` (a host's per-group function is called with
it), the few-shot projection, the review tree's group nodes, and `statedEmptyGroups` if the
inventory ever mentions it. The honest end state is for the splitter to handle a mixed schema: one
entry per group, plus the loose leaves carried as their own piece or pieces.

## 2. The `""` contract, and where it came from

`""` is a cross-package contract, not a local detail of the splitter. It originates in R3 §4:
"Deriving the group list from those keys keeps this generic across adapters... An adapter whose
schema is not an object of groups gets one call, which is today's behaviour"
(`docs/roadmap/design/r3-per-group-extraction-design.md:72-76`). Per-group composition §4.7 then
considered exactly this problem and punted: "The preset keeps today's derived behaviour untouched"
(`per-group-composition-design.md:323-328`). No numbered ADR states the contract — ADR 0014
mentions the `""` fallback only in passing (`docs/adr/0014:9`), and ADRs 0013 and 0015 govern the
over-cap-leaf refusal and the byte cap respectively, both of which this design must respect
unchanged. The refusal that blocks mixed maps is stated in `GroupMap`'s own doc block
(`packages/ribo-core/src/extraction/grouped-extractor.ts:74-88`) and enforced at
`grouped-extractor.ts:244-255`; the guide repeats it
(`docs/guide/per-group.md:156`: "The fallback cannot be combined with per-key entries").

### 2.1 One caution about the same string elsewhere

`packages/ribo-core/src/provenance/field-path.ts:285-292` refuses an empty **field or instance
key** — that `""` belongs to the review leaf-path vocabulary (R1.5), where paths are built from
schema property names. A schema property named `""` is and remains illegal; the split's `""`
marker is a group-key slot, never a schema key, and never becomes a review path. Nothing in this
design touches `field-path.ts`. Likewise the phase vocabulary's `describeItem` default of
`key: ""` (`packages/ribo-core/src/phases/phase.ts:148-152`, applied at
`phased-extractor.ts:295`) is the _same convention_ — "no meaningful group key" — not a separate
contract, and this design extends it rather than changing it.

## 3. Consumer inventory

Every site in `packages/*/src` that special-cases `""` or consumes the split's shape, what it does
today, and what a mixed schema does to it. This table is the doc's centre of gravity — do not
trust the summary lists elsewhere; each row was read at the cited lines.

| #   | Site                                                 | What it does with `""` today                                                | Effect of mixed schemas                                                                              |
| --- | ---------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 1   | `split-schema.ts:661-681` — the fallback branch      | Whole schema as one `""` entry; byte cap partitions it flat                 | The branch being changed: groups and loose leaves split separately                                   |
| 2   | `split-schema.ts:562-571` — flat pieces              | Pieces share `""`, carry `part`/`parts`; single piece keeps input identity  | Reused unchanged for the loose-leaf portion                                                          |
| 3   | `grouped-extractor.ts:244-255` — the refusal         | A map combining `""` with named keys throws ("a contradiction")             | **Must change** — the refusal narrows (§5.2)                                                         |
| 4   | `grouped-extractor.ts:271-289` — coverage            | `""` arm skips coverage; named keys must cover the schema exactly           | **Must change** — a `""` entry declares the unnamed remainder covered (§5.2)                         |
| 5   | `grouped-extractor.ts:302-315` — schedule            | `""` map flattens to whole-schema entries; named path ignores `""`          | `""` pieces join the schedule beside named entries                                                   |
| 6   | `grouped-extractor.ts:518-524` — merge               | `entry.key === ""` assigns fields flat into the merged record               | Unchanged — loose leaves and group keys are disjoint by construction (§6)                            |
| 7   | `GroupMap`, `grouped-extractor.ts:89-94`             | Discriminated union: all named keys, or `""` only                           | **Type change** — `""` becomes optional beside named keys (§5.1)                                     |
| 8   | `per-group.ts:363-369` — plan early return           | Single `""` piece means the flat fallback: one entry over the whole target  | Unchanged, and never fires for mixed (mixed always yields ≥ 2 pieces)                                |
| 9   | `per-group.ts:374-378, 425-463` — byKey loop         | `""` pieces get a name without the group infix and a directly built target  | Unchanged — mixed pieces flow the existing `""` branch beside named ones                             |
| 10  | `GroupTargets`, `per-group.ts:242-257`               | `""` arm mirrors `GroupMap`'s                                               | **Type change** — same widening as #7                                                                |
| 11  | `partitionedLeafKeys`, `per-group.ts:220-228`        | `""` reads the piece schema's own top-level keys                            | Unchanged — correct for loose pieces                                                                 |
| 12  | `overrideGroups`, `per-group.ts:559-572`             | An override against a `""`-only plan throws ("not an object of groups")     | Message must stop claiming that for a mixed plan (§7, open question 4)                               |
| 13  | `prepareGroups`, `instance-fill.ts:337-348, 361-376` | `key !== ""` guards the array unwrap; names and contexts omit the infix     | Unchanged — `""` pieces beside named pieces already work                                             |
| 14  | `fillPhase.plan`, `fill-phase.ts:201-231`            | `""` pieces take the singleton branch; `buildMessages` (full target prompt) | Unchanged — a loose piece is "one fill per piece, no scope semantics"                                |
| 15  | `fillPhase.merge`, `fill-phase.ts:329-360`           | `""` reads the parsed response itself; assigns flat                         | Unchanged                                                                                            |
| 16  | `inventoryPhase`, `inventory-phase.ts:146-150`       | `""` pieces skip roster interpretation                                      | Unchanged — loose leaves are not collections, and `statedEmptyGroups` stays keyed by real group keys |
| 17  | `buildGroupMessages`, `extraction-common.ts:216-219` | `groupKey === ""` falls back to the full target's messages                  | Unchanged — `groupInstructions` is never invoked with `""`                                           |
| 18  | `mergeGroupPieces`, `merge-group-pieces.ts:27-43`    | Recombines pieces of one key                                                | Unchanged — loose pieces merge by assign, never here (§6)                                            |

Rows 8, 9, 11–17 are the reason this design is cheap: the per-piece consumers were built for the
byte-cap flat path and already handle a `""` piece _as one entry among several_. Only the
map-level consumers (rows 3, 4, 7, 10) treat `""` as "the whole map or nothing", and those are the
only changes.

## 4. Decision: reuse `""`, with the refusal narrowed

**The loose-leaf portion is carried as one or more entries with `key === ""` — the existing
flat-fallback marker — alongside the named group entries.** A new marker was weighed and rejected:
every per-piece consumer in rows 8–17 already implements exactly the handling loose leaves need
(flat assign merge, unwrapped piece schema, name without infix, no roster, full-target prompt), so
a second marker forks all of them into two paths that answer the same question. A marker distinct
from `""` also collides with the possibility of a schema property sharing its name, while `""` is
already excluded from property names by `field-path.ts:285-292` — the marker is safe by
construction.

What changes is the marker's _meaning_, and saying so precisely is the design: **`""` means "the
unwrapped portion" — pieces whose schema is not nested under a group key, whose parsed responses
merge by shallow assign.** For an all-flat schema that unwrapped portion is the whole schema
(today's fallback, unchanged); for a mixed schema it is only the loose leaves. The doc-block
rewrite in `GroupMap` (`grouped-extractor.ts:74-88`) is part of the change.

### 4.1 Type changes

`GroupMap` (`grouped-extractor.ts:89-94`) is a union of "named keys, exhaustive" and "`""` only".
It becomes a single shape: named keys as today, plus an **optional** `""` member. The `""`
member's entry type keeps today's `Extractor | readonly Extractor[]` (the whole-shape claim) — a
loose piece's runtime fields carry only its subset, the same over-claim the plan's flat pieces
already make and that `per-group.ts:441-446` names explicitly: the cast names the runtime shape,
and the second trust-boundary parse validates the merge. A stricter complement-typed entry was
considered and deferred — see open question 2. `GroupTargets` (`per-group.ts:242-257`) widens
identically, and its `""` doc block ("a flat schema whose top-level properties are leaf envelopes
yields one entry") gains the mixed case. `ExtractionGroup` itself (`split-schema.ts:122-143`)
needs no change: `key: string` already carries both arms, and `part`/`parts` already distinguish
pieces.

### 4.2 The refusal narrows to a redundancy rule

Today's refusal throws whenever `""` and named keys coexist, on the reasoning that "either the
schema has groups or it does not" (`grouped-extractor.ts:248-253`). That reasoning survives in
one narrower place: a map whose named keys already cover **every** top-level schema key, plus a
`""` entry, is still contradictory — the `""` entry would claim coverage the named entries already
declare, and today's guard was protecting exactly against that double declaration. The rule
becomes:

- named keys only — today's grouped path, unchanged;
- `""` only — today's fallback, unchanged;
- `""` plus named keys that **do not** cover the schema — accepted; the `""` entry owns the
  unnamed remainder;
- `""` plus named keys that **do** cover the schema — refused, with today's message adapted.

The coverage checks follow: with a `""` entry present, the missing-keys check
(`grouped-extractor.ts:271-279`) applies only to keys not named in the map — the `""` entry is
their coverage declaration, and a lying declaration surfaces at the closing parse, the same
guarantee the fallback arm states today (`grouped-extractor.ts:79-81`). The extra-keys check
(`grouped-extractor.ts:280-289`) is unchanged. This is a strict widening: every map accepted
today is accepted tomorrow with identical behaviour, and the only maps whose behaviour changes are
the ones that threw.

## 5. The split of a mixed schema

### 5.1 Which keys are loose

The loose set is defined **operationally, as the complement of the group keys**: a top-level key
is a group when `groupCandidate` yields an object that passes `isGroupObject`
(`split-schema.ts:656-659`), and loose otherwise. No new classification is invented — a key whose
value is a leaf envelope is loose (today's flat case), and so is a key whose value is an
array of envelopes, which today drags the whole schema into the fallback and tomorrow rides the
loose set through the same flat machinery. The split does not invent structure the schema does not
carry; it merely stops letting one loose key veto the other keys' grouping.

### 5.2 Partitioning under both caps

**No caps.** One entry per group, exactly today's grouped path (`split-schema.ts:699-704`), plus
one trailing loose piece: a `z.strictObject` carrying all loose leaves, keyed `""`, no
`part`/`parts` — the flat fallback's shape for an under-cap schema, narrowed to the loose subset
rather than the whole input.

**Union cap only.** Groups partition through `partitionGroup` unchanged
(`split-schema.ts:706-713`). The loose portion stays one piece — **the union cap does not
partition flat material**, which is today's pinned rule
(`split-schema-unions.test.ts:96-103`, `split-schema.ts:675-677`). Keeping it here preserves the
documented asymmetry ("the union cap partitions within groups; the byte cap partitions anything",
`split-schema.ts:619-628`) instead of inventing a third rule for the loose portion.

**Byte cap (with or without the union cap).** Groups pack through `partitionGroupTwoCaps`
unchanged. The loose leaves pack through the existing `partitionFlatTwoCaps` machinery over the
loose keys — greedily, in declaration order, pieces sharing `""` with `part`/`parts`, the
single-overweight-leaf refusal of ADR 0013 naming the loose leaf and both caps
(`split-schema.ts:531-545`; the error already says "schema has a property", which reads correctly
for a loose leaf). Mechanically the helper walks a schema's top-level keys, so the mixed path
hands it a strict object rebuilt from the loose keys alone; the pieces it emits are already in
the right shape — unwrapped leaf subsets, no wrapping key — so no relabelling step is needed.

**Ordering.** Entries come out in schema declaration order for the groups, with the loose
piece(s) last. The alternative — interleaving loose pieces where their keys appear — was rejected:
it complicates the packer for no observable benefit, since the merge is keyed and the schedule
order only determines which `GroupUnit` events arrive first. `perGroupPlan`'s key-grouping
preserves this order (`per-group.ts:374-378` inserts into a `Map` in iteration order), so the
`""` entries land at the end of the schedule, mirroring today's fallback-last intuition.

### 5.3 The merge still holds

Today's flat pieces merge by shallow assign because their leaf sets are disjoint
(`split-schema.ts:620-627`). Next to groups, disjointness still holds, and on two independent
axes: within the loose portion, pieces partition distinct top-level keys, so no loose piece
overlaps another; across portions, a loose leaf **is** a top-level key of the schema while a
group's contribution lives one level down under its group key, so a loose assign can never
clobber a group value or vice versa — a schema property is one or the other by the classification
in §5.1. Both merge arms already exist side by side in `grouped-extractor.ts:514-528` (assign for
`""`, keyed insert-or-`mergeGroupPieces` for named) and `fill-phase.ts:329-364`; neither changes.
`mergeGroupPieces` (`merge-group-pieces.ts:27-43`) is untouched — loose pieces never reach it,
because they never share a key with anything. The second trust-boundary parse against the full
`extractionSchema` then validates the merged whole, including that every group key a named entry
was responsible for actually arrived.

## 6. Prompts

**Per-group instructions.** Unchanged for named groups: `groupInstructions(key)` is called only
for named keys, and `groupInstructions` is **never** invoked with `""` — the contract
`buildGroupMessages` states today (`extraction-common.ts:186-189`) and the plan's flat branch
already obeys (`per-group.ts:448-463` builds the flat piece's target with
`target.instructions`). A loose-leaf call carries the target's full instructions; no
group-specific text exists for leaves that belong to no group, and inventing one would recreate
the sweep's semantics leak this design removes.

**Few-shot examples.** An unpartitioned loose piece keeps the target's full, unprojected examples
— byte-identical to today's fallback request, which the regression gates pin
(`split-schema-bytes.test.ts:205-227`). A partitioned loose piece narrows its examples to the
piece's leaf subset through the existing `partitionedLeafKeys` → `narrowToLeaves` path
(`per-group.ts:449-457`, `extraction-common.ts:160-173`) — which already handles flat top-level
narrowing, because that is the byte-cap flat path's behaviour.

**Inventory and scoped-instance pass.** The roster pass is house-wide and stays so. Loose pieces
are skipped by the inventory phase's roster interpretation
(`inventory-phase.ts:150`) — they are not collections, cannot be stated empty, and
`statedEmptyGroups` therefore never gains a `""` key. In the fill phase a loose piece takes the
singleton/fallback branch: one fill per piece, no scope semantics, messages from
`buildMessages` with the target's own instructions and unprojected examples
(`fill-phase.ts:202-231` — the pinned two-message-path rule, Wave 5 plan §104). One observed
wrinkle, recorded and deliberately not fixed here: a _partitioned_ loose piece in the fill phase
gets the full unprojected examples, while the per-group preset narrows a partitioned flat piece's
examples. That asymmetry is today's pinned behaviour for the flat fallback
(`fill-phase.ts:212-213` calls `buildMessages` without `leafKeys`), it is prompt-inefficient
rather than unsound, and aligning it is a separate, optional follow-up (open question 5).

**Wire names and events.** Names derive mechanically from the key: a loose piece is
`${target.name}` or `${target.name}-<part>` per group (`per-group.ts:425-430`) and
`${target.name}-fill${partSuffix}` in `prepareGroups` (`instance-fill.ts:361-364`) — both already
omit the infix for `""`. `GroupUnit` events carry `key: ""` for loose pieces beside named keys —
which observability consumers already tolerate, the flat fallback having always emitted `""`
(`per-group.test.ts:847`, `:1986`; `extraction-observability-plan.md:271` pins the semantics as
honest).

## 7. Blast radius

| File                                                               | Change                                                                                                                                |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/ribo-core/src/extraction/grouped-extractor.ts`           | `GroupMap` type widened; refusal narrowed to the redundancy rule; missing-keys check waived beside a `""` entry; doc blocks rewritten |
| `packages/ribo-core/src/extraction/grouped-extractor.test.ts`      | The mixed-map refusal test inverts (acceptance pins); redundancy-case pins added                                                      |
| `packages/ribo-extractor-openai/src/schema/split-schema.ts`        | The mixed branch: group path plus loose-leaf collection and packing; file header                                                      |
| `packages/ribo-extractor-openai/src/schema/split-schema*.test.ts`  | New pins: mixed split, all-group and all-flat unchanged                                                                               |
| `packages/ribo-extractor-openai/src/strategies/per-group.ts`       | `GroupTargets` widened; `overrideGroups`'s not-an-object-of-groups message corrected for mixed plans; header                          |
| `packages/ribo-extractor-openai/src/strategies/per-group*.test.ts` | New pins: mixed plan yields `""` entries beside named ones; requests unchanged                                                        |
| `packages/ribo-extractor-openai/src/scoped-instance/*`             | **Expected zero runtime change** — verify with tests that mixed inputs flow the existing `""` branches (rows 13–16)                   |
| `docs/guide/per-group.md`                                          | §"Two edges of the map" (`:150-156`): the cannot-be-combined sentence becomes the redundancy rule                                     |
| `docs/guide/schema-at-scale.md`                                    | Check for fallback prose; update if it repeats the either-or claim                                                                    |

**Changesets.** `@azx/ribo-core` (minor — `GroupMap` widening plus behaviour in a previously
throwing path) and `@azx/ribo-extractor-openai` (minor — the split and the plan). No other package
imports either surface: `ribo-extractor-ondevice` uses neither `groupedExtractor` nor
`splitExtractionSchema` (verified by search), the Snugg Pro adapter consumes the split only in its
own tests against an all-group schema, and the playground runs `perGroupExtractor` over the
all-group Snugg target (`playground/src/extractor-store.ts:204`).

**Breaking? No.** A caller who only ever passed an all-group schema takes the identical grouped
path — `everyKeyIsGroup` still short-circuits nothing, and every branch below it is untouched. A
caller who only ever passed an all-flat schema takes the identical fallback — the mixed branch is
unreachable without at least one group key. A hand composer who passed `""`-only or named-only
maps gets today's behaviour for both. The two behaviour changes — the narrowed refusal and the
coverage waiver — apply only to maps that threw before, so nothing that ran changes outcome; the
worst a caller feels is that a construction error they may have relied on to catch a mistake now
runs. That loss is real and is the point of §4.2's narrowed rule: the redundancy case — `""` plus
full named coverage — still throws, which preserves the original guard's substance (no double
declaration) while conceding its over-reach (any combination). The residual risk that a hand
composer's `""` entry emits named group keys it should not, escaping both the refusal and the
shape-valid closing parse, is accepted and documented at `GroupMap`; the alternative — keeping the
blanket refusal — is the status quo this design exists to reverse.

## 8. Migration order

Each step leaves the tree green:

1. **Core first.** Widen `GroupMap`, narrow the refusal, waive the missing-keys check beside a
   `""` entry. Green because no producer can emit a mixed map yet — the splitter is unchanged,
   and hand composers gain a previously impossible (throwing) shape.
2. **The splitter's mixed branch.** Now `perGroupPlan` and `prepareGroups` can receive mixed
   piece lists; step 1 is what makes the preset's map acceptable to `groupedExtractor`. The
   per-piece consumers need no change (§3, rows 8–17), and the split's own pins are added here.
3. **`GroupTargets` and `overrideGroups`'s messages, plus the per-group pins** — type-level and
   message-only, so they can ride with step 2 or follow it.
4. **Verify-only pass over `scoped-instance`** — tests feeding mixed splits to `prepareGroups`,
   `fillPhase` and `inventoryPhase`, asserting zero behavioural drift in their `""` branches.
5. **Guides and changesets.**

Steps 1 and 2 must not be merged in the other order: a mixed map produced before the refusal was
narrowed would turn a silent whole-schema collapse into a construction throw.

## 9. ADR

**Yes — one is warranted.** The `""` contract is documented cross-package behaviour, stated in
`GroupMap`'s doc block, the guide, and the R3 and per-group-composition designs, and this design
reverses part of it (the blanket refusal) and widens the rest (the marker's meaning from
"whole-schema fallback" to "unwrapped portion"). No existing ADR states the contract, so nothing
is formally _reversed_ — but §4.7 of `per-group-composition-design.md` explicitly considered the
mixed case and recorded "the preset keeps today's derived behaviour untouched", which is the
decision being revisited. The ADR would decide: the `""` marker means _unwrapped_, not _whole_;
the contradiction rule narrows to redundant full coverage; and mixed schemas are groups plus a
loose remainder rather than a sweep into an invented group. Title in the house style: "The empty
group key means unwrapped, not whole." This document does not write it.

## 10. Must-fail tests

- A mixed schema (14 groups plus loose leaves) splits into one entry per group plus loose pieces
  keyed `""`, every piece under the supplied caps.
- An all-group schema splits exactly as today — same keys, same partition boundaries, same
  `part`/`parts` — with and without each cap.
- An all-flat schema splits exactly as today — single whole-schema entry with input identity
  under no byte cap, `""`-sharing pieces under one — with and without each cap.
- A mixed schema's split-then-merge result equals the sweep workaround's result minus the
  invented group: same leaf envelopes under the same paths, no invented key anywhere.
- `groupedExtractor` accepts a map combining `""` with named keys and returns the merged whole.
- `groupedExtractor` still refuses a map whose `""` entry sits beside named keys that already
  cover every schema key.
- `perGroupExtractor` over a mixed schema issues one request per group piece plus the loose
  pieces, the loose pieces' requests carrying `target.instructions` and full (or leaf-narrowed
  when partitioned) examples.
- The scoped-instance preset over a mixed schema skips loose pieces in the roster pass and fills
  them one call per piece through `buildMessages`, with the merged result parsing clean.
- A loose leaf that fits no piece throws ADR 0013's refusal, naming the leaf, the measured size,
  the caps and the option.

## 11. Open questions

1. **Does the union cap partition the loose portion when no byte cap is supplied?**
   _Recommendation: no_ — keep the pinned flat rule (`split-schema-unions.test.ts:96-103`) so the
   documented asymmetry survives verbatim; a caller who wants loose leaves partitioned by unions
   supplies a byte cap and gets both.
2. **How precisely to type the mixed arm's `""` entry.** Keeping today's whole-shape entry type
   (per-group.ts:441-446's cast-and-parse discipline) is cheap and honest enough; a complement
   shape (`the loose keys' subset of Enveloped<V, P>`) is expressible only with a new type alias
   over `Omit` and buys compile-time catching of an over-claiming loose entry — whose runtime
   failure mode is already caught by the closing parse. _Recommendation: keep today's type; revisit
   only if a host hand-composes loose entries and gets it wrong._
3. **Entry ordering.** Groups in schema declaration order with the loose remainder last (§5.2).
   _Recommendation: yes_ — the alternative buys nothing observable; pin the order in the splitter's
   tests so the schedule and event order stay deterministic.
4. **Should `overrideGroups` accept an override for the loose portion?** The overrides object is
   keyed by `V`'s keys, and `""` is not one; today a host who wants custom loose handling composes
   the map by hand. _Recommendation: no slot initially_ — mixed loose handling has no measured
   consumer, hand composition is the escape hatch the plan's exported pieces exist for, and the
   corrected message in row 12 points there.
5. **The partitioned-flat example asymmetry between the preset and the fill phase** (§6).
   _Recommendation: leave pinned, note it in the guide, and align it only if a mixed corpus shows
   the un-narrowed examples hurting — it is prompt cost, not soundness._
