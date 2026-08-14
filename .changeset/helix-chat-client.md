---
"@azx/ribo-extractor-openai": minor
---

Add `helixChat` — a second `ChatClient` for the Helix platform LLM route.

The route (`POST <base>/_api/llm/chat`) is provider-neutral and **not**
OpenAI-compatible, so extraction could not run on it at all. `helixChat` bridges
the gap beside `openAiChat`:

- A `role: "system"` message becomes the top-level `system` field, not a
  message; all other messages go into `messages` with roles `user`/`assistant`
  only.
- `response_format` is flattened to `responseFormat` (`{ type, name, schema }` —
  `strict` is dropped: the platform always enforces).
- `stream: false` is always sent (the route defaults to SSE).
- `maxTokens` passes through as camelCase (same intent-as-seam spelling the
  OpenAI client owns differently).
- Auth is `Authorization: Bearer <token>` plus an `Origin` header matching an
  origin registered for the dev token. Both the base URL and the origin are
  injectable `HelixChatOptions` — no token or URL is hardcoded.

Response mapping: `content` → `ChatCompletion.content`; `stopReason` →
`finishReason` with `"max_tokens"` → `"length"` (so the existing truncation
guard keeps working) and `"end_turn"` → `"stop"`. An unrecognised or absent
`stopReason` is a `malformed-response` `ChatError`, never a silent `"stop"` —
matching the guarantee `openAiChat` carries. `usage.inputTokens`/`outputTokens`
map to `promptTokens`/`completionTokens`; the route's cache token counts are
dropped (the seam has nowhere for them), with a comment noting the route caches,
which matters for per-group extraction.

Errors map to `ChatError` with the same kinds `openAiChat` uses: a `403
model_not_allowed` and a `400 validation_failed` on `responseFormat.schema` are
named in the message, and a `403 forbidden` names origin registration — the
diagnostic a developer hits first when wiring the dev gateway.
