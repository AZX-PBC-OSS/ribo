---
"@azx/ribo-cli": patch
---

The CLI chat transports (`claude` and `codex` backends) now send the prompt to the child's stdin and close the pipe, instead of passing it as one argv argument — a large prompt (a big schema, a long document) no longer fails with `E2BIG` before any model call.
