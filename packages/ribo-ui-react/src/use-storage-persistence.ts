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

/**
 * A draft merged into the shared snapshot by {@link publish}. Every field is
 * OPTIONAL and none is `readonly` (unlike `Partial<StorageSnapshot>`, which
 * would preserve `StorageSnapshot`'s `readonly` modifiers and reject
 * assignment into a draft — see `readStorage` below). Optional so a field can
 * be genuinely OMITTED rather than merely set to a fallback value: `publish`'s
 * `{ ...snapshot, ...next }` merge only overwrites fields actually present on
 * `next`, so omitting a field is how a caller says "I don't have a new answer
 * for this one, leave whatever was already known." That distinction is the
 * whole fix for the data-loss bug this type exists to prevent: a transient
 * read failure must produce a draft that OMITS the failed field, not one that
 * fills it with a guess like `"unknown"` or `undefined`, because either guess
 * would silently overwrite a previously known-good value.
 */
interface StorageSnapshotDraft {
  persistence?: StoragePersistence;
  estimate?: StorageEstimate;
}

// One snapshot per origin, shared by every caller. Module scope rather than a
// context value because it describes the browser, not a subtree — and because a
// cached snapshot object is what keeps `useSubscribed` from re-rendering forever.
let snapshot: StorageSnapshot = { persistence: "unknown", estimate: undefined };
const listeners = new Set<(value: StorageSnapshot) => void>();

const publish = (next: StorageSnapshotDraft): void => {
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
 * nobody has asked about — so a `false` read must never assert `denied` itself.
 * But it must not assert `unknown` either: `next.persistence` is left UNSET on
 * `false`, not set to `"unknown"`, for exactly the reason the catch block below
 * leaves its own field unset on a thrown read. `false` is ambiguous between
 * "never asked" and "a real `persist()` call was refused", and only
 * {@link UseStoragePersistenceResult.request} — which sees `persist()`'s own
 * return value — can tell the two apart. `publish`'s merge only overwrites a
 * field actually present on the draft, and the module's own default snapshot is
 * already `"unknown"` before anything has asked, so omitting here loses no
 * information for that case; setting it explicitly, as this used to, would
 * re-assert "unknown" over an ALREADY-KNOWN `"denied"` on every subsequent
 * `refresh()` — which happens on every mount of every component calling this
 * hook, not just the one that requested — silently reverting an explicit
 * refusal back to "still checking" forever, the first time a second consumer
 * (e.g. `useWorkSafety`, alongside a component that itself calls `request()`)
 * mounts after the request settles.
 */
const readStorage = async (): Promise<StorageSnapshotDraft> => {
  if (typeof navigator === "undefined" || navigator.storage?.persisted === undefined) {
    return { persistence: "unsupported" };
  }
  const next: StorageSnapshotDraft = {};
  try {
    if (await navigator.storage.persisted()) next.persistence = "granted";
  } catch {
    // A Storage API that exists and throws is not the same as one that is
    // absent, but neither tells us the grant. Crucially, this must NOT set
    // `next.persistence = "unknown"`: a transient rejection here would then
    // overwrite a previously known-good "granted" (or "denied") value with
    // "unknown" the moment `publish` merges this draft in, telling a user who
    // already granted persistence that their device just became unprotected.
    // Leaving the field unset means `publish`'s merge skips it entirely,
    // keeping whatever was last known.
  }
  try {
    next.estimate = await navigator.storage.estimate?.();
  } catch {
    // Same reasoning: a failed estimate read must not erase the last usable
    // estimate by publishing `undefined` over it. Leave the field unset.
  }
  return next;
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
    // Same guard as `readStorage`: outside a browser (or a runtime with no
    // global `navigator`), referencing the bare identifier throws a
    // `ReferenceError` before the property access ever runs. Checking
    // `typeof navigator` first keeps `request()` resolving `"unsupported"`
    // the way `readStorage()` already does, rather than throwing.
    if (typeof navigator === "undefined" || navigator.storage?.persist === undefined) {
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
