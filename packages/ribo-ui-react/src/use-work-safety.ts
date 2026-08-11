import type { CaptureHealth, WorkOnDevice, WorkSafety } from "@azx/ribo-core";
import { summarizeWork, workSafety } from "@azx/ribo-core";
import { useCallback, useMemo } from "react";

import { useConnectivity } from "./use-connectivity.js";
import { useOptionalRiboInstance } from "./use-ribo-instance.js";
import { useOutboxItems } from "./use-outbox-items.js";
import { useStoragePersistence } from "./use-storage-persistence.js";
import { useSubscribed } from "./use-subscribed.js";

export interface UseWorkSafetyResult {
  /**
   * The verdict — **`undefined` when it cannot be computed honestly**, which is
   * either while `loading` or after an outbox read `error`.
   *
   * Not a `WorkSafety` with a benign default. `useOutboxItems` yields an empty
   * array both before its first emission and after a watch failure, and an empty
   * array summarizes to `{ pending: 0 }`, which `workSafety` classifies as
   * `safe / nothing-captured`. So a defaulted verdict would announce that the
   * auditor's work is safe precisely when we have failed to look at it — the same
   * bug this module was just fixed for one layer down, and worse here because it
   * survives a total read failure.
   */
  readonly safety: WorkSafety | undefined;
  readonly work: WorkOnDevice | undefined;
  /** No outbox emission yet, so no verdict. */
  readonly loading: boolean;
  /** The outbox read failed, so no verdict. Distinct from `loading`. */
  readonly error: Error | undefined;
}

/**
 * The one honest answer to "is my work safe?", composed for React.
 *
 * Reads the outbox, the storage-persistence grant and connectivity, and runs
 * core's `summarizeWork` → `workSafety`. Composed **here**, once, because the
 * whole reason that logic lives in core is so "every presenter classifies
 * identically" — a host assembling the three inputs itself is exactly the
 * divergence core centralised to prevent.
 *
 * While `loading`, the verdict is computed over an empty outbox, so it would read
 * `safe` / `nothing-captured`. That verdict is withheld rather than shown: a UI
 * that renders it unconditionally tells the auditor their work is safe before it
 * has looked.
 *
 * **No override argument, unlike every other hook in this package.** It composes
 * `useOutboxItems`, `useConnectivity` and `useStoragePersistence` internally rather
 * than taking their instances as parameters, so there is nothing here for a caller
 * to override — which means this hook can only be used under a `RiboProvider`
 * (see its own doc comment), never bypassed the way a test can bypass the others.
 */
export function useWorkSafety(): UseWorkSafetyResult {
  const { items, loading, error } = useOutboxItems();
  const { persistence } = useStoragePersistence();
  const connectivity = useConnectivity();
  const captureCoordinator = useOptionalRiboInstance("captureCoordinator", undefined);

  // Subscribe to the coordinator's health$ — undefined when there is no
  // coordinator, which means capture health is not consulted (today's behaviour).
  const captureHealth = useSubscribed(
    useCallback(
      (listener: (h: CaptureHealth | undefined) => void) => {
        if (!captureCoordinator) return () => undefined;
        const sub = captureCoordinator.health$.subscribe(listener);
        return () => sub.unsubscribe();
      },
      [captureCoordinator],
    ),
    () => undefined,
  );

  // Withheld rather than defaulted whenever the inputs are not trustworthy. See
  // the note on `safety` above: an unreadable outbox looks exactly like an empty
  // one, and "empty" classifies as safe.
  const usable = !loading && error === undefined;

  const work = useMemo(() => (usable ? summarizeWork(items) : undefined), [items, usable]);
  const safety = useMemo(
    () =>
      work === undefined
        ? undefined
        : workSafety(work, persistence, connectivity.status, captureHealth),
    [connectivity.status, persistence, work, captureHealth],
  );

  return { safety, work, loading, error };
}
