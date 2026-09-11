---
"@azx/ribo-core": patch
---

Expose `JoinSessionTranscriptOptions` through `createRelay` via a new optional `joinOptions` field. This lets callers turn on per-capture attribution markers through the relay, which is the primary path for session extraction. Default behavior (`markCaptures: false`) is unchanged.
