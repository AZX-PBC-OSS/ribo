import type { RxCollection } from "rxdb";

import {
  pluginStorageDocumentSchema,
  pluginStorageEntryId,
  type PluginStorageDocument,
} from "./plugin-storage-schema.js";

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
 * **Durable, not in-memory.** Entries live in the same RxDB database as the
 * outbox and sessions, so they survive a close-and-reopen and are visible to
 * a different tab. That is the whole reason this exists: the two halves of a
 * plugin (a transcriber and an extractor from the same package) may run in
 * different tabs, minutes apart, and anything held in a module variable or a
 * class field is invisible to the second half.
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

/** The RxDB collection holding plugin-storage entries. */
export type PluginStorageCollection = RxCollection<PluginStorageDocument>;

/**
 * Create a {@link PluginStorage} handle scoped to one capture and one plugin.
 *
 * Called by {@link Outbox.pluginStorage}; not intended for direct construction
 * by plugins. The handle holds no state beyond the scoping ids and the
 * collection reference, so a fresh handle over the same database sees the same
 * entries — durability comes from the storage, not from the handle.
 */
export function createPluginStorage(
  collection: PluginStorageCollection,
  captureId: string,
  pluginId: string,
): PluginStorage {
  return new PluginStorageHandle(collection, captureId, pluginId);
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
 * Like every handle over plugin storage this is a view over the outbox's own
 * RxDB database: durable, visible to other tabs, and bound to the outbox
 * instance that minted it — a closed outbox's handles are dead; reopen and
 * re-mint (a fresh handle over the same database reads what a prior one wrote).
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
 * - **Durability.** Entries live in the same RxDB database as the outbox and
 *   survive a close-and-reopen — the two halves of a plugin may run in
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
 */
export interface PluginStorageScope {
  /** This plugin's namespace for one capture. */
  capture: (captureId: string) => PluginStorage;
  /**
   * Every capture this plugin has at least one stored entry for, sorted. Live,
   * so swept captures drop out.
   */
  captures: () => Promise<string[]>;
}

/** Create a {@link CaptureStorageScope} over one capture. Called by {@link Outbox.captureStorage}. */
export function createCaptureStorageScope(
  collection: PluginStorageCollection,
  captureId: string,
): CaptureStorageScope {
  return {
    forPlugin: (pluginId) => createPluginStorage(collection, captureId, pluginId),
  };
}

/** Create a {@link PluginStorageScope} over one plugin. Called by {@link Outbox.pluginStorageScope}. */
export function createPluginStorageScope(
  collection: PluginStorageCollection,
  pluginId: string,
): PluginStorageScope {
  return {
    capture: (captureId) => createPluginStorage(collection, captureId, pluginId),
    captures: async () => {
      const docs = await collection.find({ selector: { pluginId } }).exec();
      return [...new Set(docs.map((doc) => doc.captureId))].sort();
    },
  };
}

class PluginStorageHandle implements PluginStorage {
  readonly #collection: PluginStorageCollection;
  readonly #captureId: string;
  readonly #pluginId: string;

  constructor(collection: PluginStorageCollection, captureId: string, pluginId: string) {
    this.#collection = collection;
    this.#captureId = captureId;
    this.#pluginId = pluginId;
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const doc = await this.#collection.findOne(this.#entryId(key)).exec();
    if (!doc) return undefined;
    return JSON.parse(doc.value) as T;
  }

  async set(key: string, value: unknown): Promise<void> {
    const document = pluginStorageDocumentSchema.parse({
      id: this.#entryId(key),
      captureId: this.#captureId,
      pluginId: this.#pluginId,
      key,
      value: JSON.stringify(value),
    });
    await this.#collection.incrementalUpsert(document);
  }

  async delete(key: string): Promise<void> {
    const doc = await this.#collection.findOne(this.#entryId(key)).exec();
    await doc?.remove();
  }

  async keys(): Promise<string[]> {
    const docs = await this.#collection
      .find({ selector: { captureId: this.#captureId, pluginId: this.#pluginId } })
      .exec();
    return docs.map((doc) => doc.key).sort();
  }

  #entryId(key: string): string {
    return pluginStorageEntryId(this.#captureId, this.#pluginId, key);
  }
}
