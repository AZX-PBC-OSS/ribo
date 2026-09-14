---
"@azx/ribo-extractor-openai": minor
---

`gapFillExtractor` can now re-ask leaves whose citation is not in the transcript, via
`targets: ["abstained", "ungrounded"]`. The default stays `["abstained"]`, so existing callers
see byte-for-byte the prompt and behaviour they saw before.

Gap-fill already handled one kind of gap — a null value beside a real quote. The other kind is a
committed value beside a quote that is not in the transcript: `spanGroundedness` of
`"ungrounded"`. The value is often right and the citation reformatted or synthesised, which is
exactly the case a second look can fix. Near-misses are deliberately excluded — that tier exists
to say a quote is fine apart from spacing, and re-asking it would spend a paid call on a
non-problem.

The merge is **non-regressive**: an ungrounded candidate's replacement is accepted only if its new
citation actually grounds, or if the model concedes the value to null. A second unverifiable quote
is refused and the base leaf stands, so enabling this can never leave a leaf worse than the base
run did. That property is what lets it run automatically.

Measured on a 126-leaf Manual J (`spikes/matched-schema-scale/`): a one-call extraction returned
15-18 ungrounded spans per run and re-asking converted about half to verbatim quotes. In that
measurement no leaf was ever conceded as null, which is why the merge enforces the improvement
rather than trusting the prompt to produce it.

Also exports `findUngroundedLeaves` and the `GapFillTarget` type, and adds a `kind` discriminator
to `AbstainedLeaf` so a candidate carries why it is being re-asked.
