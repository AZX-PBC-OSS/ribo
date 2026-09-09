---
"@azx/ribo-core": patch
---

Add per-capture attribution markers to the joined session transcript.

`joinSessionTranscript` now accepts `{ markCaptures: true }` to prefix each capture's transcript text with a per-capture marker (`\n===== CAPTURE seq:N kind:K id:I =====\n`), mirroring the page-marker convention from `@azx/ribo-transcriber-pdfjs`. The marker carries the seq, kind, and outbox item id — what a downstream consumer needs to resolve a citation back to a row via `outbox.get(id)`. All three are assigned at enqueue time and never change across a retry.

The option defaults to `false` so existing callers see the same text they always have; what every extractor sees does not shift unless the caller explicitly opts in. `isSpanGrounded` is unaffected because markers sit before the transcript text, not inside it — a verbatim quote from within a single capture remains a substring of the joined text. Verified by mutation: empty marker turns the marker-presence tests red, defaulting to true turns the absence test red, and uppercasing the transcript text turns the span-grounding test red.
