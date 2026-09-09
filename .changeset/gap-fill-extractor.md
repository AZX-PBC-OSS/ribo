---
"@azx/ribo-extractor-openai": minor
---

Add `gapFillExtractor` — a combinator that wraps any base
`Extractor<Enveloped<V>>` with one bounded follow-up pass over
"abstained-with-evidence" leaves.

A quality audit of real transcripts found the model sometimes quotes exactly
the right passage in `sourceSpan` yet leaves `value: null` — the identical
quote committed to a value in one recording's extraction and abstained on in
another's. After the base extraction, leaves with `value === null` but a
non-null `sourceSpan` get ONE focused chat call: the model is handed the
transcript plus each candidate's own already-found quote and either commits to
the value the quote supports or explicitly reaffirms null — a fully valid,
unpenalized answer, so this is a second low-noise look at the model's own
uncertain calls, not an always-fill-the-blanks pass.

With no candidates the base result passes through untouched — no second call,
no wrapper, no usage change. Otherwise the follow-up response is parsed
against a strict schema carrying exactly the candidate leaves (keyed by path,
each entry that leaf's own envelope schema out of `extractionSchema`), merged
back immutably so only candidate leaves move, and usage sums the base run plus
one call. Not wired into any adapter; that is a separate decision.
