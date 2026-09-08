---
"@azx/ribo-core": minor
"@azx/ribo-adapter-snuggpro": minor
"@azx/ribo-extractor-openai": minor
"@azx/ribo-ui-react": minor
---

A roster group can now say "there are none of these," grounded in a verbatim quote — distinct from both a populated group and one the transcript never mentions at all.

An untouched roster group and one the auditor explicitly said was empty used to collapse to the same `[]`, a named, accepted-for-now gap in the R1.6 instance-extraction design ("surfacing eligibility to review… additive later"). A roster group's value is now a union: an array of candidates, or `{ stated: "none", span: "<verbatim quote>" }` — the fourth instance of the roster's existing grounding mechanism (existence/separation/exclusion, now absence), each requiring a quote so the unsafe direction costs evidence.

`scopedInstanceExtractor` surfaces the signal as a new `ExtractionResult.statedEmptyGroups` field, and it reaches its own dedicated session field (`statedEmptyGroups`, riding the same schema `version: 2` the instance-write-receipts change already introduces) rather than folding into the opaque `extracted` blob — matching how `extractedBy`/`extractionUsage` are already handled. Set unconditionally on every extraction, not conditionally, so a re-extraction whose new roster no longer states a group empty clears the stale quote rather than leaving it in place.

`ReviewGroupState` gains a fourth value, `"statedEmpty"`, and `ReviewCollectionNode` gains `emptyQuote: string | null`. **A group absent from the extraction entirely still takes priority as `"absent"`, unaffected by a stray `statedEmptyGroups` entry** — "never mentioned" and "explicitly stated absent" stay different claims. `resolveReview`'s `emptyCollectionPaths` treats `"statedEmpty"` the same as `"empty"` for write purposes, so the strongest form of "none" an auditor can assert still writes `fields[group] = []` rather than silently regressing to "touch nothing."

The roster's other internal fields (`discriminator`, `mentionSpan`, `distinguishedBy`) stay internal — only this one new signal crosses into the extraction contract.
