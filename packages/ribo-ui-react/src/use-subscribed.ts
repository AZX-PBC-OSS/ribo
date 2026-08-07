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
 * So the pushed value is held in state instead. `initial` is only ever invoked
 * once, as `useState`'s lazy initializer on mount, so an unstable (freshly
 * allocated) return value can never trigger the re-render loop that a
 * `getSnapshot` called on every render would. Core's sources call their listener
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
 * instance. An inline arrow re-subscribes on every render.
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
