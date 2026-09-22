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
construction check relaxes for precisely this case: single-segment source, both top-level keys
`"leaf"`-granular, and the extraction top-level key synthetic (absent from the patch schema).

The derived patch is byte-identical after a nest. Provenance may not be declared on a nest group —
`mapping.provenance` is applied to BOTH schemas and the group exists in only one — nor on a leaf a
nest moved away; the derivation refuses both, at construction, where the author is present.

## Consequences

What `nest` buys is extraction-side, and only extraction-side — and **the split payoff is
conditional, on a condition the motivating case does not meet.** A nest group becomes its own
`splitExtractionSchema` entry, with its own call and its own prompt assembly, **only when the
nests cover every top-level key.** The split's gate is `everyKeyIsGroup`: one unmoved top-level
leaf collapses the whole schema to the flat fallback, and every nest group with it. Measured, not
inferred — nesting two of three flat leaves yields `[""]`; nesting all three yields the groups.

That is exactly the spike's shape: 19 proposed groups over 294 leaves is partial nesting, so a
proposal like the one that motivated this operation buys **no** split payoff today. What it buys
unconditionally is the model-facing schema — the extraction schema carries `attic` as a subject
rather than as loose fields, which is what the proposer reasons over and what a caller reads.

Teaching the splitter to partition a mixed schema — real groups as groups, leftover top-level
leaves packed as one — is the work that would make the payoff unconditional. It is named here and
deliberately not done: it changes the splitter, which this change does not touch. The limitation
is pinned by a test, so it is recorded in code and not only in this paragraph.

What it does not buy, stated plainly so this record cannot be read as overselling: review still
renders the moved leaves FLAT (`buildReviewRequest` walks the patch schema, which a nest leaves
untouched — there is no attic card); `requiredOnCreate` and `identifyingFields` cannot be declared
on a nest group (declarations resolve against the patch tree, where the group does not exist);
and provenance cannot be declared on one either — a nest group is `"leaf"`-granular forever. If
patch-side declarations on nest groups are ever wanted, that is separate, named work.

The cost: the operation set is four, not three, and the mapping's top-key invariant is now
conditional. A hand-written mapping can express a cross-top pair that reverses wrongly — an
envelope written where a plain value is wanted fails as a RETRYABLE `SchemaParseError` at every
extract — so the relaxing conjuncts (both tops `"leaf"`, synthetic extraction top) are pinned by
their own tests, and `reverseShapedFields` roots every patch-side write at the source's top-level
key.
