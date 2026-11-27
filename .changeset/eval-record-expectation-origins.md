---
"@azx/ribo-cli": minor
---

Eval records and reports disclose judged expectation origins and circularity (R8). A
proposal-bearing corpus's record cells carry a `review` member — the review class and, for a
proposal-bearing entry, the proposer's backend and model — and the record carries an
`expectations` summary: judged cells by review class summing to the judged total, judged cells
per proposer, and the count of accepted-unchanged cells whose proposer is the record's own
backend and model. The stdout report's per-arm block carries the same summary, and stderr states
that for the same-model cells the run measures agreement with the scored model's own proposal.
Both members are additive at record version 1 and written only over a proposal-bearing corpus, so
every existing record stays byte-identical.
