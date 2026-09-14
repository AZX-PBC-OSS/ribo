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
  get<T = unknown>(key: string): Promise<T | undefined>;
  /** Write one key, overwriting any prior value. */
  set(key: string, value: unknown): Promise<void>;
  /** Delete one key. Silently succeeds if the key does not exist. */
  delete(key: string): Promise<void>;
  /** Every key this plugin has written for this capture, sorted. */
  keys(): Promise<string[]>;
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
