# 0022. The shape vocabulary gains `nest`, an operation that creates the group

Status: Accepted
Date: 2026-09-22

## Context

The shape-operation set (`drop`, `retype`, `regroup`) is what a caller or a model uses to turn a
plain zod schema into a workable extraction target. Spike 0009 pointed the proposer at a real
vendor API POST body: Snugg Pro's `definitions.basedata`, **294 flat top-level properties**, no
nesting at all. The model proposed **19 `regroup`s** — `thermostat`, `lighting`, `pool`,
`basement`, `crawlspace`, `hvac`, `ventilation`, `waterHeater`, `electrical`, `airSealing` and
more — and **18 were refused by the applier**, because `regroup` re-nests leaves inside an
EXISTING top-level group and a flat schema has none. The spike's own words: the structural
intuition was right and the vocabulary could not express it. It asked for this operation by name
and asked that its ADR cite the spike as the evidence; this is that ADR.

One alternative already shipped. PR #86 taught `splitExtractionSchema` to partition a flat schema
over its top-level keys under a byte cap. That solves SIZE — fitting a request through a route —
and it is orthogonal to what was refused in the spike: the partitioned pieces are arbitrary spans
of a 294-leaf prompt, so the model is still asked about unrelated fields in one call with no
semantic scaffolding. The byte-cap fallback stays; it answers a different question.

## Decision

Add a fourth shape operation, **`nest`**, carrying a `group` (the name of a NEW top-level key it
creates) and `moves` (top-level patch leaf key → path relative to the new group) — deliberately
the same `group` + `moves` pair `regroup` carries, so there is one thing to learn, not two.

A nest source is restricted to a **top-level LEAF** — never a group, never a collection, never a
nested leaf. That restriction is what makes the top-level-boundary crossing legal: provenance is
keyed by top-level key, and a top-level leaf is the one thing with no group and no span to strand
(`validateProvenance` refuses `"row"` on a top-level leaf outright — a leaf has no object to hang
the row's sourceSpan on). Nesting a whole GROUP would strand exactly that span; it is a different
operation with a real provenance problem behind it, and it is not built. The mapping's
construction check relaxes for precisely this case: single-segment source, and both top-level
keys `"leaf"`-granular. Those two carry the safety.

A third conjunct — that the extraction top be absent from the patch schema, making the group
provably synthetic — was drafted and then **retired on evidence**. Pointed at the flat vendor
schema, the model named each group after the leaf that anchors it: `pool`, holding `pool`,
`poolSize`, `poolPumpType`. That was the only one of fourteen proposed nests the applier
refused, and it is the natural naming, not an error. So a nest group may take a top-level name
that some nest move frees — the rule `regroup` already follows for its destinations — and the
applier detaches every nest source before it creates any nest group, so the set stays a set and
no iteration order is observable. A name that SURVIVES to the extraction schema is still
refused; that would be two things at one path.

The derived patch is byte-identical after a nest. Provenance may not be declared on a nest group —
`mapping.provenance` is applied to BOTH schemas and the group exists in only one — nor on a leaf a
nest moved away; the derivation refuses both, at construction, where the author is present.

## Consequences

What `nest` buys is extraction-side, and only extraction-side. A nest group becomes its own
`splitExtractionSchema` entry, with its own call and its own prompt assembly.

> **Rewritten in place, 2026-09-22.** This section originally recorded a hard limit: the split's
> `everyKeyIsGroup` gate meant one unmoved top-level leaf collapsed the whole schema to the flat
> fallback, so a **partially** nested schema — 19 proposed groups over 294 leaves, the shape the
> proposer actually emits — bought no per-group payoff and, when a nest group exceeded a cap,
> **could not be split at all**. That was measured, and it was true when written.
>
> **ADR 0023 lifted it**, before either decision shipped in a released version — which is why this
> is a rewrite rather than a supersession note (`docs/adr/index.md`'s stated exception). A mixed
> schema now splits: each group through the group packer, the loose leaves as the unwrapped
> portion under `""`. The test that pinned the limitation was inverted to pin the lifting.
>
> The reasoning is kept because it is still load-bearing for one claim below — the limitation was
> never a defect `nest` introduced. A hand-written schema with an oversized group beside a loose
> top-level leaf failed identically, with no nest anywhere near it; the gate was the flat
> fallback's and predated this operation. What `nest` did was make the shape easy to reach,
> because a partially nested schema is the proposer's natural output. That is what made the split
> the immediate next piece of work rather than an optional follow-on, and ADR 0023 is the record
> of doing it.

What it does not buy, stated plainly so this record cannot be read as overselling: review still
renders the moved leaves FLAT (`buildReviewRequest` walks the patch schema, which a nest leaves
untouched — there is no attic card); `requiredOnCreate` and `identifyingFields` cannot be declared
on a nest group (declarations resolve against the patch tree, where the group does not exist);
and provenance cannot be declared on one either — a nest group is `"leaf"`-granular forever. If
patch-side declarations on nest groups are ever wanted, that is separate, named work.

The cost: the operation set is four, not three, and the mapping's top-key invariant is now
conditional. Without the relaxing conjuncts a hand-written mapping could express a cross-top pair
that reverses wrongly — an envelope written where a plain value is wanted, which fails as a
RETRYABLE `SchemaParseError` at every extract, burning a ladder's whole budget on something that
can never succeed. Both conjuncts are pinned by their own tests, and `reverseShapedFields` roots
every patch-side write at the source's top-level key.

**Measured, on a live route, against the schema that motivated this.** The model proposed 14
nests covering 203 leaves — `thermostat`, `clothesWasher`, `pool`, `ventilation`, `lighting`,
`basement`, `crawlspace`, `hvac` and more — reaching for `nest` unprompted, from the library
directive alone. Thirteen applied as proposed; the fourteenth was the anchor-naming case above.
Applied together they turn 294 flat properties into 61 extraction top-level keys, of which 47 are
still unmoved leaves — which is why the split payoff above is stated as conditional.

That run also found the proposal is **all-or-nothing at a scale nobody had tried**. Of 91
proposed operations exactly one was invalid — a `retype` naming a leaf the same proposal
dropped — and it cost all 91, the fourteen good nests included. The repair turn did not find it
and the run exhausted to `[]`. The repair budget's default is raised from 1 to 3 in response,
which is a mitigation and not a fix: partial application, where valid operations land and refused
ones are reported, is the real answer and is separate, named work. ADR 0016 argued one repair
against an eleven-leaf fixture; this is the first evidence from a real one.
