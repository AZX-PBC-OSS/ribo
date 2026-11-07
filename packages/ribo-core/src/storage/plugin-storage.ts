import type { StorageBackend, StoredDocument } from "./port.js";
import { pluginStorageDocumentSchema, pluginStorageEntryId } from "./plugin-storage-schema.js";
import type { EntryScopeKind } from "./port.js";

/**
 * A namespaced, capture-scoped key-value handle a plugin writes through.
 *
 * The handle bakes in a `captureId` and `pluginId`, so every operation is
 * automatically scoped — a plugin cannot accidentally read or overwrite
 * another plugin's keys, or its own keys from a different capture. Core
 * deletes every entry for a capture when the capture is dropped or discarded;
 * the plugin never sweeps itself.
 *
 * Values are JSON-serialisable. The handle stores them as JSON strings so any
 * shape — a document id, an array of page annotations, a nested object —
 * survives without core learning what it is.
 *
 * **Durable, not in-memory.** Entries live in the same storage backend as the
 * captures and sessions, so they survive a close-and-reopen and are visible to
 * a different tab — the port requires both of any backend. That is the whole reason this exists: the two halves of a
 * plugin (a transcriber and an extractor from the same package) may run in
 * different tabs, minutes apart, and anything held in a module variable or a
 * class field is invisible to the second half.
 * @category Plugin Storage
 */
export interface PluginStorage {
  /** Read one key, or `undefined` if it was never set (or has been swept). */
  get: <T = unknown>(key: string) => Promise<T | undefined>;
  /** Write one key, overwriting any prior value. */
  set: (key: string, value: unknown) => Promise<void>;
  /** Delete one key. Silently succeeds if the key does not exist. */
  delete: (key: string) => Promise<void>;
  /** Every key this plugin has written for this capture, sorted. */
  keys: () => Promise<string[]>;
}

/**
 * Create a {@link PluginStorage} handle scoped to one capture and one plugin.
 *
 * Called by {@link Storage.scopedStore}; not intended for direct construction
 * by plugins. The handle holds no state beyond the scoping ids and the
 * collection reference, so a fresh handle over the same database sees the same
 * entries — durability comes from the storage, not from the handle.
 * @category Plugin Storage
 */
export function createPluginStorage(
  backend: StorageBackend,
  captureId: string,
  pluginId: string,
): PluginStorage {
  return new PluginStorageHandle(backend, "capture", captureId, pluginId);
}

/**
 * Storage scoped to **one capture**, with the plugin yet to name itself.
 *
 * This is what the relay puts in `TranscribeOptions.storage`: the relay knows
 * the capture being transcribed but cannot know which engine a selection
 * combinator (`firstCapable`, `fallbackTranscriber`, `hedged`) will pick, so
 * the capture is baked in here and the plugin dimension is supplied by the
 * transcriber — its own `engine` id is the natural choice, and two transcribers
 * that name themselves differently cannot read or clobber each other's keys.
 *
 * Like every handle over plugin storage this is a view over the storage
 * backend: durable, visible to other tabs, and bound to the storage
 * instance that minted it — a closed storage's handles are dead; reopen and
 * re-mint (a fresh handle over the same database reads what a prior one wrote).
 * @category Plugin Storage
 */
export interface CaptureStorageScope {
  /** This plugin's namespace for this capture. */
  forPlugin: (pluginId: string) => PluginStorage;
}

/**
 * Storage scoped to **one plugin**, across every capture it has entries for.
 *
 * This is the **construction-time** handle for an extractor: a host building an
 * extractor knows which plugin it is building — the identity the `Extractor`
 * contract itself lacks (`engine` appears on the result, after the call, so the
 * relay cannot scope a handle for the plugin it invokes) — so the pluginId is
 * baked in here and the capture dimension is addressed per call. An extractor
 * runs over a session joined from several captures, so its sibling transcriber's
 * per-capture writes are reached one capture at a time through
 * {@link PluginStorageScope.capture}, with the captures discovered through
 * {@link PluginStorageScope.captures}.
 *
 * **What a plugin author can rely on:**
 *
 * - **Durability.** Entries live in the same storage backend as the captures
 *   and survive a close-and-reopen — the two halves of a plugin may run in
 *   different tabs, minutes apart.
 * - **Isolation.** The scope bakes in one pluginId; no other plugin's entries
 *   are reachable through it, and each per-capture handle is scoped to
 *   `(pluginId, captureId)`.
 * - **Live reads.** Every call queries storage; nothing is cached in the
 *   handle. A capture whose entries core has swept (the capture was dropped or
 *   discarded) drops out of `captures()` and reads `undefined` — a reader never
 *   holds a stale view of swept state, even the same scope instance across the
 *   sweep.
 *
 * **What a plugin author cannot rely on:**
 *
 * - **Session bounding.** The scope is not scoped to a session:
 *   `captures()` enumerates every capture this plugin has unswept entries for,
 *   across sessions, and there is no handle for "this session's captures" —
 *   an extraction sees only the joined transcript, so core cannot bound the
 *   enumeration to it either. A plugin that needs session correlation encodes
 *   it in its own keys or values. The lifecycle is the **sweep**, not the
 *   session: entries live exactly as long as their capture does.
 * @category Plugin Storage
 */
