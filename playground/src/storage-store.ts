import { messageOf } from "./format.js";

/**
 * @file Storage persistence and headroom — Phase 2.5, Task 3.
 *
 * ## What this is asking for, and what it is not
 *
 * `navigator.storage.persist()` is a **request**. The browser answers it, and
 * the answer is frequently no. Everything in this file exists so the page can
 * report the answer it actually received rather than the one it wanted: a UI
 * that says "safe" after a refused request is lying to a field auditor about
 * whether their recordings will still be there tomorrow, and that is the one
 * failure mode this module is written to make impossible.
 *
 * `docs/implementation/09-offline-first.md` §"iOS Safari constraints" is the
 * authority. Two of its four constraints land here:
 *
 * - **The 7-day ITP sweep takes IndexedDB and Cache together.** Without a
 *   persistence grant the queue and the precached shell vanish in one go, so
 *   "not persistent" is not a cosmetic warning — it is the expected iOS path.
 * - **Quota is percentage-of-disk and device-dependent** (Safari 17+). Phase 3
 *   downloads a 40–150 MB speech model, and `estimate()` is how we find out
 *   there is no room *before* starting rather than 90 MB in.
 *
 * ## `persisted()` and `persist()` are different questions
 *
 * `persisted()` asks what is already true; `persist()` asks for a change. They
 * are kept apart below because they have different costs and different
 * meanings. A grant carried over from an earlier visit is not the same event as
 * one just granted, and on browsers where `persist()` can raise a permission
 * prompt, asking when the answer is already yes is a prompt shown for nothing.
 *
 * ## The store shape
 *
 * Same pattern as `update-store.ts`: a module singleton, a listener set, and a
 * `getStorageState` that returns a stable object identity so
 * `useSyncExternalStore` does not loop. Deliberately not a second style for the
 * same kind of app-level concern.
 */

/** The answer the browser actually gave. */
export type PersistenceStatus =
  /** The request is in flight. */
  | "checking"
  /** No `navigator.storage.persist` — the question cannot even be asked. */
  | "unsupported"
  /** `persisted()` was already `true`; nothing was re-requested. */
  | "already-persistent"
  /** `persist()` returned `true`. */
  | "granted"
  /** `persist()` returned `false`. The browser said no. */
  | "denied"
  /** The call threw. Treat as not persistent. */
  | "error";

export interface StorageHeadroom {
  readonly usageBytes: number;
  readonly quotaBytes: number;
  /** `quota - usage`. Precomputed so the UI cannot get the subtraction wrong. */
  readonly freeBytes: number;
}

export interface StorageState {
  readonly persistence: PersistenceStatus;
  /** Present when `persistence` is `"error"`. */
  readonly message?: string;
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

let state: StorageState = { persistence: "checking", estimated: false };

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

let started = false;

/**
 * Request persistence and take a first quota reading.
 *
 * Idempotent, so StrictMode's double mount asks the browser once. Called from
 * `StoragePanel` for the same reason `startServiceWorker` is called from
 * `UpdatePanel`: the component that reports the outcome is the component that
 * triggers it, so the report can never describe a request that never happened.
 */
export function startStorage(): void {
  if (started) return;
  started = true;
  void requestPersistence().then(() => refreshEstimate());
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

async function requestPersistence(): Promise<void> {
  // Feature-detected on the *methods*, not on `navigator.storage`: Safari
  // shipped `estimate()` before `persist()`, so the object existing proves
  // nothing about the call we are about to make.
  if (typeof navigator.storage?.persist !== "function") {
    setState({ ...state, persistence: "unsupported" });
    return;
  }

  try {
    // Ask what is already true before asking for a change.
    if (await navigator.storage.persisted()) {
      setState({ ...state, persistence: "already-persistent" });
      return;
    }
    const granted = await navigator.storage.persist();
    setState({ ...state, persistence: granted ? "granted" : "denied" });
  } catch (cause: unknown) {
    setState({ ...state, persistence: "error", message: messageOf(cause) });
  }
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
