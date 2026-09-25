import type { RxJsonSchema } from "rxdb";

import {
  CAPTURE_DOCUMENT_VERSION,
  PLUGIN_STORAGE_DOCUMENT_UPGRADES,
  PLUGIN_STORAGE_DOCUMENT_VERSION,
  SESSION_DOCUMENT_UPGRADES,
  SESSION_DOCUMENT_VERSION,
} from "@azx/ribo-core";
import type { CaptureDocument, PluginStorageDocument, SessionDocument } from "@azx/ribo-core";

import { toMigrationStrategies } from "./migration-strategies.js";

/**
 * @file The RxDB schema layer: the hand-written JSON schemas, and the adapter
 * call that turns core's upgrade ladders into RxDB's migration strategies.
 *
 * The **shapes** live here because they describe how *this* backend lays data
 * out — `primaryKey`, `indexes`, `attachments`, and the bounds RxDB uses to
 * build fixed-width index keys, none of which zod has a concept of.
 *
 * The **versions and the transformations do not.** Both come from
 * `@azx/ribo-core`: a version is a fact about the document, not about RxDB, and
 * every transformation was already a pure function of the document. Each
 * `version` below is core's constant, so a bump happens in one place and reaches
 * every backend, and each strategy map is `toMigrationStrategies` over the
 * matching ladder.
 *
 * **A shape change here still needs a version bump plus a rung in core.** RxDB
 * validates a declared schema against the one the collection was created with,
 * so a changed property at the same version fails `addCollections` with DB6 —
 * and all three collections are added in one call on one database, so that
 * failure takes the capture store with it. Core's `upgrades/signature.test.ts`
 * is the guard that makes forgetting it a red test rather than a stranded device.
 */

/**
 * The RxDB JSON schema.
 *
 * Hand-written rather than generated from the zod schema above, because RxDB
 * needs metadata zod has no concept of — `primaryKey`, `indexes`, `attachments`,
 * and the `maxLength`/`minimum`/`maximum`/`multipleOf` bounds it uses to build
 * fixed-width index keys. `schema.test.ts` pins the two descriptions of the same
 * document against each other so they cannot drift apart unnoticed.
 */
export const captureRxSchema: RxJsonSchema<CaptureDocument> = {
  version: CAPTURE_DOCUMENT_VERSION,
  primaryKey: "id",
  type: "object",
  properties: {
    id: { type: "string", maxLength: 64 },
    seq: { type: "number", minimum: 0, maximum: 1_000_000_000, multipleOf: 1 },
    status: { type: "string", maxLength: 16 },
    sessionId: { type: "string", maxLength: 64 },
    attempts: { type: "integer", minimum: 0 },
    nextAttemptAt: { type: "string", maxLength: 32 },
    enqueuedAt: { type: "string", maxLength: 32 },
    lastError: { type: "string" },
    recording: { type: "object" },
    transcript: { type: "object" },
    capture: { type: "object" },
    preview: { type: "object" },
    // Migration-only carrier: the v5 session-level fields, held on the recording
    // by the v6 (expand) migration until `backfillSessions` lifts them onto a
    // session document and clears it. Transient — no row keeps it past the open
    // that migrated it. See `CAPTURE_MIGRATION_STRATEGIES`.
    legacy: { type: "object" },
  },
  required: [
    "id",
    "seq",
    "status",
    "sessionId",
    "attempts",
    "nextAttemptAt",
    "enqueuedAt",
    "recording",
  ],
  indexes: ["seq"],
  attachments: {},
};

/**
 * Schema-migration strategies for the sessions collection, keyed by the version
 * being migrated *to*.
 *
 * v0 → v1 added `extractionUsage` (optional) — what the extraction cost and
 * which strategy produced it. The strategy is **identity**: an absent optional
 * field needs no transformation, and a session written before extraction usage
 * was carried has none to record, which is the correct state for it.
 *
 * v1 → v2 added `receipts` (optional) and backfills `reviewOutcome.instanceKeys`
 * for pre-existing accepted/edited outcomes that predate the field. `receipts`
 * is left absent — v1 documents never had writes with returned uuids.
 * `instanceKeys` is synthesised as `["k1", …, "kN"]` per non-empty collection
 * group, matching what `resolveReview` would have produced had the field existed.
 * This is the schema version the sibling `roster-absence` plan's Task 3 also
 * extends (adding `statedEmptyGroups`) — a reader who lands there first should
 * know this v2 schema isn't "finished" the moment this task's commit lands.
 *
 * v2 → v3 added `skippedItems` (optional) — the per-item report of what an
 * `onItemFailure: "skip"` policy gave up on, so review can tell an
 * engine-written abstention from a genuine one (ADR 0026's deferred next step).
 * The strategy is **identity**: an absent optional field is the correct state
 * for every pre-existing session. ADR 0026's same reasoning about optionality
 * not removing the bump applies — see it below.
 *
 * **An optional addition still needs the bump, and the stake is the captures.**
 * RxDB validates the declared schema against the one the collection was created
 * with, so adding a property at the same version is refused at `addCollections`
 * — and `openOutboxDatabase` adds `storage` and `sessions` in ONE call on ONE
 * database. A `DB6` on this collection therefore rejects the whole open, so the
 * storage is unreachable too: an auditor's captured items and their audio (or
 * document) attachments, on a device, with no way in. The only recovery a host could offer
 * is clearing the origin's IndexedDB, which destroys exactly the field work the
 * storage exists to protect. That is not a migration, and "the new field is
 * optional so no data needs transforming" does not reach it — that answers the
 * data question and leaves the schema question unasked. This is the same
 * reasoning `CAPTURE_MIGRATION_STRATEGIES` records for its own identity steps
 * (v1→v2, v2→v3, v3→v4 `extractedBy`, v4→v5): declared and exercised rather
 * than skipped, so the migration path exists and is proven to run.
 */
