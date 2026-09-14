---
"@azx/ribo-core": major
"@azx/ribo-extractor-openai": major
"@azx/ribo-extractor-ondevice": major
"@azx/ribo-transcriber-pdfjs": minor
"@azx/ribo-transcriber-managed-docs": minor
---

The transcribe→extract seam is now `AnnotatedTranscript`, not a bare `string`.

`Extractor<F>.extract` takes `{ text, annotations }` instead of `string`. The canonical `text` is the exact string extracted spans are checked against — `isSpanGrounded(span, t.text)` is unchanged. The `annotations` bag is open and deliberately empty: nothing produces annotations yet, and a speculative schema for a consumer that does not exist will be wrong by the time anyone finds it.

**This is a breaking change for anyone who implements `Extractor` directly or constructs `SessionExtractInput`.** The `transcript` field on `SessionExtractInput` is now `AnnotatedTranscript`, not `string`. `toSessionExtractStep` passes it through unchanged, so callers that wire extractors through it need no logic change — only the type. No back-compat overload or deprecation shim is provided.

`Transcript.text` now holds rendered text, not escaped markup. Document transcribers (`ribo-transcriber-pdfjs`, `ribo-transcriber-managed-docs`) decode HTML entities at the transcriber via the shared `decodeEntities` helper from `ribo-core`, so the canonical text is already rendered by the time anything quotes from or checks against it. Audio transcribers are unaffected — speech does not produce entities.
