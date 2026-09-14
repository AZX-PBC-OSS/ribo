---
"@azx/ribo-core": minor
---

Add per-capture attribution markers to the joined session transcript via the default transcript combiner.

`createDefaultTranscriptCombiner({ markCaptures: true })` returns a combiner that prefixes each capture's transcript text with a per-capture marker (`\n===== CAPTURE seq:N kind:K id:I =====\n`), mirroring the page-marker convention from `@azx/ribo-transcriber-pdfjs`. The marker carries the seq, kind, and outbox item id — what a downstream consumer needs to resolve a citation back to a row via `outbox.get(id)`. All three are assigned at enqueue time and never change across a retry.

The marker is built from `seq`, `kind`, and `id` in each part's `annotations` bag, which the relay populates from the outbox item. The option defaults to `false` so existing callers see the same text they always have. `isSpanGrounded` is unaffected because markers sit before the transcript text, not inside it — a verbatim quote from within a single capture remains a substring of the joined text.
