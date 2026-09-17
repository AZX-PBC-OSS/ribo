import { z } from "zod";

/** The collection name on disk. Sits beside `outbox` and `sessions` in the same database. */
export const PLUGIN_STORAGE_COLLECTION_NAME = "pluginStorage";

/** What an entry is scoped to, and therefore what sweeps it. */
export const ENTRY_SCOPE_KINDS = ["capture", "session"] as const;

/**
 * One key-value entry in a namespaced store, scoped to a capture or a session.
 *
 * The value is a JSON string: the handle serialises on write and deserialises on
 * read, so an owner can store any JSON-serialisable value (a document id, a
 * cached upload handle, page annotations) without core learning what it is.
 *
 * ## Why the scope is two fields rather than two optional ids
 *
 * The obvious shape — an optional `captureId` beside an optional `sessionId` —
 * carries an unstated "exactly one is set" invariant that nothing enforces, and
 * RxDB requires an indexed field to be required, so neither could be indexed.
 * A required kind plus a required id indexes cleanly and makes the invariant
 * structural. A third scope kind later costs no further version bump.
 *
 * ## Why the primary key does not encode the kind
 *
 * The key stays `owner ␀ scopeId ␀ key` — exactly what version 0 wrote. Encoding
 * the kind would rewrite every existing row's primary key during the migration,
 * and a primary-key rewrite fails by making rows unreachable rather than by
 * erroring. The cost is that this leans on capture and session ids being drawn
 * from disjoint spaces, which they are: both are `crypto.randomUUID`, plus the
 * deterministic `migrated-session-*` ids. Null bytes do not appear in package
 * names, UUIDs or human-chosen keys, so the join needs no escaping.
 */
export const pluginStorageDocumentSchema = z.strictObject({
  // The bounds mirror the backend's JSON schema and are load-bearing rather than defensive:
  // a storage engine builds fixed-width index keys from those `maxLength`s, so a value that
  // overruns one corrupts index ordering rather than failing loudly. Rejecting at the zod
  // boundary turns that into an error the caller can read, at the call that caused it.
  id: z.string().min(1).max(512),
  scopeKind: z.enum(ENTRY_SCOPE_KINDS),
  scopeId: z.string().min(1).max(64),
  owner: z.string().min(1).max(128),
  key: z.string().min(1).max(256),
  value: z.string(),
});

/** Inferred from {@link pluginStorageDocumentSchema} — never hand-declared alongside it. */
export type PluginStorageDocument = z.infer<typeof pluginStorageDocumentSchema>;

/**
 * Build the deterministic primary key for one entry.
 *
 * Unchanged from version 0 on purpose — see the note above on why the scope kind
 * stays out of the key.
 */
export function pluginStorageEntryId(scopeId: string, owner: string, key: string): string {
  return `${owner}\x00${scopeId}\x00${key}`;
}
