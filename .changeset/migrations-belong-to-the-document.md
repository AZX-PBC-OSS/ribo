---
"@azx/ribo-core": minor
"@azx/ribo-storage-rxdb": minor
---

**Migrations move out of the storage backend and into core, as versioned data.**

Each persisted document type now carries its shape version and the ordered history of changes that
reached it. `@azx/ribo-core` exports `CAPTURE_DOCUMENT_VERSION`/`CAPTURE_DOCUMENT_UPGRADES`,
`SESSION_DOCUMENT_VERSION`/`SESSION_DOCUMENT_UPGRADES` and
`PLUGIN_STORAGE_DOCUMENT_VERSION`/`PLUGIN_STORAGE_DOCUMENT_UPGRADES`, plus the `ShapeUpgrade` type. A
ladder is an ordered list where rung `i` describes version `i` → `i + 1`; each rung carries a required
`reason` and either an `upgrade` function or `rewrite: "none"`.

This is data, not behaviour — a backend imports it the way it imports the zod schemas. Core owns what
each change does; the backend owns when it runs, how it batches, and how it checkpoints. Every
transformation in this repository was already a pure function of the document, so nothing became
harder to express; it simply stopped being one backend's private property.

`backfillSessions` **moves to `@azx/ribo-core` and is no longer exported from
`@azx/ribo-storage-rxdb`.** It needed only four port operations, so it is now written against
`StorageBackend` and takes a backend rather than an `OutboxDatabase`. If you imported it from the
RxDB package, import it from core and pass `storage.backend`. Hosts using `openRxdbBackend` or
`openOutboxDatabase` need to change nothing — the backfill still runs at open.

`@azx/ribo-storage-rxdb` keeps its `RxJsonSchema`s, indexes and open-time behaviour and becomes an
adapter: `toMigrationStrategies` converts a ladder into RxDB's strategy map, and each schema's
`version` is core's constant. **No schema version changed** — captures stay at 7, sessions at 2,
entries at 1. Existing databases migrate exactly as before.

Two new guards, both in core so every backend inherits them. Each ladder must have as many rungs as
its version number, and each document's field signature is pinned per version in
`upgrades/signature.test.ts` — the RxDB package's equivalents were that backend's own discipline, in
a package a second backend does not depend on.

One obligation is now written down that was previously assumed, and it is the opposite of what the
code claimed: **rungs are deterministic but not idempotent.** Re-applying one is destructive, not
merely wasteful — the capture v5→v6 rung rebuilds an empty carrier over a populated one and loses the
extraction it was mid-move, silently. RxDB never does this; a backend that batches and resumes from a
checkpoint must guarantee at most one application per document. `docs/guide/migrations.md` is the
contract for backend authors, including the attachment limit: a rung is a per-document, synchronous,
JSON-only rewrite and cannot touch attachment bytes.
