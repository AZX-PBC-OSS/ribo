import type { Outbox, SessionItem, SessionQuery } from "@azx/ribo-core";
import { useEffect, useMemo, useState } from "react";

import { useRiboInstance } from "./use-ribo-instance.js";

export interface UseSessionsResult {
  readonly items: readonly SessionItem[];
  /** No emission has arrived yet. Distinct from an empty session list. */
  readonly loading: boolean;
  readonly error: Error | undefined;
}

/**
 * Sessions as live React state — the session-collection mirror of
 * {@link useOutboxItems}.
 *
 * ```tsx
 * const { items: open, loading } = useSessions({ status: "open" });
 * ```
 *
 * Same design as `useOutboxItems`: `loading` is load-bearing (an in-flight read
 * is not an empty list), the query is compared by value (a caller builds a new
 * object every render and the subscription must not tear down on each one), and
 * the hook subscribes directly to the rxjs `Observable` rather than going
 * through `useSubscribed` (which is for core's callback-subscribe shape).
 */
export function useSessions(query: SessionQuery = {}, outbox?: Outbox): UseSessionsResult {
  const instance = useRiboInstance("outbox", outbox);
  const key = JSON.stringify({
    status: query.status,
    limit: query.limit,
  });

  const stableQuery = useMemo<SessionQuery>(() => JSON.parse(key) as SessionQuery, [key]);

  const [items, setItems] = useState<readonly SessionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | undefined>(undefined);

  useEffect(() => {
    setLoading(true);
    setError(undefined);
    try {
      const subscription = instance.watchSessions(stableQuery).subscribe({
        next: (next) => {
          setItems(next);
          setLoading(false);
        },
        error: (cause: unknown) => {
          setError(cause instanceof Error ? cause : new Error(String(cause)));
          setLoading(false);
        },
      });
      return () => subscription.unsubscribe();
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error(String(cause)));
      setLoading(false);
      return undefined;
    }
  }, [instance, stableQuery]);

  return { items, loading, error };
}
