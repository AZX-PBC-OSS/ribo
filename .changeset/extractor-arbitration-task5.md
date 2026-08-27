---
"@azx/ribo-core": patch
---

Add the concurrent extraction engine and `raceExtractor`.

`createConcurrentExtractor` is the shared concurrent scheduler: it starts every
candidate at once, calls the arbiter as each outcome settles, and stamps the
accepted candidate's id onto the result. `raceExtractor` is the public
constructor over it, taking a strategy/extractor roster and an arbiter, with no
admission gate and no scheduling flag. This completes the arbitration increment:
`fallbackExtractor` (sequential), `raceExtractor` (concurrent), and the reimplemented
`compositeExtractor` (sequential with capability admission) all share one engine,
while keeping their concurrency guarantees structural.
