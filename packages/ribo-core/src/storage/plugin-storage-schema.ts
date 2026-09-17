import { z } from "zod";

/** The RxDB collection name for plugin-scoped storage. Sits beside `storage` and `sessions` in the same database. */
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
 * Build the deterministic primary key for one plugin-storage entry.
 *
 * Null-byte delimiters are collision-safe: package names, UUID capture ids and
 * human-chosen keys do not contain `\x00`, so `pluginA:cap1:k` and
 * `plugin:capA:k1` can never produce the same composite.
 */
export function pluginStorageEntryId(captureId: string, pluginId: string, key: string): string {
  return `${pluginId}\x00${captureId}\x00${key}`;
}
