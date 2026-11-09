# Migrations

Ribo stores captures, sessions and key-value entries on the device. Those shapes
change between releases, and the data already on disk has to survive it.

This page is for two readers: a **host** upgrading the library, and someone
**writing a storage backend**. Hosts can stop after the first section.

## For hosts: what happens on upgrade

Nothing, on purpose. Opening the storage migrates any documents written by an
older release, and `openRxdbBackend` does it for you before handing back a
backend.

Two things are worth knowing.

**Downgrades fail loudly, and that is deliberate.** Old code opening a database
written by newer code refuses at open rather than half-working. A stale cached
bundle or a rolled-back deploy is an ordinary event for a browser SDK, and the
alternative — opening happily and then rejecting a document deep inside a read,
on a recording the user can see — is much worse. If you roll back, roll back
below the release that bumped the shape, or clear the origin's storage knowing
that destroys unsynced field work.

**A migration runs once per document.** It is not a step you can re-run to repair
a database; see the obligations below for why.

## The shape of the contract

`@azx/ribo-core` exports, per collection, a version constant and an **upgrade
ladder**:

| Collection        | Version                           | Ladder                             |
| ----------------- | --------------------------------- | ---------------------------------- |
| captures          | `CAPTURE_DOCUMENT_VERSION`        | `CAPTURE_DOCUMENT_UPGRADES`        |
| sessions          | `SESSION_DOCUMENT_VERSION`        | `SESSION_DOCUMENT_UPGRADES`        |
| key-value entries | `PLUGIN_STORAGE_DOCUMENT_VERSION` | `PLUGIN_STORAGE_DOCUMENT_UPGRADES` |

A ladder is an ordered list of rungs. Rung `i` describes the change from stored
version `i` to `i + 1`, so a ladder of length N describes every shape from 0 to N.
Each rung is one of two things:

- `{ reason, upgrade }` — `upgrade` takes one stored document and returns the
  next version of it.
- `{ reason, rewrite: "none" }` — the version advanced but stored documents are
  already correct.

`reason` is always present, including on the identity branch, because "nothing
needed rewriting" is a claim worth stating and a version moved for some cause.

**This is data, not behaviour.** A backend imports it the way it imports the zod
schemas. Core owns _what_ each change does; your backend owns _when_.

## For backend authors

Applying the ladder looks like this:

```ts
import { CAPTURE_DOCUMENT_UPGRADES, CAPTURE_DOCUMENT_VERSION } from "@azx/ribo-core";

const stored = await this.readSchemaVersion("captures"); // yours
for (const rung of CAPTURE_DOCUMENT_UPGRADES.slice(stored)) {
  if ("upgrade" in rung) await this.rewriteEvery("captures", rung.upgrade); // yours
}
await this.writeSchemaVersion("captures", CAPTURE_DOCUMENT_VERSION); // yours
```

You own detection, batching, checkpointing and atomicity. You never own what the
transformation is.

### Three obligations

**1. Apply each rung at most once per document.** Rungs are pure and
deterministic but **not idempotent**, and re-applying one is actively
destructive rather than merely wasteful. The capture v5→v6 rung lifts six fields
into a carrier; run it on its own output and the carrier is rebuilt empty over
the populated one, losing the extraction and review it was mid-move. Nothing
throws. RxDB gets this right by tracking a version per document and never handing
a migrated row back to the same strategy; if you batch and resume from a
checkpoint, you owe the same guarantee. Do not replay a rung over a partially
migrated collection.

**2. Run the backfill after the rungs.** Some migrations cannot be expressed
per-document. The v5→v6 capture migration has a second phase that groups migrated
recordings, derives one session status from a whole group, and writes into the
sessions collection. Core exports it as `backfillSessions(backend)`, written
against the storage port, so it works on any backend:

```ts
import { backfillSessions } from "@azx/ribo-core";

await backfillSessions(backend); // after the rungs, before anything else reads
```

It is a no-op on a database with no migrated rows, and it is safe to call twice,
so calling it unconditionally at open is correct. **Skipping it does not error.**
You get documents pointing at sessions that were never created.

**3. Attachments are yours entirely.** A rung is a per-document, synchronous,
JSON-only rewrite. It cannot read another document, write another collection, or
touch attachment bytes. No migration in ribo's history has needed to move an
attachment, and the ladder has no vocabulary for it — if you ever need to, that
is entirely your backend's problem and core will not help.

### Changing a shape, if you are contributing to ribo

Three things move together, and a test enforces each:

1. **The zod schema** in `packages/ribo-core/src/storage/` — the shape itself.
2. **The version constant** in `upgrades/` — bumped by hand, never derived.
3. **A rung** appended to the matching ladder, with a `reason`.

Then record the new signature in `upgrades/signature.test.ts`. That table pins
each version's field list as a literal; changing a shape makes it disagree and
the failure names the field that moved.

**Do not edit the expected signature to make the test pass.** RxDB validates a
declared schema against the one a collection was _created_ with, so a changed
shape at an unchanged version is refused at open with DB6 — on every device that
has ever opened the app, whether or not it holds a row of the collection you
touched. All three collections are added in one call on one database, so that
refusal is never scoped: it takes the captures down with it, and an auditor's
recordings become unreachable with clearing the origin's IndexedDB as the only
way out. Ribo shipped that once. The test is the thing standing between you and
shipping it again.

### What the conformance kit does not check

`@azx/ribo-core/testing` verifies the port's behavioural obligations. It does not
verify any of this. The ladders are exported values rather than port methods, so
nothing obliges a backend to read them — you can pass every conformance case and
still destroy data on your first upgrade. The obligations above are a contract you
keep, not one the kit enforces.

**API pages:** [the StorageBackend port](/api/storage-port) — the contract the ladders ride on,
the conformance kit's obligations, and what the kit deliberately does not check.
