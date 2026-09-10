---
"@azx/ribo-core": patch
"@azx/ribo-extractor-openai": patch
"@azx/ribo-ui-react": patch
---

Let a group declare its provenance granularity, and derive the extraction schema from it.

`enveloped(schema, { provenance: { rooms: "row" } })` now takes a per-group map with three values.
`"leaf"` is the default and is byte-for-byte what `enveloped()` has always produced — every existing
caller is unchanged, and `ribo-adapter-snuggpro`'s frozen JSON Schema fixture still passes untouched.
`"row"` makes a group's leaves plain and puts ONE `sourceSpan` on each row (an array element, or the
group object for a singleton). `"none"` makes them plain with no span. The granularity is carried as
literal type information, so `Enveloped<V, P>`, `ToolAdapter<V, C, P>` and `ExtractionTarget<V, P>`
type a mixed schema without a cast; all three parameters default to today's behaviour. A granularity
naming a group that does not exist, or naming `"row"` on a leaf, throws at schema build time.

The motivation is measured, not aesthetic. A Manual J `componentLoads` table of 67 rows x 9 leaves
costs 603 verbatim citations no reviewer will click and forces the group across two calls; at row
granularity the same 15-leaf room set came back in one call with 14/14 verbatim row spans. Per-cell
citations are also harder for the model than per-row ones — `claude-haiku-4-5` fabricated 37 % of
per-cell spans on a Manual J and 0 % of row spans on the same document.

`splitExtractionSchema` now partitions on **nullable unions** rather than leaf count, and
`MAX_ENVELOPED_LEAVES_PER_GROUP = 8` is replaced by `MAX_NULLABLE_UNIONS_PER_CALL = 16` (the cap the
vendor actually enforces). An enveloped leaf costs two unions, so every partition boundary an
all-`"leaf"` schema had is exactly where it was; a 15-leaf row group plus its span is 16 unions and
now fits in one call instead of being split for nothing. The group-versus-envelope test that decides
whether a schema splits per group at all is now `isExtractedSchema` (new, in `ribo-core`) rather than
"every property is an object", which a row group is not — without that change a single row group
silently collapsed the whole per-group split back to one call.

`buildReviewRequest` and `useReview` take the same `provenance` map. A row group presents exactly as
a leaf group does — every leaf its own `ReviewField` with its own verdict — except that the fields of
one row share their row's citation, so `resolveReview` round-trips with no change.

Also adds `spanGroundedness`, a three-tier version of `isSpanGrounded` surfaced as
`ReviewField.groundedness`. `isGrounded` still means verbatim and is unchanged; the new middle tier
is `"near-miss"`, for a quote that is in the document but differs in case, whitespace runs or quote
characters. `layoutPageText` pads columns to align them, so a document transcript holds
`"$       5,250.00"` where a model quotes `"$ 5,250.00"` — reported until now as ungrounded, which is
the same answer given for text the model invented.
