import {
  createConnectivity,
  type Connectivity,
  type ConnectivityState,
  type Unsubscribe,
} from "@azx/ribo-core";

/**
 * @file One {@link Connectivity} model per page load, wired to the real browser
 * and exposed to React as a `useSyncExternalStore` source.
 *
 * ## Why a singleton, carried across HMR
 *
 * Same discipline as `recorder-handle.ts` and `outbox-handle.ts`: a second model
 * would bind a *second* set of `online`/`offline`/`visibilitychange` listeners
 * and start a *second* probe cycle, and StrictMode's double mount plus Vite's
 * module replacement both otherwise produce exactly that. `import.meta.hot.data`
 * carries the one live instance — with its bound listeners and in-flight state —
 * across an edit to this file, so the model is never re-`start()`ed and its
 * listeners are never stacked.
 *
 * On HMR the module *subscription* (this file's own listener on the model) is the
 * only thing torn down and re-established; the model itself is left running. See
 * the `hot.dispose` at the bottom.
 *
 * ## The injected deps (the model is headless; the browser lives here)
 *
 * `ribo-core` never reaches for `window`/`navigator`/`document` — that is its
 * rule (AGENTS.md §4), and it is what makes this file the single place the DOM is
 * touched. We supply:
 *
 * - **`bindEvents`** — `window` `online`/`offline` for the link-layer edges, plus
 *   `document` `visibilitychange`, the model's cheap recovery hook: returning to a
 *   backgrounded tab re-evaluates reachability without polling.
 * - **`isOnline`** — `navigator.onLine`, trusted only when it says `false` (the
 *   model never trusts a bare `true` without a probe).
 * - **`probe`** — see {@link probe} below.
 *
 * Timers fall through to the model's `setTimeout`/`clearTimeout` default.
 *
 * ## The store shape
 *
 * A listener set and a `getConnectivityState` that returns a **stable object
 * identity** until the status actually changes — the model already pushes one
 * object per transition, so caching the latest push is all it takes. A fresh
 * object per call would loop `useSyncExternalStore`. Same shape as
 * `update-store.ts` / `storage-store.ts`, deliberately not a second style.
 */

/**
 * The reachability probe: a lightweight **same-origin** request that honours the
 * abort signal.
 *
 * `HEAD` first (a few bytes, no body); some static servers answer `HEAD` with
 * `405`, so a non-ok HEAD falls back to `GET` before the model is told anything.
 * A thrown error or an abort propagates and the model reads it as `offline`.
 *
 * The target is the document root `"/"` — it 200s under **both** `vite` dev and
 * `vite preview` (a static preview server has no API route to hit, so anything
 * app-specific would 404 there). `cache: "no-store"` keeps the HTTP cache out of
 * it.
 *
 * NOTE — in the real field app this probe target becomes the **Helix gateway
 * health path** (still an open question, not decided here). One honest caveat of
 * probing a same-origin *precached* URL: once the service worker is active, `"/"`
 * is served from the Cache API and so answers 200 even with the network cut — so
 * this demo's probe can read `online` while offline. The field probe hits the
 * gateway over the network precisely so it cannot be answered from cache.
 */
async function probe(signal: AbortSignal): Promise<Response> {
  const head = await fetch("/", { method: "HEAD", cache: "no-store", signal });
  if (head.ok) return head;
  return fetch("/", { method: "GET", cache: "no-store", signal });
}

function bindEvents(onChange: () => void): () => void {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  document.addEventListener("visibilitychange", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
    document.removeEventListener("visibilitychange", onChange);
  };
}

interface HotData {
  connectivity?: Connectivity;
}

const hotData = import.meta.hot?.data as HotData | undefined;

let model: Connectivity | undefined = hotData?.connectivity;

/** The shared connectivity model, constructing and `start()`ing it on first call. */
function getConnectivity(): Connectivity {
  if (!model) {
    model = createConnectivity({
      bindEvents,
      isOnline: () => navigator.onLine,
      probe,
    });
    model.start();
  }
  if (hotData) hotData.connectivity = model;
  return model;
}

const listeners = new Set<() => void>();

// The latest state the model pushed, held so `getConnectivityState` can return a
// stable identity between changes.
let cachedState: ConnectivityState = getConnectivity().state;

// This module's single subscription to the model. Detached on HMR dispose so a
// replacement module does not stack a second listener on the carried instance.
let modelUnsub: Unsubscribe | undefined = getConnectivity().subscribe((state) => {
  cachedState = state;
  for (const listener of listeners) listener();
});

/** Subscribe to connectivity changes. Returns its own unsubscribe handle. */
export function subscribeToConnectivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The current connectivity state, stable by identity until the status changes. */
export function getConnectivityState(): ConnectivityState {
  return cachedState;
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    // Detach only *this* module's listener. The model stays live in `hot.data`
    // with its event listeners intact — re-`start()`ing or re-binding it is the
    // leak this whole file is arranged to avoid.
    modelUnsub?.();
    modelUnsub = undefined;
  });
}
