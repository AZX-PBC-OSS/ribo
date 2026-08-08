---
"@azx/ribo-extractor-openai": minor
"@azx/ribo-adapter-snuggpro": minor
---

Widen the `ChatClient` seam: token cap, abort, and typed errors.

`ChatRequest` gains an optional `maxTokens` (camelCase — the seam carries intent,
not a wire spelling; `openAiChat` owns the `max_tokens` mapping). `ChatCompletion`
gains optional `finishReason` and `usage`; `openAiChat` guarantees `finishReason` is
always populated (an absent or unrecognised `finish_reason` is a
`malformed-response` error, never a completion with the field omitted).
`ChatClient.complete` gains an optional `ChatCallOptions` second parameter carrying
an `AbortSignal`. All failures now surface as `ChatError` (a single class with a
`kind` discriminant: `transport`, `http`, `aborted`, `malformed-response`, `refusal`,
`unsupported`) with `cause` preserved, replacing the flattened message strings and
the package-private `OpenAiHttpError`.

`singleShotExtractor` rejects any non-`"stop"` `finishReason` before the zod parse,
so a truncated (`"length"`) or content-filtered response is not misreported as
"invalid JSON" — the truncation message names `maxTokens`, the knob that fixes it.
`SingleShotOptions` gains `maxTokens`, passed through to the request.

`cliChat` honours the `AbortSignal` (killing the running child), throws
`ChatError.unsupported` for `maxTokens` (a CLI cannot cap generated tokens), and
rethrows an abort immediately rather than retrying.
