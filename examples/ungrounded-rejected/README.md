# example-ungrounded-rejected — an ungrounded quote is rejected

One idea: **a fabricated citation becomes a terminal rejection, not a field
value.** A `FakeExtractor` returns a result with two committed, cited leaves —
one quoting the transcript verbatim, one quoting text absent from it — and
`validateExtractor` with the default `rejectUngroundedCommitments` policy turns
that into a thrown `ValidationRejectedError` whose census names the fabricated
leaf by path.

The fabricated span is not a near-miss: it is text that appears nowhere in the
transcript under any normalisation, so `spanGroundedness` grades it
`"ungrounded"` — the tier the default policy rejects. A reformatted quote
(case, whitespace runs, quote style) would pass, deliberately.

It does not re-teach the span check itself (`examples/no-key-pipeline/` owns
that), the review flow (`examples/review-gate/`) or the arbitration ladder that
falls through on this error (`docs/api/examples/fallback-extractor.run.ts`).
Runs credential-free with no capture and no chat transport. Its code is pulled
into `docs/guide/provenance.md` (the rejection region) by a VitePress snippet
include, and the runner (`examples/run-examples.test.ts`) executes its export
in the `unit` project on every `./check.sh` run.
