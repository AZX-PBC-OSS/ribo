# 0023. The empty group key means unwrapped, not whole

Status: Accepted
Date: 2026-09-22

## Context

`""` is the group key `splitExtractionSchema` gives the non-grouped fallback: a schema that is
not an object of groups gets one entry covering the whole schema, keyed `""`. R3 introduced the
marker, per-group composition's design §4.7 considered a MIXED schema — groups beside loose
top-level leaves — and punted ("the preset keeps today's derived behaviour untouched"), and
`GroupMap` enforced the boundary: a map combining `""` with named keys threw at construction,
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
collected into a strict object keyed `""`, appended after the groups. Under a byte cap the loose
portion packs through the existing flat packer; the union cap alone does not partition it, the
same asymmetry the flat fallback pins. ADR 0013's over-cap-leaf refusal and ADR 0015's byte-cap
policy are unchanged: a loose leaf that fits no piece throws at construction, naming the leaf,
the measured size, the caps and the option.

The refusal narrows to a **redundancy rule** with four states: named keys only, accepted as
today; `""` only, accepted as today; `""` beside named keys that do not cover the schema,
accepted — the `""` entry declares the unnamed remainder covered, the missing-keys check is
waived on that declaration, and a lying declaration surfaces at the second trust-boundary parse,
the same guarantee the fallback arm always stated; `""` beside named keys that DO cover every
schema key, refused — the double declaration the original guard existed to prevent.
`GroupMap` and `GroupTargets` gain a third arm for the mixed shape (`Partial<named> & { "" }`),
keeping the named arm's exhaustiveness guard: a missing group beside no `""` entry is still a
compile error.

No new marker. Every per-piece consumer of the split's output — the plan's by-key loop,
`prepareGroups`, the inventory and fill phases, the merge — already implements exactly the
handling loose leaves need, because the byte-cap flat path built it: flat assign merge, unwrapped
piece schema, wire name without the group infix, no roster, the full-target prompt. A second
marker would fork all of them into two paths that answer the same question, and unlike `""` it
could collide with a schema property name, which `""` cannot (the review leaf-path grammar
refuses empty property names). `overrideGroups` gains no slot for the loose portion: the
overrides object is keyed by the schema's top-level keys and `""` is not one, so its refusal
message for a mixed plan names the `""` entry and points at hand composition, which is the
escape hatch the plan's exported pieces exist to be.

## Consequences

A caller reshaping a flat schema into groups no longer owes the split a sweep: nest what belongs
together and leave the rest loose, and the split, the plan, the preset and the scoped-instance
pipeline all do the right thing — the shape the motivating live run produced is now the shape
the pipeline handles best. The narrowed refusal is a **strict widening**: every map accepted
before is accepted with identical behaviour, and the only maps whose behaviour changed are the
ones that threw.

The cost, stated plainly. A construction-time guard got narrower: a hand composer who combined
`""` with named keys by mistake used to get a throw, and now only the redundant full-coverage
case throws. Worse, a `""` entry whose runtime fields carry a NAMED group's key escapes both the
remaining refusal and the shape-valid closing parse, and silently wins the merge — the `""`
entries assign last. That residual risk is accepted and documented at `GroupMap`; the
alternative was the blanket refusal this ADR exists to reverse, and the preset — the composer
that matters — never produces it, because the split's loose piece is built from exactly the keys
no group claimed.

The `""`-only and named-only arms are byte-for-byte behaviour-pinned by the existing suites
(request shapes, partition boundaries, the flat fallback's input-identity single entry), so the
widening cannot drift the paths that ran before. The few-shot asymmetry the byte-cap flat path
already carried — an unpartitioned loose piece keeps the full examples, a partitioned one narrows
— now extends to mixed schemas unchanged; aligning the fill phase's un-narrowed examples is a
separate, optional follow-up recorded in the design's open questions, not here.
