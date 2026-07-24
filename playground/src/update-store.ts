import { registerSW } from "virtual:pwa-register";

import { isCapturing } from "./recorder-handle.js";

/**
 * @file Service-worker registration and the update policy — Phase 2.5, Task 2.
 *
 * ## The rule
 *
 * **The page never reloads unless a person asked it to, and never while audio is
 * being captured.** A field recording is made once, standing in someone's attic,
 * and cannot be recreated. Losing one to a version upgrade is the worst failure
 * this product has.
 *
 * ## Why the default is unsafe
 *
 * Workbox's house pattern is `skipWaiting` + reload on activate. Applied here it
 * means: a deploy happens, the new worker installs, and the tab reloads out from
 * under a live `MediaRecorder`. So `vite.config.ts` builds the worker with
 * `registerType: "prompt"` (`skipWaiting: false`, `clientsClaim: false`) and
 * nothing sends the `SKIP_WAITING` message except {@link applyUpdate}.
 *
 * ## The second reload, which is easy to miss
 *
 * `registerType: "prompt"` still reloads on its own in one case. When the plugin
 * shows its prompt it attaches a `controlling` listener that calls
 * `window.location.reload()` as soon as a new worker takes control — and a new
 * worker can take control without *this* tab asking, because `skipWaiting()`
 * replaces the old worker for **every** client it controlled. Two tabs, an
 * update applied in the first, and the second reloads mid-recording.
 *
 * That is what the plugin's `onNeedReload` option is for: supplying it replaces
 * the automatic reload entirely. We take control of the shell swap and
 * refuse to act on it while capturing, leaving the page in `reload-pending` —
 * old code in memory, new shell on disk — until a person clicks.
 *
 * ## The stale-shell risk
 *
 * `reload-pending` is exactly the stale shell: JavaScript from version N running
 * against IndexedDB that version N+1's worker will serve. It is also the
 * ordinary two-tab situation, and it is *already* possible today without any
 * service worker — a tab left open across a deploy is the same thing.
 *
 * What catches it is `outboxDocumentSchema`, which
 * `docs/implementation/09-offline-first.md` and the schema's own doc comment
 * call a trust boundary **in both directions**: documents are parsed on the way
 * out of IndexedDB as well as on the way in. It is a `z.strictObject`, so:
 *
 * - **New field written by N+1, read by N** → the strict parse *rejects* the
 *   unknown key. The user sees the outbox fail to open, or that row fail to
 *   read — an error, not silent corruption. Loud, and recoverable by reloading.
 * - **Field removed or narrowed by N+1** → the parse rejects the same way.
 * - **Same shape, different meaning** → the parse cannot see it. No schema can.
 *   This is the residual risk, and it is why `reload-pending` is surfaced
 *   prominently rather than left as a quiet background state.
 *
 * The trade is deliberate: the window is narrow (one capture long), it is closed
 * by a click the user is being asked for anyway, and the alternative — reloading
 * to close it — is the thing that destroys the recording.
 */

/** Where the app shell's service worker currently stands. */
export type UpdatePhase =
  /** No `navigator.serviceWorker` — the app runs, but only online. */
  | "unsupported"
  /** Development: registration is deliberately skipped. See `vite.config.ts`. */
  | "disabled-in-dev"
  /** Registration in flight. */
  | "registering"
  /** Shell precached. A cold start with no network will boot. */
  | "offline-ready"
  /** A new version is installed and waiting. Nothing happens until asked. */
  | "waiting"
  /** The new shell is in control; this page is still running the old code. */
  | "reload-pending"
  /** Registration failed. The app works, offline boot does not. */
  | "error";

export interface UpdateState {
  readonly phase: UpdatePhase;
  /** Set when an apply or reload was refused because capture was underway. */
  readonly refusal?: string;
  /** Present when `phase` is `"error"`. */
  readonly message?: string;
}

/** What {@link applyUpdate} and {@link finishReload} did. */
export type ApplyResult = "applied" | "refused-recording" | "nothing-waiting";

