import { createPluginStorage, createPluginStorageScope } from "./plugin-storage.js";
import type { PluginStorage, PluginStorageScope } from "./plugin-storage.js";
import type { StorageBackend } from "./port.js";

/**
 * @file The key-value store: namespaced, scope-bound storage a plugin or a host
 * writes through.
 *
 * The third thing the old `Outbox` class fronted, and the one that was never an
 * outbox in any sense. A declared store is a *namespace*, not a collection —
 * every entry lives in the port's one `entries` collection, distinguished by its
 * owner and its scope, which is why adding a store costs the backend nothing.
 */

/** A store's handle, scoped to one owner. Reached as `storage.store(owner)`. */
export interface Store {
  /** This owner's namespace for one capture. Entries die when the capture does. */
  capture: (captureId: string) => PluginStorage;
  /**
   * Every capture this owner has at least one entry for, sorted. Live, so a
   * capture whose entries have been swept drops out.
   */
  captures: () => Promise<string[]>;
}

/**
 * Create a {@link Store} for one owner.
 *
 * The owner is conventionally a package name — two packages that name themselves
 * differently cannot read or clobber each other's keys, and nothing enforces the
 * convention beyond that.
 */
export function createStore(backend: StorageBackend, owner: string): Store {
  return createPluginStorageScope(backend, owner);
}

/** One capture's namespace, with the owner supplied later. */
export interface CaptureScopedStore {
  forPlugin: (owner: string) => PluginStorage;
}

/** One capture's namespace for one owner, for a caller holding both ids already. */
export function createScopedStore(
  backend: StorageBackend,
  captureId: string,
  owner: string,
): PluginStorage {
  return createPluginStorage(backend, captureId, owner);
}

/**
 * Delete every entry belonging to any of these captures.
 *
 * The sweep. Called from the four places a capture leaves storage — removal,
 * bulk removal, clearing, and a patch to `discarded` — so a plugin never cleans
 * up after itself and forgetting to cannot leak.
 *
 * A free function rather than a method because the capture store is what knows a
 * capture has gone, and the entries store is what knows how entries are keyed;
 * making it a method of either would give one of them a reason to hold the other.
 */
export async function sweepCaptureEntries(
  backend: StorageBackend,
  captureIds: readonly string[],
): Promise<void> {
  if (captureIds.length === 0) return;
  // One query for the whole batch, which is why the port's entry finder takes a
  // set of scope ids: clearing a thirty-row queue would otherwise be thirty round
  // trips on the "reset this device" path.
  const entries = await backend.find("entries", {
    scopeKind: "capture",
    scopeId: captureIds,
  });
  if (entries.length === 0) return;
  await backend.removeMany(
    "entries",
    entries.map((entry) => entry.id),
  );
}

export type { PluginStorage, PluginStorageScope };
