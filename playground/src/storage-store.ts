/**
 * @file Storage headroom — Phase 2.5, Task 3.
 *
 * The persistence *grant* — `navigator.storage.persisted()` /
 * `.persist()` — used to live here too, as a module singleton with its own
 * `PersistenceStatus` and a `startStorage()` entry point `StoragePanel` called
 * on mount. `@azx/ribo-ui-react`'s `useStoragePersistence()` replaced it (see
 * `StoragePanel.tsx`'s own doc comment): every caller of that hook shares ONE
 * module-level store, so a grant made in one panel is visible to
 * `useWorkSafety()`'s verdict without either side re-reading `navigator.storage`
 * on its own — which this file's per-caller version could not offer. What
 * remains here is what the hook does not replace: the quota/usage estimate
 * Phase 3's model download needs to warn about, which has no counterpart in the
 * hook's return value.
 *
 * `docs/implementation/09-offline-first.md` §"iOS Safari constraints" is the
 * authority for why this matters at all: quota is percentage-of-disk and
 * device-dependent (Safari 17+), Phase 3 downloads a 40–150 MB speech model,
 * and `estimate()` is how we find out there is no room *before* starting rather
 * than 90 MB in.
 *
 * ## The store shape
 *
 * Same pattern as `update-store.ts`: a module singleton, a listener set, and a
 * `getStorageState` that returns a stable object identity so
 * `useSyncExternalStore` does not loop. Deliberately not a second style for the
 * same kind of app-level concern.
 */

export interface StorageHeadroom {
  readonly usageBytes: number;
  readonly quotaBytes: number;
  /** `quota - usage`. Precomputed so the UI cannot get the subtraction wrong. */
  readonly freeBytes: number;
}

export interface StorageState {
  /** Absent when `estimate()` is unsupported or returned partial numbers. */
  readonly headroom?: StorageHeadroom;
  /** True once an estimate has been attempted, whatever the outcome. */
  readonly estimated: boolean;
}

/**
 * The upper end of the Phase 3 Whisper model download (40–150 MB, per `09`).
 *
 * The *upper* end on purpose. A headroom check that passes for the small model
 * and fails for the large one has told the user nothing they can act on.
 */
export const MODEL_HEADROOM_BYTES = 150 * 1024 * 1024;

let state: StorageState = { estimated: false };

const listeners = new Set<() => void>();

function setState(next: StorageState): void {
  state = next;
  for (const listener of listeners) listener();
}

/** Subscribe to state changes. Returns its own unsubscribe handle. */
export function subscribeToStorage(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The current state, stable by identity until something changes. */
export function getStorageState(): StorageState {
  return state;
}

/** Whether the reported headroom clears the Phase 3 model download. */
export function hasModelHeadroom(headroom: StorageHeadroom | undefined): boolean | undefined {
  return headroom === undefined ? undefined : headroom.freeBytes >= MODEL_HEADROOM_BYTES;
}

/**
 * Re-read `estimate()`.
 *
 * Exposed because headroom is not a constant: every capture consumes some of
 * it, and the number that mattered at boot is the wrong number by the time
 * anyone is deciding whether to prime a model.
 */
export async function refreshEstimate(): Promise<void> {
  setState({ ...state, ...(await readEstimate()) });
}

async function readEstimate(): Promise<Pick<StorageState, "headroom" | "estimated">> {
  if (typeof navigator.storage?.estimate !== "function") return { estimated: true };
  try {
    const { usage, quota } = await navigator.storage.estimate();
    // Both fields are optional in the spec and genuinely absent on some
    // browsers. A missing quota with a present usage cannot be turned into
    // headroom, so it is reported as "no estimate" rather than as zero free.
    if (usage === undefined || quota === undefined) return { estimated: true };
    return {
      estimated: true,
      headroom: { usageBytes: usage, quotaBytes: quota, freeBytes: Math.max(quota - usage, 0) },
    };
  } catch {
    return { estimated: true };
  }
}
