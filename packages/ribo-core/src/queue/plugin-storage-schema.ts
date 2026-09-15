import type { RxJsonSchema } from "rxdb";
import { z } from "zod";

/** The RxDB collection name for plugin-scoped storage. Sits beside `outbox` and `sessions` in the same database. */
export const PLUGIN_STORAGE_COLLECTION_NAME = "pluginStorage";

/**
 * One key-value entry in a plugin's namespaced storage, scoped to a capture.
 *
 * The value is a JSON string: the handle serialises on write and deserialises
 * on read, so a plugin can store any JSON-serialisable value (a document id, a
 * cached upload handle, page annotations) without core learning what it is.
 *
 * The primary key is a composite of `pluginId`, `captureId` and `key`, joined
 * by null bytes — see {@link pluginStorageEntryId}. Null bytes do not appear in
 * package names, UUIDs or human-chosen keys, so the join is collision-safe
 * without escaping.
 */
export const pluginStorageDocumentSchema = z.strictObject({
  // The bounds mirror `pluginStorageRxSchema` below, and are load-bearing rather than defensive:
  // RxDB builds fixed-width index keys from those `maxLength`s, so a value that overruns one
  // corrupts index ordering rather than failing loudly. Rejecting at the zod boundary turns that
  // into an error the caller can read, at the call that caused it.
  id: z.string().min(1).max(512),
  captureId: z.string().min(1).max(64),
  pluginId: z.string().min(1).max(128),
  key: z.string().min(1).max(256),
  value: z.string(),
});

/** Inferred from {@link pluginStorageDocumentSchema} — never hand-declared alongside it. */
export type PluginStorageDocument = z.infer<typeof pluginStorageDocumentSchema>;

/**
 * Schema-migration strategies for the plugin-storage collection.
 *
 * The collection starts at version 0, so no strategies are needed yet. When a
 * future change adds or removes a field, the version bumps and a strategy is
 * added here — the same pattern `OUTBOX_MIGRATION_STRATEGIES` and
 * `SESSION_MIGRATION_STRATEGIES` follow. Declared and exported rather than
 * inlined so a test can exercise it directly.
 */
export const PLUGIN_STORAGE_MIGRATION_STRATEGIES: Record<string, (doc: unknown) => unknown> = {};

/**
 * The RxDB JSON schema for the plugin-storage collection.
 *
 * Hand-written for the same reason the other two schemas are: RxDB needs
 * metadata zod has no concept of — `primaryKey`, `indexes`, and the `maxLength`
 * bounds it uses to build fixed-width index keys.
 *
 * Version 0: the collection is new, so there is nothing to migrate from. An
 * existing user opening the database with this code for the first time gets the
 * collection created transparently — `addCollections` handles that, and no
 * version bump on the sibling collections is required.
 */
export const pluginStorageRxSchema: RxJsonSchema<PluginStorageDocument> = {
  version: 0,
  primaryKey: "id",
  type: "object",
  properties: {
    id: { type: "string", maxLength: 512 },
    captureId: { type: "string", maxLength: 64 },
    pluginId: { type: "string", maxLength: 128 },
    key: { type: "string", maxLength: 256 },
    value: { type: "string" },
  },
  required: ["id", "captureId", "pluginId", "key", "value"],
  // `captureId` so the sweep (which deletes every entry for a dropped or
  // discarded capture) is an index lookup, not a scan. The compound
  // `[captureId, pluginId]` serves `keys()` and per-plugin reads.
  indexes: ["captureId", ["captureId", "pluginId"]],
  attachments: {},
};

/**
 * Build the deterministic primary key for one plugin-storage entry.
 *
 * Null-byte delimiters are collision-safe: package names, UUID capture ids and
 * human-chosen keys do not contain `\x00`, so `pluginA:cap1:k` and
 * `plugin:capA:k1` can never produce the same composite.
 */
export function pluginStorageEntryId(captureId: string, pluginId: string, key: string): string {
  return `${pluginId}\x00${captureId}\x00${key}`;
}
