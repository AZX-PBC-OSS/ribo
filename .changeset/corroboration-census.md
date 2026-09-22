---
"@azx/ribo-extractor-systemone": minor
---

Add `corroborationCensus(census, fields, transcript, options)` — the grounding census extended
with a System One verdict per committed leaf, the measured step 2 of TypeSafe's citation-check
cookbook (ADR 0017). Each committed leaf gets ONE `choice` question over `supports` /
`contradicts` / `says_nothing`, told the leaf's enum members via `enumMembersAt` and the
encoding clause — without which the verifier reads the schema's own encoding of what the auditor
said as a fabrication. Leaf values are read back out of `fields` with core's pure
`mapExtractedLeaves` walk; the state passed to the client is the transcript text; more questions
than `batchSize` split across sequential `ask` calls, and every leaf appears exactly once in the
result. An uncommitted leaf is never asked about — its null value has nothing to corroborate —
and carries nulls for `verdict`, `confidence` and `probabilities`, so an abstention stays
distinguishable from a judgement. `contradicts` and `says_nothing` stay distinguishable on the
returned census because they invite different repairs: a re-ask versus an honest null. Counts
gain `uncorroborated` — committed leaves whose verdict came back as anything other than
`supports`, the number a policy thresholds (the combinator itself is a later task; this is the
census alone, and nothing here reaches a human).
