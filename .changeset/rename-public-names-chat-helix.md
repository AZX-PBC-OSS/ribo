---
"@azx/ribo-chat-helix": minor
---

Follow @azx/ribo-core's rename of `ChatRequest.response_format` to `ChatRequest.responseFormat`. The flattened Helix wire body is unchanged and a new wire-drift test pins it, asserting the body carries no `response_format` key.
