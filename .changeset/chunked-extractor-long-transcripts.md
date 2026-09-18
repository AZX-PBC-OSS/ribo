---
"@azx/ribo-core": minor
---

Chunked extraction: a transcript longer than a model's context window is now extractable —
split it, extract from each piece, and put the pieces back together without inventing
anything.

`@azx/ribo-core` gains three layers, each public. `splitOnBudget(maxChars)` is the shipped
`ChunkPolicy`, splitting at paragraph, then sentence, then word boundaries — separators stay
with the preceding chunk so the pieces concatenate back to exactly the text, and a single
token longer than the budget comes back as one over-budget chunk rather than throwing a
whole document unextractable. `assertExactPartition` is the load-bearing half: a positional
cursor walk proving the chunks are an exact partition of the canonical text — contiguous,
non-overlapping, covering every character — because a per-chunk membership test cannot see
a dropped paragraph, and an empty chunk would dispatch a model call on empty text.
`firstCommitted` / `lastCommitted` are `MergePolicy` (an index into the samples, so a policy
cannot fabricate a value, a confidence or a citation), and `mergeChunkResults` walks the
chunk results together. `chunkedExtractor(inner, { target, chunk, merge?, alignInstances? })`
composes them: construction refuses a non-leaf-provenance target; each `extract` verifies
the partition before any model call and runs the inner extractor over each chunk
sequentially.

What a consumer gains: a fact must be inside one chunk to be found, but every leaf keeps
its verbatim citation against the whole document, and collections come back complete —
three chunks describing five rooms produce five rooms, in document order, never the
positional splice that would fabricate one room from two.

What it costs, stated plainly: N chunks is N× the model calls of one pass; a fact
straddling a chunk boundary is lost (no merge policy can recover a value no chunk
contained); and collections **concatenate** — the same real-world thing described in two
chunks appears twice unless the caller supplies `alignInstances`, an `InstanceMatcher` that
judges sameness across disjoint regions. That is host knowledge, always: no shipped matcher
merges anything (`contradictionMatcher` cannot return `"same"`), so the default is review
duplicates rather than silently merging two records. A chunk failure propagates the inner
error unchanged and fails the whole run — a failed chunk means a region was never read —
and there is no per-chunk resumption yet: one transient failure at chunk 40 re-runs all 40.
