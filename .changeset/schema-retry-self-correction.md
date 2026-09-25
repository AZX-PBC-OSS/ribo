---
"@azx/ribo-core": minor
---

Add `schemaRetryExtractor`, a bounded self-correction retry for schema validation failures.

A model response that parses as JSON but fails the extraction schema used to have two outcomes:
fall through to another strategy, or re-send the identical request — the model was never told
what it got wrong. The new combinator wraps a base `Extractor` and, on a `SchemaParseError`,
re-asks through the injected `ChatClient`, appending the failed output as an assistant turn and
the validation error as a user turn. The feedback travels as conversation turns, never in the
transcript: the transcript text the model sees is byte-for-byte the caller's on every attempt,
so `spanGroundedness` keeps checking quotes against the real source and the model's own rejected
values are never re-presented as citable document text.

The budget is small and bounded (`maxRetries`, default 1; `0` disables retrying). Only
`SchemaParseError` is retried — transport errors, refusals and truncations pass through
untouched — and an exhausted budget rethrows the last `SchemaParseError`, still transient and
recognisable to a strategy ladder. Retry calls are real model calls and are counted in the
result's `usage`.

`SchemaParseError` gains an optional `output` property carrying the rejected payload, populated
where the schema parse fails, so a retry has the model's actual answer to show back to it. Its
meaning is unchanged.
