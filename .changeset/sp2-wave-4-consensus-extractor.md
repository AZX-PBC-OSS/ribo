---
"@azx/ribo-core": minor
---

`consensusExtractor` — the judging combinator that runs a list of candidate extractors over the same transcript, compares the survivors leaf by leaf, and nulls the value of every leaf they disagree about while keeping a citation: exactly the shape gap-fill re-asks about and review flags. What a consumer gains is a trust signal the library could not compute — agreement between independent samples — at a known cost: **N times a single extraction**, one bill per candidate.

Candidates settle independently — a candidate that rejects is a missing sample, never a failed run, and never cancels a sibling. The comparison walks the first survivor, so put your most trusted candidate first; a survivor that falls short of its length on a collection contests that collection wholesale rather than pair instances across a dropped one. Below quorum (default 2 survivors) the run throws `ConsensusFailedError`, which is transient — an arbitration ladder gives up rather than trying the next rung on the same downed transport.

The leaf decision is a caller-supplied `ConsensusArbiter` returning an **index into the samples it was handed**, so a policy cannot fabricate a value, a confidence or a citation — it can only point at evidence it was given. `unanimousValues` is the default and fails safe under any reordering of collection instances; `majorityValues` ships beside it and is unsound over reordered collections (the design's §8 records the hole). A throwing `onContested` handler is swallowed, and that notification is the contested count's only channel: count callbacks.
