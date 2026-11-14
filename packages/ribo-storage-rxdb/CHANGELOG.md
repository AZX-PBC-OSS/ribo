# @azx/ribo-storage-rxdb

## 0.2.0

### Minor Changes

- e76e1db: Remove the outbox-era database helpers from the public barrel: `openOutboxDatabase`, `removeOutboxDatabase` and the `OutboxDatabase` type. The package still uses them internally under their storage-era names — `openStorageDatabase`, `removeStorageDatabase` and `StorageDatabase` — and the barrel now re-exports `StorageDatabase` so `createRxdbBackend`'s signature stays reachable.

  **If you are migrating from the old vendored `@azx/ribo-core`, whose `OutboxDatabase` helper opened this package's database directly: do not reach for these names. Use `openStorage` with `openRxdbBackend()` instead — it opens the same database, runs the same migrations, and returns the storage port the engine speaks.**

### Patch Changes

- 85e3505: Test-only: the durability tests pick up @azx/ribo-core's rename of `Recording` to `AudioCapture`. No public surface changed.
- Updated dependencies [a39efc5]
- Updated dependencies [85e3505]
- Updated dependencies [e76e1db]
  - @azx/ribo-core@0.2.0

## 0.1.0

### Minor Changes

- 7fba323: First release.

### Patch Changes

- Updated dependencies [7fba323]
- Updated dependencies [48c0647]
- Updated dependencies [c6e52d8]
  - @azx/ribo-core@0.1.0
