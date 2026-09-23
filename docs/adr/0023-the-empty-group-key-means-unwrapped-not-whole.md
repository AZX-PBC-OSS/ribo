# 0023. The empty group key means unwrapped, not whole

Status: Accepted
Date: 2026-09-22

## Context

`""` is the group key `splitExtractionSchema` gives the non-grouped fallback: a schema that is
not an object of groups gets one entry covering the whole schema, keyed `""`. R3 introduced the
marker, per-group composition's design §4.7 considered a MIXED schema — groups beside loose
top-level leaves — and punted ("the preset keeps today's derived behaviour untouched"), and the
group map enforced the boundary: a map combining `""` with named keys threw at construction,
because "either the schema has groups or it does not".

ADR 0022 measured what that punt costs. The shape proposer's natural output is partial nesting —
pointed at a real 294-property vendor schema, the model proposed 14 `nest` groups covering 203
leaves and left 47 loose — and a partially nested schema **could not be split at all**: one loose
top-level key vetoed the grouping of every other key, the mixed schema collapsed to the flat
fallback, and the fallback treats each top-level key as atomic, so the oversized `pool` group
"cannot fit any piece" (`nest-live-run-evidence.md` §3). The same evidence file measured the
tempting half-fix (§5): wiring each key to the packer that fits it makes the split succeed and
then `groupedExtractor` refuses the result — and it breaks a mixed schema that works today, whose
small group packs atomically under `""`. The split change and the `""` contract change are one
change, not two.

The measured workaround — sweeping loose leaves into an invented group — leaks the invented key
into `groupInstructions(key)`, the few-shot projection, the review tree's group nodes and
`statedEmptyGroups` (§4 of the evidence file). It is the wrong answer, recorded so nobody
re-derives and ships it.

## Decision

**`""` means the unwrapped portion**: pieces whose schema is not nested under a group key, whose
parsed responses merge by shallow assign. For an all-flat schema that portion is the whole schema
— the fallback, unchanged. For a mixed schema it is only the loose leaves.

The splitter classifies top-level keys once: a group candidate that is a non-envelope object is a
group, everything else (a leaf envelope, an array of envelopes) is loose. A mixed schema splits
into one entry per group — the grouped path's three cap arms verbatim — plus the loose keys
collected into a strict object keyed `""`, appended after the groups. The loose portion packs
through the existing flat packer under a byte cap, and under the union cap alone too. The
asymmetry the flat fallback pins survives, narrowed to what it always meant: when the schema is
ALL-flat the module declines to split at all under the union cap alone and returns the input,
claiming nothing; in a mixed split the module is actively constructing pieces, so everything it
emits must satisfy the caps it was given. As first accepted, this ADR extended the all-flat rule
to the loose portion verbatim — which left the motivating shape emitting one 94-union loose piece
behind a caller's cap of 16, a provider 400 of exactly the kind ADR 0013 exists to convert into
a construction throw. ADR 0013's over-cap-leaf refusal and ADR 0015's byte-cap policy are
unchanged: a loose leaf that fits no piece throws at construction, naming the leaf, the measured
size, the caps and the option, and the byte cap remains the caller's to supply.

The refusal narrows to a **redundancy rule** with four states: named keys only, accepted as
today; unwrapped only, accepted as today; the unwrapped entry beside named keys that do not
cover the schema, accepted — the entry declares the unnamed remainder covered, the missing-keys
check is waived on that declaration, and a lying declaration surfaces at the second
trust-boundary parse, the same guarantee the fallback arm always stated; the unwrapped entry
beside named keys that DO cover every schema key, refused — the double declaration the original
guard existed to prevent.

**The writing surface spells the portion as an option, not a key.** `GroupedExtractorOptions`
becomes a base intersected with a three-arm union — exhaustive `groups` alone, `groups:
Partial<named>` beside a required `unwrapped`, or `unwrapped` alone — because "named keys, or
the unwrapped entry, or both" is the conditional required-ness one record cannot express, and
TypeScript checks union constituents independently. The named arm keeps its exhaustiveness
guard: a missing group beside no `unwrapped` entry is still a compile error. `PerGroupPlan`
gains parallel `unwrapped`/`unwrappedTarget` slots beside `groups`/`targets` in the same two
shapes. `groupedExtractor` folds the option onto the internal `""` key at entry, and everything
downstream — coverage, the flatten, the merge, the `namedKeySet` the merge-ownership guard
reads — works on the post-fold record, unchanged; a literal `""` inside `groups` is refused at
construction rather than silently dropping one of two declarations. The marker is thereby
internal, exported as `UNWRAPPED_KEY` so a reader of the event stream or the split's output
compares against a name.

