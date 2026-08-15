---
"@azx/ribo-extractor-openai": minor
---

Add `perGroupExtractor` — the per-group extraction strategy (R3 Task 2).

Splits a target's `extractionSchema` into top-level groups
(`splitExtractionSchema` from Task 1), runs one chat call per group
concurrently with a bounded pool, and assembles one result through the
same `Extractor` seam as `singleShotExtractor`.

The trust boundary runs twice: each response is parsed against its own
group schema at the point of receipt, then the merged whole is parsed
against the full `extractionSchema` before returning — the second parse
catches a merge that produced a shape no single call would have.
Normalization runs once on the merged result, not once per group.
`usage.calls` reports the real number of calls made.

A non-grouped schema (a flat enveloped schema whose top-level properties
are leaf envelopes, a non-object schema, or an empty object) makes one
call — exactly today's behaviour.

No per-group retry in this increment (Task 3 adds it). Any group failing
fails the extraction, which is today's all-or-nothing behaviour — the
relay's existing backoff, attempt count and `dead` handling take over
unchanged.

The prompt assembly, pre-parse `finishReason` check, terminal-transport
classification, and parse helpers are shared with `singleShotExtractor`
through `extraction-common.ts` — the hard-won reasoning behind each is
reused, not copied.
