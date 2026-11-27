---
"@azx/ribo-cli": minor
---

`ribo eval` now refuses to measure unreviewed proposals (ADR 0049's review gate, made binding). An
expectation entry whose proposal is still `review: "pending"` scores as `unscorable` with the new
reason `unreviewed-proposal` — a new member of the record schema's reason vocabulary, derived from
the scorer's one list — while the cell still carries the proposed value and what the run produced,
labelled with the reason. A pending proposal enters no rate, in extracted and failed cases alike.
A corpus with no judgeable expectation at all — every entry pending, or no entries (a fresh
scaffold) — is refused before transcription, the spend estimate and any model call (exit 2),
naming `ribo corpus review` when proposals are pending and `ribo corpus propose` when the corpus
holds none. A partly reviewed corpus still runs, printing one stderr line counting its pending
cells and fully pending cases. This changes today's behaviour for an expectation-free corpus,
which previously ran, spent and recorded nothing judged; corpora with at least one judgeable
expectation load, score, fingerprint and record exactly as before.
