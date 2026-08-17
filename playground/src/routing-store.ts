import type { TranscriberFallback } from "@azx/ribo-core";

/**
 * @file Where the transcriber roster's routing events go, so they go somewhere.
 *
 * `firstCapable`'s `onFallback` and `hedged`'s `onHedge` exist to surface the one failure that
 * is otherwise invisible: the roster quietly stops using the engine everyone believes it is
 * using. `first-capable.ts` says so directly — the event is "loud on exactly the failure that
 * is otherwise invisible: every recording silently going to cloud STT while everyone believes
 * the fleet is offline-capable".
 *
 * Both callbacks were optional, and the playground passed neither. So the signal designed to
 * catch silent routing existed, compiled, was tested, and reported to nobody — including the
 * privacy-relevant half, which is the moment audio leaves the device.
 *
 * This is the smallest honest fix: an in-memory log the panel renders. It is deliberately not
 * persisted — this is a demo host, and a real one would send these somewhere durable. What
 * matters is that the events have a reader at all, and that a human can see the roster change
 * its mind.
 */

/** One routing decision, flattened for display. */
export interface RoutingEvent {
  readonly at: number;
  readonly kind: "fallback" | "hedge";
  readonly recordingId: string;
  /** Engine that produced the transcript, when one did. */
  readonly selected: string;
  /** Engines passed over, with the reason each was skipped. */
  readonly skipped: readonly string[];
}

const events: RoutingEvent[] = [];
const listeners = new Set<() => void>();

/** Newest first — the interesting event is the most recent one. */
let snapshot: readonly RoutingEvent[] = [];

function publish(event: RoutingEvent): void {
  events.unshift(event);
  // A demo does not need unbounded history, and an ever-growing array behind a
  // `useSyncExternalStore` is a leak with a UI attached.
  if (events.length > 20) events.length = 20;
  snapshot = [...events];
  for (const listener of listeners) listener();
}

/**
 * Record a `firstCapable` fallback.
 *
 * Must not throw: `FirstCapableOptions.onFallback` is documented as such, and a throwing
 * handler here would turn a routing notice into a failed transcription.
 */
export function recordFallback(event: TranscriberFallback): void {
  try {
    publish({
      at: Date.now(),
      kind: "fallback",
      recordingId: event.recordingId,
      selected: event.selected,
      skipped: event.skipped.map(
        (entry) =>
          `${entry.engine} (${
            entry.capability.status === "unavailable"
              ? entry.capability.reason
              : entry.capability.status
          })`,
      ),
    });
  } catch {
    // Swallow: see above.
  }
}

export function subscribeToRouting(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getRoutingEvents(): readonly RoutingEvent[] {
  return snapshot;
}
