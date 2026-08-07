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
  //
  // Known, accepted gap: `status` as an array is compared element-order-sensitively,
  // so `["queued", "failed"]` and `["failed", "queued"]` key differently and
  // needlessly re-subscribe. Every real call site builds `status` from a fixed
  // literal or a constant array (`ACTIVE_OUTBOX_STATUSES`), never a
  // dynamically-reordered one, so this has no observed impact; sorting the
  // array before serializing would fix it but was judged not worth the extra
  // branch for a case no caller hits.
  const key = JSON.stringify({ status: query.status, limit: query.limit });

  const stableQuery = useMemo<OutboxQuery>(() => JSON.parse(key) as OutboxQuery, [key]);

  const [items, setItems] = useState<readonly OutboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | undefined>(undefined);

  useEffect(() => {
    setLoading(true);
    // RxJS terminates a subscription on `.error()` — nothing further can ever
    // arrive on *this* subscription once that fires. The only way a caller
    // recovers is a brand-new subscription, and that only happens when this
    // effect restarts (`instance` or `stableQuery` changed). So a stale error
    // belongs to the subscription that just ended, not to the one about to
    // start, and clearing it here — alongside `loading` — is what keeps the
    // two flags describing the same subscription instead of the error
    // outliving the attempt that produced it.
    setError(undefined);
    // `watch()` and `subscribe()` are both synchronous calls that can throw
    // directly — a malformed query, a closed collection, a storage failure at
    // call time — rather than delivering their failure through the
    // Observable's `error` channel. Without this try/catch, that throw
    // escapes the effect and crashes the render instead of landing in state,
    // and with no error boundary in the playground that's a blank screen. A
    // synchronous throw here means no subscription was ever established, so
    // `loading` resolves to `false` for the same reason the `error` callback
    // below sets it to `false`: there is nothing left pending to load.
    try {
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
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error(String(cause)));
      setLoading(false);
      return undefined;
    }
  }, [instance, stableQuery]);

  return { items, loading, error };
}
