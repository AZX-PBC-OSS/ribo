---
"@azx/ribo-core": minor
---

An extraction result can now be judged on how well it is cited, before it reaches review or a write.

`groundingCensus` is a pure tally over an extraction result: three independent facts per leaf (committed, cited, groundedness — `null` when nothing was cited, so an honest abstention stays distinguishable from a fabricated citation), the same tally for a result's stated-empty group spans, and counts derived from the leaves.

`validateExtractor` wraps any `Extractor` with a caller-supplied policy over that tally (the default, `rejectUngroundedCommitments`, rejects a committed leaf citing text absent from the transcript — and an ungrounded stated-empty group span, the same claim at group scale). A passing result is returned untouched; a rejected one throws `ValidationRejectedError`, which extends `TerminalError` — so under the shipped default arbiter a rejection falls through an arbitration ladder to the next strategy instead of becoming a relay retry loop over the hallucinating rung. Construction refuses a target whose groups are not derived at `"leaf"` provenance granularity, before any call is made.
