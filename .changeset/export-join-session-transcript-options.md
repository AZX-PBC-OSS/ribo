---
"@azx/ribo-core": patch
---

Export `JoinSessionTranscriptOptions` (the `markCaptures` option type added
alongside `joinSessionTranscript` itself) from the queue barrel — it landed
after `joinSessionTranscript` was exported and was missed, leaving a host
unable to name the options type for its own call sites without reaching past
the package's exports again.
