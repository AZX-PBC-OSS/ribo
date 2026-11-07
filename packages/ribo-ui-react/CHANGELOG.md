# @azx/ribo-ui-react

## 0.1.0

### Minor Changes

- 7fba323: First release.

### Patch Changes

- 48c0647: `helixChat`'s `token` option is now optional. A deployed Helix app authenticates to its same-origin
  gateway with the session cookie and has no token, so it no longer has to pass a placeholder and cast
  around the type. When `token` is absent no `authorization` header is sent at all; behaviour with a
  token is unchanged (`Bearer <token>`).

  Also fixes stale API names in `@azx/ribo-core`'s and `@azx/ribo-ui-react`'s README code samples
  (`openOutbox` → `openStorage`; `useOutboxItems`/`useHostOutbox` → `useCaptures` and the
  provider's `storage` instance).

- Updated dependencies [7fba323]
- Updated dependencies [48c0647]
- Updated dependencies [c6e52d8]
  - @azx/ribo-core@0.1.0
