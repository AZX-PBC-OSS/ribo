---
"@azx/ribo-chat-helix": minor
"@azx/ribo-core": patch
"@azx/ribo-ui-react": patch
---

`helixChat`'s `token` option is now optional. A deployed Helix app authenticates to its same-origin
gateway with the session cookie and has no token, so it no longer has to pass a placeholder and cast
around the type. When `token` is absent no `authorization` header is sent at all; behaviour with a
token is unchanged (`Bearer <token>`).

Also fixes stale API names in `@azx/ribo-core`'s and `@azx/ribo-ui-react`'s README code samples
(`openOutbox` → `openStorage`; `useOutboxItems`/`useHostOutbox` → `useCaptures` and the
provider's `storage` instance).