export interface PluginStorageScope {
  /** This owner's namespace for one capture. Entries die when the capture does. */
  capture: (captureId: string) => PluginStorage;
  /**
   * Every capture this owner has at least one stored entry for, sorted. Live, so
   * swept captures drop out.
   */
  captures: () => Promise<string[]>;
}

/**
 * Create a {@link CaptureStorageScope} over one capture. Called by {@link Storage.captureStore}.
 *
 * @category Plugin Storage
 */
export function createCaptureStorageScope(
  backend: StorageBackend,
  captureId: string,
): CaptureStorageScope {
  return {
    forPlugin: (pluginId) => createPluginStorage(backend, captureId, pluginId),
  };
}

/**
 * Create a {@link PluginStorageScope} over one plugin. Called by {@link Storage.store}.
 *
 * @category Plugin Storage
 */
export function createPluginStorageScope(
  backend: StorageBackend,
  pluginId: string,
): PluginStorageScope {
  return {
    capture: (captureId) => createPluginStorage(backend, captureId, pluginId),
    captures: async () => {
      const entries = await backend.find("entries", { scopeKind: "capture", owner: pluginId });
      return [...new Set(entries.map((entry) => entry.scopeId as string))].sort();
    },
  };
}

/**
 * The general handle: one (kind, scope id, owner) triple over the backend.
 *
 * The scope kind is a parameter even though only capture handles are minted
 * today — the persisted schema carries the kind (plugin storage is at version 1
 * for exactly that), so the handle that writes those documents mirrors it. A
 * session-scoped accessor is deliberately not part of the public surface yet:
 * `SessionStore` has no removal path, so there is nowhere for a session sweep
 * to hook without either leaking entries or sweeping rows a later review round
 * still reads. When one lands, it constructs this class with `"session"`.
 */
class PluginStorageHandle implements PluginStorage {
  readonly #backend: StorageBackend;
  readonly #scopeKind: EntryScopeKind;
  readonly #scopeId: string;
  readonly #owner: string;

  constructor(backend: StorageBackend, scopeKind: EntryScopeKind, scopeId: string, owner: string) {
    this.#backend = backend;
    this.#scopeKind = scopeKind;
    this.#scopeId = scopeId;
    this.#owner = owner;
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const entry = await this.#backend.get("entries", this.#entryId(key));
    if (!entry) return undefined;
    return JSON.parse(entry.value as string) as T;
  }

  async set(key: string, value: unknown): Promise<void> {
    const serialised = JSON.stringify(value);

    // Validate against the persisted contract before writing. The bounds are
    // load-bearing rather than defensive: the backend builds fixed-width index
    // keys from them, so an over-long key corrupts index ordering instead of
    // failing loudly. Parsing here turns that into an error at the call that
    // caused it.
    //
    // Since v1 the schema's field names ARE the port's, so this parses the same
    // document that is written rather than a translation of it.
    const document = pluginStorageDocumentSchema.parse({
      id: this.#entryId(key),
      scopeKind: this.#scopeKind,
      scopeId: this.#scopeId,
      owner: this.#owner,
      key,
      value: serialised,
    });

    await this.#backend.upsert("entries", document satisfies StoredDocument);
  }

  async delete(key: string): Promise<void> {
    await this.#backend.remove("entries", this.#entryId(key));
  }

  async keys(): Promise<string[]> {
    // The finder already orders by key, so nothing is sorted here — and that is
    // the point of pinning the ordering in the port rather than leaving each
    // caller to re-sort and quietly disagree about collation.
    const entries = await this.#backend.find("entries", {
      scopeKind: this.#scopeKind,
      scopeId: this.#scopeId,
      owner: this.#owner,
    });
    return entries.map((entry) => entry.key as string);
  }

  #entryId(key: string): string {
    return pluginStorageEntryId(this.#scopeId, this.#owner, key);
  }
}
