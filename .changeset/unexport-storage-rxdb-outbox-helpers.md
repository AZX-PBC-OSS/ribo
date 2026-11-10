---
"@azx/ribo-storage-rxdb": minor
---

Remove the outbox-era database helpers from the public barrel: `openOutboxDatabase`, `removeOutboxDatabase` and the `OutboxDatabase` type. The package still uses them internally under their storage-era names — `openStorageDatabase`, `removeStorageDatabase` and `StorageDatabase` — and the barrel now re-exports `StorageDatabase` so `createRxdbBackend`'s signature stays reachable.

**If you are migrating from the old vendored `@azx/ribo-core`, whose `OutboxDatabase` helper opened this package's database directly: do not reach for these names. Use `openStorage` with `openRxdbBackend()` instead — it opens the same database, runs the same migrations, and returns the storage port the engine speaks.**
