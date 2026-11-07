# @azx/ribo-core

## 0.1.0

### Minor Changes

- 7fba323: First release.
- c6e52d8: Add `scriptedChat(respond, options?)` — a public scripted chat client, the `ChatClient`
  counterpart to `FakeExtractor` and `FakeTranscriber`. It drives the chat-based extractors
  (`singleShotExtractor`, `perGroupExtractor`, the phased strategies) deterministically with no
  model: a fixed reply or a per-call callback, every request recorded on `calls` in order (failed
  and aborted calls included), thrown `ChatError`s passed through unchanged so arbitration and
  retry see what a real transport would throw, an abortable per-call `delay`, and a
  runtime-controllable `capability()` with `setCapability` and `reset()`.

### Patch Changes

- 48c0647: `helixChat`'s `token` option is now optional. A deployed Helix app authenticates to its same-origin
  gateway with the session cookie and has no token, so it no longer has to pass a placeholder and cast
  around the type. When `token` is absent no `authorization` header is sent at all; behaviour with a
  token is unchanged (`Bearer <token>`).

  Also fixes stale API names in `@azx/ribo-core`'s and `@azx/ribo-ui-react`'s README code samples
  (`openOutbox` → `openStorage`; `useOutboxItems`/`useHostOutbox` → `useCaptures` and the
  provider's `storage` instance).
