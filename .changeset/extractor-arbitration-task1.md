---
"@azx/ribo-core": patch
---

Introduce the extraction arbiter contract and two default arbiters.

Adds `ExtractionOutcome`, `ArbiterInput`, and `ExtractionArbiter` to `ribo-core`,
plus `resultOutcome` / `errorOutcome` constructors and the default policies
`terminalFallsThrough` and `acceptAnySuccess`. This is the vocabulary for later
strategy-ladder combinators; no scheduling or extractor integration is included yet.