const REFUSAL =
  "Update held back — a recording is in progress. Applying it would reload the page and " +
  "destroy the capture, which cannot be redone. Stop and queue the recording first.";

let state: UpdateState = { phase: "registering" };

const listeners = new Set<() => void>();

function setState(next: UpdateState): void {
  state = next;
  for (const listener of listeners) listener();
}

/** Subscribe to state changes. Returns its own unsubscribe handle. */
export function subscribeToUpdates(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The current state.
 *
 * Returns the same object identity until something actually changes, which is
 * what `useSyncExternalStore` requires — a fresh object per call is an infinite
 * render loop.
 */
export function getUpdateState(): UpdateState {
  return state;
}

/** Sends `SKIP_WAITING`. Assigned by {@link startServiceWorker}. */
let sendSkipWaiting: ((reloadPage?: boolean) => Promise<void>) | undefined;

let started = false;

/**
 * Register the service worker and wire the update policy.
 *
 * Idempotent: calling it twice (StrictMode's double mount) registers once.
 */
export function startServiceWorker(): void {
  if (started) return;
  started = true;

  if (import.meta.env.DEV) {
    setState({ phase: "disabled-in-dev" });
    return;
  }
  if (!("serviceWorker" in navigator)) {
    setState({ phase: "unsupported" });
    return;
  }

  sendSkipWaiting = registerSW({
    immediate: true,
    onOfflineReady() {
      setState({ phase: "offline-ready" });
    },
    onNeedRefresh() {
      setState({ phase: "waiting" });
    },
    // Supplying this at all is the point: it *replaces* the plugin's automatic
    // `window.location.reload()` when a new worker takes control. See the file
    // comment — without it, a sibling tab applying an update reloads this one.
    onNeedReload() {
      if (isCapturing()) {
        setState({ phase: "reload-pending", refusal: REFUSAL });
        return;
      }
      reloadNow();
    },
    onRegisterError(error: unknown) {
      setState({ phase: "error", message: messageOfUnknown(error) });
    },
  });
}

/**
 * Apply a waiting update, if it is safe to.
 *
 * The guard is here and not only on the button. A disabled button is a UI
 * affordance; this is the actual refusal, and it holds for any caller.
 */
export function applyUpdate(): ApplyResult {
  if (state.phase !== "waiting") return "nothing-waiting";
  if (isCapturing()) {
    setState({ ...state, refusal: REFUSAL });
    return "refused-recording";
  }
  setState({ phase: "waiting" });

  // Whether a *previous* worker is currently driving this page, captured before
  // anything changes. `clientsClaim` is off, so the worker that installed during
  // this very first visit never took over — this page is uncontrolled, no
  // `controlling` event will ever fire for it, and waiting for `onNeedReload`
  // would wait forever. Observed, not theorised: the first version of this
  // function only sent the message, and the button did nothing at all on a first
  // visit.
  const controlled = navigator.serviceWorker.controller !== null;

  // Resolves once the message has been sent. When the page *is* controlled, the
  // actual swap arrives later as `onNeedReload`, which owns the reload.
  void sendSkipWaiting?.().then(() => {
    if (controlled) return;
    // Re-checked rather than trusted: `applyUpdate` returned to the caller a
    // moment ago and a recording could have started since.
    if (isCapturing()) {
      setState({ phase: "reload-pending", refusal: REFUSAL });
      return;
    }
    reloadNow();
  });
  return "applied";
}

/** Finish a shell swap that was deferred because a recording was running. */
export function finishReload(): ApplyResult {
  if (state.phase !== "reload-pending") return "nothing-waiting";
  if (isCapturing()) {
    setState({ ...state, refusal: REFUSAL });
    return "refused-recording";
  }
  reloadNow();
  return "applied";
}

/**
 * The one call site that reloads the page.
 *
 * Deliberately a named function rather than an inline `location.reload()` in
 * three places, so that "what can reload this app?" is answerable by grepping
 * for one identifier.
 */
function reloadNow(): void {
  window.location.reload();
}

function messageOfUnknown(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
