---
"@azx/ribo-core": patch
---

Reversal's two structural failures throw `SchemaParseError` and name the offending
path, instead of a bare `Error` that names nothing.

`reverseShapedFields` (a public export that takes any mapping, with no construction
check) failed in two ways that a bare `Error` made opaque to an extractor ladder:
a bare value where a `"leaf"`-provenance envelope was expected, and two mapping
entries writing a leaf to the same patch position. Both are failures of the
extraction data against the schema the mapping was built against — the same class
the trust-boundary parse signals — so they are `SchemaParseError`s now, recognisable
to a strategy ladder that falls through on them. Both messages carry the path:
the leaf's instance path in the extraction data (`g.arr[1].f1`), and the absolute
patch position of the doubled write (`g.x`).

The retry outcome is unchanged — an unrecognised error already defaulted transient —
so this is about the signal, not the backoff. The combinator's own output parse runs
after the walk and never sees these; the classification matters for the standalone
export.
