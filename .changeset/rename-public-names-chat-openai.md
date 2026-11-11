---
"@azx/ribo-chat-openai": minor
---

Follow @azx/ribo-core's rename of `ChatRequest.response_format` to `ChatRequest.responseFormat`. The outgoing request body is unchanged — it still sends `response_format` on the wire, now pinned by a new wire-drift test.
