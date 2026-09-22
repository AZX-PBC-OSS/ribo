---
"@azx/ribo-extractor-systemone": minor
---

Add `corroborateExtractor(extractor, options)` — the second judging combinator (ADR 0017). After
the inner extractor runs (options bag forwarded whole), core's pure `groundingCensus` is extended
by `corroborationCensus` with a System One verdict per committed leaf, and the result is handed to
a caller-supplied synchronous `CorroborationPolicy` returning core's `ValidationVerdict`. A
rejection throws `CorroborationRejectedError`, which extends core's `TerminalError` so the shipped
default arbiter falls through to the next rung instead of re-running the hallucinating one on
backoff; a passing result is returned untouched, by identity. The shipped
`rejectUncorroboratedCommitments(ratio)` rejects when the share of committed leaves whose verdict
is not `supports` exceeds `ratio` — a RATIO, never a single leaf, because ADR 0017 measured
per-leaf scores landing on both sides of any threshold. The `ratio` argument is required with no
default: nothing measured justifies a number, and a wrong default fails silently in both
directions. Targets with `"row"` or `"none"` provenance are refused at construction via core's
`assertLeafGranularity` (ADR 0003). Inner and client failures propagate unchanged — a transport
failure is not a verdict. No progress units are emitted yet: ADR 0004's no-work reasoning does not
cover the verification calls, and ADR 0017 records whether they should report units as an open
question.
