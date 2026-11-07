---
"@azx/ribo-core": minor
---

Add `scriptedChat(respond, options?)` — a public scripted chat client, the `ChatClient`
counterpart to `FakeExtractor` and `FakeTranscriber`. It drives the chat-based extractors
(`singleShotExtractor`, `perGroupExtractor`, the phased strategies) deterministically with no
model: a fixed reply or a per-call callback, every request recorded on `calls` in order (failed
and aborted calls included), thrown `ChatError`s passed through unchanged so arbitration and
retry see what a real transport would throw, an abortable per-call `delay`, and a
runtime-controllable `capability()` with `setCapability` and `reset()`.
