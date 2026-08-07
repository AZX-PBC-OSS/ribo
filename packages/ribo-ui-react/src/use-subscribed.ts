import type { Unsubscribe } from "@azx/ribo-core";
import { useEffect, useState } from "react";

/**
 * Holds the latest value pushed by one of core's subscription sources.
 *
 * ## Why this is not `useSyncExternalStore`
 *
 * The obvious wiring is broken:
 *
 * ```ts
 * useSyncExternalStore(recorder.subscribe, () => recorder.state); // infinite loop
 * ```
 *
 * `useSyncExternalStore` requires `getSnapshot` to be referentially stable across
 * calls that represent the same state. `Recorder.state` builds a fresh object
 * every call, and `elapsedMs` recomputes from `performance.now()`, so it never
 * stabilizes and React re-renders forever. The playground hit exactly this and
 * solved it by caching a snapshot in module scope — which a hook over a
 * host-owned instance cannot do.
 *
 * So the pushed value is held in state instead. `initial` runs as `useState`'s
 * lazy initializer — once per mount normally, **twice** under React 19
 * StrictMode's deliberate double-invoke-to-check-purity (the playground renders
 * under `<StrictMode>`) — but never once per render the way `getSnapshot` is.
 * That's what matters: an unstable (freshly allocated) return value can never
 * trigger the re-render loop that comes from a per-render `getSnapshot` call
 * being compared against the last one, because nothing here ever re-invokes
 * `initial` after mount to do that comparison. Core's sources call their listener
 * **immediately** on subscribe (`Recorder.subscribe`, `Connectivity.subscribe`),
 * so the first paint is never blank, nothing polls, and a value that changed in
 * the gap between the render that seeds `initial` and the effect that
 * subscribes is delivered the moment the effect runs rather than silently
 * dropped.
 *
 * **The accepted tradeoff:** this gives up `useSyncExternalStore`'s tearing
 * protection under concurrent rendering. For a level meter pushed every 100 ms and
 * a connectivity badge, a torn frame is not observable. If a value ever needs the
 * guarantee, add a snapshot cache **here** rather than a second pattern in each
 * hook.
 *
 * `subscribe` must be referentially stable — wrap it in `useCallback` keyed on the
 * instance. **An inline arrow does not just re-subscribe on every render — it
 * loops forever** against any source that emits a freshly-allocated value on
 * subscribe (which is exactly what `Recorder`/`Connectivity` do): each render
 * makes a new `subscribe` identity, the effect's `[subscribe]` dependency sees
 * that change and re-runs, the source's immediate delivery hands back a value
 * that is never `Object.is`-equal to the last one, `setValue` schedules another
 * render, and the cycle repeats. See `use-subscribed.browser.test.tsx`'s
 * unmemoized-`subscribe` test for this reproduced end to end.
 */
export function useSubscribed<T>(
  subscribe: (listener: (value: T) => void) => Unsubscribe,
  initial: () => T,
): T {
  const [value, setValue] = useState<T>(initial);
  // `subscribe` returns its own unsubscribe handle, so it *is* the cleanup.
  useEffect(() => subscribe(setValue), [subscribe]);
  return value;
}
