---
"@azx/ribo-storage-rxdb": minor
"@azx/ribo-core": minor
---

Introduce the storage port: a narrow backend contract under the durable outbox, with RxDB as the first of two implementations.

`@azx/ribo-core` gains the port itself (three logical collections, ~14 mechanical operations, and a **closed set of three finders** rather than a query language), an in-memory backend for tests and development, and a published conformance kit at `@azx/ribo-core/testing` — framework-agnostic, so a third-party backend author can depend on it without a test-runner peer dependency.

The new `@azx/ribo-storage-rxdb` package implements that port over RxDB and Dexie, and passes the kit in real Chromium against real IndexedDB.

The kit is the executable form of six behavioural obligations no signature can express: a document is never published before its blobs are readable; reactive queries see other contexts' writes; `modify` does not lose a concurrent update; blob listing reads lengths and never bytes; documents come back free of backend metadata; and sequence allocation is atomic across contexts.

That last one **fixes a live bug**. Sequence allocation was serialised by an in-process promise chain, which is per-instance rather than per-device — two tabs recording at once could claim the same sequence. It is now a single port operation that the RxDB backend makes atomic with a Web Lock.

Nothing consuming `Outbox` changes in this release: its public API is untouched and the persisted database and collection names are unchanged on disk.