export const SESSION_MIGRATION_STRATEGIES = toMigrationStrategies(SESSION_DOCUMENT_UPGRADES);

export const sessionRxSchema: RxJsonSchema<SessionDocument> = {
  version: SESSION_DOCUMENT_VERSION,
  primaryKey: "id",
  type: "object",
  properties: {
    id: { type: "string", maxLength: 64 },
    status: { type: "string", maxLength: 16 },
    openedAt: { type: "string", maxLength: 32 },
    closedAt: { type: "string", maxLength: 32 },
    // Opaque to core — no `maxLength` because RxDB only needs bounded widths
    // for fields it has to encode as sortable index keys, and `ctx` is not
    // indexed.
    ctx: { type: "object" },
    // Indexed, so RxDB needs a bounded width to build sortable index keys.
    ref: { type: "string", maxLength: 128 },
    attempts: { type: "integer", minimum: 0 },
    nextAttemptAt: { type: "string", maxLength: 32 },
    lastError: { type: "string" },
    extracted: { type: "object" },
    // Not indexed, so no `maxLength` is required — RxDB only needs bounded
    // widths for fields it has to encode as sortable index keys.
    extractedBy: { type: "string" },
    extractionUsage: { type: "object" },
    extractedFromRecordingIds: { type: "array" },
    reviewOutcome: { type: "object" },
    writeResult: { type: "object" },
    receipts: { type: "object" },
    statedEmptyGroups: { type: "object" },
    skippedItems: { type: "array" },
    idempotencyKey: { type: "string", maxLength: 64 },
  },
  required: [
    "id",
    "status",
    "openedAt",
    "ctx",
    "ref",
    "attempts",
    "nextAttemptAt",
    "idempotencyKey",
  ],
  // `openedAt` so a UI can list sessions oldest-first without a post-sort;
  // `ref` so "the session(s) for this job" is a real query, not a scan.
  indexes: ["openedAt", "ref"],
  // Presence of this key is what enables attachments at all — omit it and
  // `putAttachment` throws. The sessions collection has no attachments today,
  // but enabling the flag now means adding one later is a schema-property edit,
  // not a version bump + migration.
  attachments: {},
};

/** Schema-migration strategies for the key-value collection. */
export const PLUGIN_STORAGE_MIGRATION_STRATEGIES = toMigrationStrategies(
  PLUGIN_STORAGE_DOCUMENT_UPGRADES,
);

/**
 * The RxDB JSON schema for the key-value collection.
 *
 * Hand-written for the same reason the other two schemas are: RxDB needs
 * metadata zod has no concept of — `primaryKey`, `indexes`, and the `maxLength`
 * bounds it uses to build fixed-width index keys.
 *
 * Version 1 generalised the scope: `captureId`/`pluginId` became
 * `scopeKind`/`scopeId`/`owner`, so an entry can belong to a session as well as
 * a capture. See `PLUGIN_STORAGE_MIGRATION_STRATEGIES` above for why the bump
 * was required even with nothing on disk depending on it.
 */
export const pluginStorageRxSchema: RxJsonSchema<PluginStorageDocument> = {
  version: PLUGIN_STORAGE_DOCUMENT_VERSION,
  primaryKey: "id",
  type: "object",
  properties: {
    id: { type: "string", maxLength: 512 },
    scopeKind: { type: "string", maxLength: 8 },
    scopeId: { type: "string", maxLength: 64 },
    owner: { type: "string", maxLength: 128 },
    key: { type: "string", maxLength: 256 },
    value: { type: "string" },
  },
  required: ["id", "scopeKind", "scopeId", "owner", "key", "value"],
  // `[scopeKind, scopeId]` so a sweep (which deletes every entry for a dropped
  // capture, or for a removed session) is an index lookup rather than a scan.
  // The compound with `owner` serves `keys()` and per-owner reads.
  indexes: [["scopeKind", "scopeId"], ["scopeKind", "scopeId", "owner"], ["owner"]],
  attachments: {},
};