No new marker. Every per-piece consumer of the split's output — the plan's by-key loop,
`prepareGroups`, the inventory and fill phases, the merge — already implements exactly the
handling loose leaves need, because the byte-cap flat path built it: flat assign merge, unwrapped
piece schema, wire name without the group infix, no roster, the full-target prompt. A second
marker would fork all of them into two paths that answer the same question, and unlike `""` it
could collide with a schema property name, which `""` cannot (the review leaf-path grammar
refuses empty property names). The READING surface keeps it: `ExtractionGroup.key`,
`GroupUnit.key`, `PhaseUnit`'s default key and `PreparedGroup.key` all still carry `""`.
`overrideGroups` gains no slot for the loose portion: the overrides object is keyed by the
schema's top-level keys and the unwrapped portion is not one, so its refusal message for a
mixed plan says so and points at passing `unwrapped` to `groupedExtractor` yourself, which is
the escape hatch the plan's exported pieces exist to be.

## Consequences

A caller reshaping a flat schema into groups no longer owes the split a sweep: nest what belongs
together and leave the rest loose, and the split, the plan, the preset and the scoped-instance
pipeline all do the right thing. The motivating live run's shape — 14 groups beside 47 loose
leaves — now splits and packs within the caps the caller supplies: the group pieces as before,
and the loose portion partitioned under the union cap alone or under both caps when a byte cap
is supplied. That claim is deliberately conditional, and the condition is ADR 0015's: the
library carries no provider's byte ceiling, so a route bound by one is protected only when the
caller supplies it — but no emitted piece exceeds a cap it was given. The narrowed refusal is a
**strict widening**: every composition accepted
before is accepted with identical behaviour, and the only compositions whose behaviour changed
are the ones that threw. (The later re-spelling — the `unwrapped` option in place of the `""`
map key — is behaviour-preserving in the same sense: the fold makes the accepted set and the
merge semantics identical, and only the spelling moved.)

The cost, stated plainly. A construction-time guard got narrower: a hand composer who declared
the unwrapped portion beside named keys by mistake used to get a throw, and now only the
redundant full-coverage case throws. An unwrapped entry whose runtime fields carry a NAMED
group's key escapes both the remaining refusal and the shape-valid closing parse — the value is
shape-valid, just wrong — and the unwrapped entries assign last, so it would silently win the
merge. As first accepted, this ADR
framed that as a residual risk to be accepted, "the alternative was the blanket refusal" — a
false dichotomy. The implemented answer is a third option that keeps the widening and kills the
silent overwrite: the merge's unwrapped arm throws when the entry's fields carry a key a named
entry covers, naming the key and the rule (the unwrapped entry covers only the unwrapped
remainder). No
false positives are possible under the contract — the extra-keys check confines the named set to
schema keys, and keys outside the schema remain the closing parse's — so the guard is exactly
the missing class. The same guard covers `statedEmptyGroups`, which previously unioned in pool
arrival order and so could clobber a named entry's statement nondeterministically; the union now
happens in the merge loop, in schedule order, under the same named-key check. The preset — the
composer that matters — never produces the hazardous composition in the first place, because the
split's loose piece is built from exactly the keys no group claimed and its `z.strictObject`
rejects a named key at the entry's own first parse; the guard is what a HAND composer gets, where
the old blanket refusal used to catch the misuse.

The unwrapped-only and named-only arms are byte-for-byte behaviour-pinned by the existing suites
(request shapes, partition boundaries, the flat fallback's input-identity single entry), so the
widening cannot drift the paths that ran before. The few-shot asymmetry the byte-cap flat path
already carried — an unpartitioned loose piece keeps the full examples, a partitioned one narrows
— now extends to mixed schemas unchanged; aligning the fill phase's un-narrowed examples is a
separate, optional follow-up recorded in the design's open questions, not here.
