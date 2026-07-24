import type { Outbox } from "@azx/ribo-core";

import { markerSupported, readMarker, writeMarker, type StorageMarker } from "./eviction-marker.js";

/**
 * @file Boot-time eviction detection — Phase 2.5, Task 4.
 *
 * One comparison, made once, before anything else has a chance to write to the
 * queue: **what the marker last recorded** against **what IndexedDB actually
 * has**. `eviction-marker.ts` explains where the marker lives and what it
 * cannot see; this file is only the decision and the watch that keeps the
 * marker honest afterwards.
 *
 * ## This is not an error path
 *
 * `09` calls the 7-day sweep a design constraint, not a fault, so nothing here
 * is modelled as a failure: there is no `error` phase, nothing is thrown, and
 * the state reads as a fact about the device rather than as a crash. Eviction
 * is the expected iOS path and the app is supposed to meet it calmly.
 *
 * ## Ordering matters
 *
 * The check runs against `outbox.list()` *before* the marker watch starts. If
 * the watch ran first it would write `items: 0` on its first emission and erase
 * the very evidence being checked — the detector would then be permanently
 * incapable of firing, while looking completely correct.
 *
 * Same store shape as `update-store.ts` and `storage-store.ts`.
 */

export type EvictionPhase =
  /** The comparison has not run yet — the outbox is still opening. */
  | "checking"
  /** No marker on this device. A first run, **or** a wipe that took the marker too. */
  | "first-run"
  /** The marker and the queue agree. Nothing was lost. */
  | "intact"
  /** The marker recorded queued items and the queue is empty. Storage was reclaimed. */
  | "evicted"
  /** Neither `localStorage` nor cookies are usable, so nothing can be detected. */
  | "undetectable";

export interface EvictionState {
  readonly phase: EvictionPhase;
  /** How many recordings the marker last saw. Only set when `phase` is `"evicted"`. */
  readonly lostItems?: number;
  /** ISO 8601 of that last sighting. Only set when `phase` is `"evicted"`. */
  readonly lastSeenAt?: string;
}

let state: EvictionState = { phase: "checking" };

const listeners = new Set<() => void>();

function setState(next: EvictionState): void {
  state = next;
  for (const listener of listeners) listener();
}

export function subscribeToEviction(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The current state, stable by identity until something changes. */
export function getEvictionState(): EvictionState {
  return state;
}

/**
 * Acknowledge the notice.
 *
 * Only clears it for this page load. The marker itself is already back to
 * `items: 0` by then (the watch below wrote it), so the notice does not return
 * on the next launch either — but dismissal deliberately does not depend on
 * that, because the user pressing "Got it" should not be a storage write.
 */
export function acknowledgeEviction(): void {
  if (state.phase !== "evicted") return;
  setState({ phase: "intact" });
}

let started = false;

/**
 * Run the check, then keep the marker current for the rest of the session.
 *
 * Idempotent: StrictMode's double mount checks once. Takes the already-open
 * outbox rather than opening its own — a second handle over the same IndexedDB
 * name is the error `outbox-handle.ts` exists to prevent.
 */
export function startEvictionWatch(outbox: Outbox): () => void {
  if (started) return () => undefined;
  started = true;

  if (!markerSupported()) {
    setState({ phase: "undetectable" });
    return () => undefined;
  }

  const { marker } = readMarker();
  let subscription: { unsubscribe: () => void } | undefined;
  let cancelled = false;

  void outbox
    .list()
    .then((items) => {
      if (cancelled) return;
      setState(decide(marker, items.length));
      // Only now is it safe to let the watch overwrite the marker.
      subscription = outbox.items$.subscribe({
        next: (live) => {
          writeMarker(live.length, marker);
        },
        // A read error is not eviction, and pretending otherwise would put a
        // data-loss message in front of someone whose data is fine.
        error: () => undefined,
      });
    })
    .catch(() => {
      // The outbox failing to list is `App`'s error to report, not this
      // module's to reinterpret.
      if (!cancelled) setState({ phase: "checking" });
    });

  return () => {
    cancelled = true;
    subscription?.unsubscribe();
  };
}

/**
 * The whole decision.
 *
 * Note what is *not* here: a partial mismatch (marker says 3, queue has 1) is
 * reported as `intact`. `09` is explicit that eviction is all-or-nothing, so a
 * survivor means something other than eviction happened — most likely a write
 * this session missed — and inventing a "some were lost" message for a case
 * that cannot occur would be a guess dressed as a report.
 */
function decide(marker: StorageMarker | undefined, queueLength: number): EvictionState {
  if (marker === undefined) {
    // No marker and a populated queue means the marker substrate was cleared
    // while IndexedDB survived — the opposite partial wipe. Nothing was lost,
    // and the watch is about to write a fresh marker.
    return queueLength > 0 ? { phase: "intact" } : { phase: "first-run" };
  }
  if (marker.items > 0 && queueLength === 0) {
    return { phase: "evicted", lostItems: marker.items, lastSeenAt: marker.lastSeenAt };
  }
  return { phase: "intact" };
}
