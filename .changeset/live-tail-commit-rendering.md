---
"@azx/ribo-ui-react": minor
---

Revision 7 Task 5: render committed text and the provisional tail distinctly.

The `liveTranscriber` field on `RiboInstances` was documented with the
pre-revision-7 model ("segments are appended to the outbox row"). The
comment now describes the actual behaviour: tails go to
`writePreviewTail` (provisional, replaced wholesale), commits go to
`commitPreview` (permanent, appended to `committed`).

No API change — `RiboInstances.liveTranscriber` is the same field. The
minor bump is for the documentation correction and because the hook
layer's contract now explicitly references the tail/commit distinction
that Task 4 added to the `LiveSession` seam.
