import { createConnectivity, type Connectivity } from "@azx/ribo-core";

/**
 * @file One {@link Connectivity} model per page load, shared by every component.
 *
 * ## Why a singleton, carried across HMR
 *
 * Same discipline as `recorder-handle.ts` and `outbox-handle.ts` — StrictMode's
 * double mount and Vite's module replacement both otherwise produce a second
 * model, which would bind a *second* set of `online`/`offline`/`visibilitychange`
 * listeners and start a *second* probe cycle. `import.meta.hot.data` carries the
 * one live instance — with its bound listeners and in-flight state — across an
 * edit to this file, so the model is never re-`start()`ed and its listeners are
 * never stacked.
 *
 * This file used to also own a `useSyncExternalStore` source (a listener set plus
 * a cached-state getter) for `ConnectivityPanel`, `QueuePanel` and
 * `WorkSafetyPanel` to subscribe through directly. `@azx/ribo-ui-react`'s
 * `useConnectivity()` now does that job — it subscribes to the `Connectivity`
 * instance itself, which is exactly what this module's old store re-implemented —
 * so the only thing left here is the instance this file's name promises: get one,
 * shared. Every consumer reaches it through `<RiboProvider value={{ connectivity:
 * getConnectivity() }}>` in `App.tsx`, never by importing this file directly.
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

let handle: Connectivity | undefined = hotData?.connectivity;

/** The shared connectivity model, constructing and `start()`ing it on first call. */
export function getConnectivity(): Connectivity {
  if (!handle) {
    handle = createConnectivity({
      bindEvents,
      isOnline: () => navigator.onLine,
      probe,
    });
    handle.start();
  }
  if (hotData) hotData.connectivity = handle;
  return handle;
}
