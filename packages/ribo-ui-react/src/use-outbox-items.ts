import type { Outbox, OutboxItem, OutboxQuery } from "@azx/ribo-core";
import { useEffect, useMemo, useState } from "react";

import { useRiboInstance } from "./use-ribo-instance.js";

export interface UseOutboxItemsResult {
  readonly items: readonly OutboxItem[];
  /** No emission has arrived yet. Distinct from an empty queue. */
  readonly loading: boolean;
  readonly error: Error | undefined;
}

/**
 * The outbox as live React state.
 *
 * ```tsx
 * const { items: parked, loading } = useOutboxItems({ status: "awaiting-review" });
 * ```
 *
 * `loading` is load-bearing, not cosmetic: "reading the outbox…" and "nothing in
 * the queue" are different sentences, and conflating them flashes the empty state
 * on every mount.
 *
 * The query is compared **by value**, not by identity. A caller writing
 * `useOutboxItems({ status: "queued" })` builds a new object every render, and an
 * effect keyed on that object would tear down the RxDB subscription and rebuild it
 * on every single render — a trap a consumer hits immediately and diagnoses slowly.
 *
 * Does not consume `useSubscribed`: `Outbox.watch` is an rxjs `Observable`, not
 * core's callback-subscribe shape, so this hook subscribes directly and tears the
 * subscription down itself on cleanup.
 */
export function useOutboxItems(query: OutboxQuery = {}, outbox?: Outbox): UseOutboxItemsResult {
  const instance = useRiboInstance("outbox", outbox);
  // Serialized rather than deep-compared: the query has two scalar-ish fields, so
  // a string key is cheaper and more obvious than a comparison helper. Key order
  // is stable because the object is built from a fixed set of fields.
  const key = JSON.stringify({ status: query.status, limit: query.limit });

  const stableQuery = useMemo<OutboxQuery>(() => JSON.parse(key) as OutboxQuery, [key]);

  const [items, setItems] = useState<readonly OutboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | undefined>(undefined);

  useEffect(() => {
    setLoading(true);
    const subscription = instance.watch(stableQuery).subscribe({
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
  }, [instance, stableQuery]);

  return { items, loading, error };
}
