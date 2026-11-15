---
"@azx/ribo-cli": minor
---

The package grows the generic scorer (design §2): `scoreEvalRun(corpus, results)` judges one run
against one loaded corpus, leaf by leaf, and returns a dense grid of per-cell verdicts beside the
run-level totals. The corpus enters only through `loadCorpus`, and the leaf set is the one field
inventory reports, so the scorer never carries a second field walk; the expectation precedence is
the corpus's own rule, so a blanketed statement and a per-leaf statement resolve the same way
everywhere. Each cell carries one of the verdicts in the exported `EVAL_VERDICTS` vocabulary —
`correct`, `wrong`, `missed`, `hallucinated` and `unscorable` — with the expectation, the value
the run produced, the corpus's own source span and where the expectation came from. Two values are
the same answer when they are the same after a small, declared set of folds: case, whitespace and
trailing punctuation; numbers, in digits or in words; booleans, and the string that spells one. An
enum's members come from the schema, never from a hand-kept list, and a leaf's acceptable
alternatives are honoured.

The totals always carry the rates together — the answer rate, the accuracy over answered and
the accuracy over all — because each of them reads as a contradiction when another is missing;
a rate is null when its denominator is zero, never NaN and never absent. A failed case is scored as
an empty extraction, so a run that produced nothing can never score better than a run that tried.
`RETIRED_VERDICT_TRANSLATION` publishes the design's §3 table — the retired spike verdicts
and the generic verdict each landed on — as the boundary that names the retired vocabulary
once.
