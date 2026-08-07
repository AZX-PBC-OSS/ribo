import type { StoragePersistence, Unsubscribe } from "@azx/ribo-core";
import { useCallback, useEffect } from "react";

import { useSubscribed } from "./use-subscribed.js";

/**
 * The storage-persistence grant and quota estimate, as `workSafety` wants them.
 *
 * The one hook here with no core counterpart: it wraps `navigator.storage`
 * directly and returns core's {@link StoragePersistence} vocabulary. Scoped thin
 * on purpose — `playground/src/storage-store.ts` is 172 lines including eviction
 * detection, and that logic stays in the app. If it should be shared, the right
 * home is a headless core model beside `createConnectivity`, not logic buried in a
 * hook. See the plan's open questions.
 *
 * `unsupported` and `unknown` are different answers and both are needed:
 * `unsupported` means this browser has no Storage API to ask, `unknown` means we
 * have not finished asking. Collapsing them would let a UI claim a device is
 * unprotected while the question is still in flight.
 *
 * ## One module-level store, not per-call state
 *
 * Every caller of this hook subscribes to **one** shared source. With per-hook
 * `useState`, `StoragePanel` and `useWorkSafety` would hold independent copies:
 * the user grants persistence in the panel, that hook updates, and the safety
 * verdict keeps saying `at-risk` from its own stale copy until something else
 * re-renders it. A grant is a property of the origin, not of a component. This
 * hook is not a wrapper around a core subscription source the way
 * `useConnectivity` is — `navigator.storage` has no subscribe API — so the
 * module-level store below is what plays that role instead, fed into
 * `useSubscribed` the same way `Connectivity.subscribe` would be.
 *
 * ## `denied` means refused, not "not yet granted"
 *
 * `work-safety.ts` documents `denied` as an actual refused request. But
 * `navigator.storage.persisted() === false` only means *not currently persisted* —
 * which is also the state before anyone has asked. Reporting that as `denied`
 * would tell `workSafety` a request was refused when none was made. So an
 * un-asked origin reports `unknown`, and `denied` is set only by a `persist()`
 * call that resolved `false`.
 */
export interface UseStoragePersistenceResult {
  readonly persistence: StoragePersistence;
  readonly estimate: StorageEstimate | undefined;
  /** Asks the browser for a persistence grant. Resolves to the resulting state. */
  readonly request: () => Promise<StoragePersistence>;
  /** Re-reads the grant and the estimate. */
  readonly refresh: () => void;
}

interface StorageSnapshot {
  readonly persistence: StoragePersistence;
  readonly estimate: StorageEstimate | undefined;
}

// One snapshot per origin, shared by every caller. Module scope rather than a
// context value because it describes the browser, not a subtree — and because a
// cached snapshot object is what keeps `useSubscribed` from re-rendering forever.
let snapshot: StorageSnapshot = { persistence: "unknown", estimate: undefined };
const listeners = new Set<(value: StorageSnapshot) => void>();

const publish = (next: Partial<StorageSnapshot>): void => {
  snapshot = { ...snapshot, ...next };
  for (const listener of listeners) listener(snapshot);
};

const subscribeToStorage = (listener: (value: StorageSnapshot) => void): Unsubscribe => {
  listeners.add(listener);
  listener(snapshot);
  return () => {
    listeners.delete(listener);
  };
};

/**
 * Reads the grant *without* claiming a refusal.
 *
 * `persisted() === false` means "not persisted", which is also true of an origin
 * nobody has asked about — so it maps to `unknown`, never `denied`. Only
 * {@link UseStoragePersistenceResult.request} can produce `denied`.
 */
const readStorage = async (): Promise<Partial<StorageSnapshot>> => {
  if (typeof navigator === "undefined" || navigator.storage?.persisted === undefined) {
    return { persistence: "unsupported" };
  }
  // Built from locals rather than mutated onto a `Partial<StorageSnapshot>`
  // draft: `StorageSnapshot`'s fields are `readonly`, and `Partial` preserves
  // that modifier, so assigning into the draft object is a type error.
  let persistence: StoragePersistence;
  try {
    persistence = (await navigator.storage.persisted()) ? "granted" : "unknown";
  } catch {
    // A Storage API that exists and throws is not the same as one that is absent,
    // but neither tells us the grant — and guessing here is what would put a wrong
    // answer into workSafety.
    persistence = "unknown";
  }
  let estimate: StorageEstimate | undefined;
  try {
    estimate = await navigator.storage.estimate?.();
  } catch {
    estimate = undefined;
  }
  return { persistence, estimate };
};

export function useStoragePersistence(): UseStoragePersistenceResult {
  const current = useSubscribed(subscribeToStorage, () => snapshot);

  const refresh = useCallback(() => {
    void readStorage().then(publish);
  }, []);

  // Read once per mount. The shared snapshot means later mounts paint the known
  // value immediately instead of flashing `unknown`.
  useEffect(() => {
    refresh();
  }, [refresh]);

  const request = useCallback(async (): Promise<StoragePersistence> => {
    if (navigator.storage?.persist === undefined) {
      publish({ persistence: "unsupported" });
      return "unsupported";
    }
    let granted: StoragePersistence;
    try {
      granted = (await navigator.storage.persist()) ? "granted" : "denied";
    } catch {
      granted = "denied";
    }
    // Published to the shared store, so every consumer — including useWorkSafety —
    // sees the new grant. This is the case per-hook state got wrong.
    publish({ persistence: granted });
    // Refresh the estimate only — NOT via `readStorage()`. `readStorage` maps
    // `persisted() === false` to `unknown` (the right call for an un-asked
    // origin), but right after a real refusal that would immediately clobber
    // the `denied` just published above back to `unknown`. The grant we just
    // learned from `persist()` itself is more authoritative than a follow-up
    // `persisted()` read could be anyway.
    try {
      const estimate = await navigator.storage.estimate?.();
      publish({ estimate });
    } catch {
      // A failed estimate read shouldn't blank out a previously-known one.
    }
    return granted;
  }, []);

  return { ...current, request, refresh };
}
