---
"@azx/ribo-adapter-snuggpro": minor
---

`hvacDuctLocation` and `wallExteriorWallConstruction` are now enums instead of free
text. Snugg Pro's spec declares both with `enum: []` and publishes no member list,
but its API enforces one: a real write-back of `"Basement"` and `"2x4"` came back
`400`, and the `400` body listed every member. The members are copied verbatim from
those rejections (staging, 2026-09-30). The vendor's `""` member is left out, since
`null` already means no answer.

`hvacDuctLocation` members pair a place with whether it is conditioned, and a
dictation usually names only the place. Its description tells the model to abstain
then (`null` value, the auditor's words kept as `sourceSpan`), so the auditor picks
the member at review and the model does not guess it.

Narrowing both `SnuggValues` leaves from `string` to a literal union is a type-level
break for code that assigns arbitrary strings. A session already holding a free-text
value no longer reaches the vendor. At review, accepting that value is reported as
invalid, and the reviewer edits it to a member or rejects it. An outcome that was
already reviewed fails the write step's patch parse before anything is written,
instead of partially writing and then failing on the vendor's `400`.
