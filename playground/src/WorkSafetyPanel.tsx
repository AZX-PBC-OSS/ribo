import { type CSSProperties, useEffect, useState, useSyncExternalStore } from "react";
import {
  summarizeWork,
  workSafety,
  type Outbox,
  type OutboxItem,
  type StoragePersistence,
  type WorkSafety,
} from "@azx/ribo-core";

import { getConnectivityState, subscribeToConnectivity } from "./connectivity-store.js";
import { messageOf } from "./format.js";
import { getStorageState, subscribeToStorage, type PersistenceStatus } from "./storage-store.js";
import { errorBox, monospace, muted, noticeBox, panel } from "./styles.js";

/**
 * @file "Is my work safe?" — the one honest sentence, for an auditor.
 *
 * The plumbing (seq / attempts / per-row status) stays in `QueuePanel`. This
 * panel answers the actual question in words, and it does so by handing three
 * live facts to the *same* core selector a future `ribo-ui-react` would call:
 *
 *   - the outbox items (summarised to pending/dead/synced),
 *   - the storage persistence grant (mapped from the store's richer status),
 *   - the connectivity state.
 *
 * `workSafety` is written to never overstate safety — its `safe` level is
 * reserved for work that has *left the device*; a persistence grant only ever
 * earns `protected`. This panel honours that: the sentence for `at-risk` and
 * `action-required` never contains the word “safe”, and every sentence is phrased
 * from the verdict's own carried facts so the three field situations read
 * differently.
 */

export function WorkSafetyPanel({ outbox }: { outbox: Outbox }) {
  const [items, setItems] = useState<readonly OutboxItem[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    const subscription = outbox.items$.subscribe({
      next: setItems,
      error: (cause: unknown) => {
        setError(messageOf(cause));
      },
    });
    return () => {
      subscription.unsubscribe();
    };
  }, [outbox]);

  const storage = useSyncExternalStore(subscribeToStorage, getStorageState);
  const connectivity = useSyncExternalStore(subscribeToConnectivity, getConnectivityState);

  return (
    <section style={panel}>
      <h2>Is my work safe?</h2>

      {error !== undefined ? (
        <p style={errorBox}>{error}</p>
      ) : items === undefined ? (
        <p style={muted}>reading the outbox…</p>
      ) : (
        <Verdict
          verdict={workSafety(
            summarizeWork(items),
            toStoragePersistence(storage.persistence),
            connectivity.status,
          )}
        />
      )}

      <p style={{ ...muted, margin: "0.75rem 0 0" }}>
        One sentence, derived live from the outbox, the storage persistence grant, and connectivity
        — by the same <code style={monospace}>workSafety</code> selector a real UI would use, so the
        verbose panels above and this one can never disagree.
      </p>
    </section>
  );
}

function Verdict({ verdict }: { verdict: WorkSafety }) {
  return (
    <div style={box(verdict.level)}>
      <p style={{ margin: 0 }} data-testid="work-safety">
        <strong>{sentence(verdict)}</strong>
      </p>
      <p style={{ ...muted, margin: "0.35rem 0 0" }}>
        <code style={monospace}>
          level: {verdict.level} · reason: {verdict.reason}
        </code>
      </p>
    </div>
  );
}

/**
 * The verdict as one human sentence.
 *
 * Never says "safe" for `at-risk`/`action-required`. Each branch reads off the
 * facts the selector carried for exactly this purpose, so a bare "N pending"
 * cannot flatten the three situations into one.
 */
function sentence(verdict: WorkSafety): string {
  switch (verdict.reason) {
    case "nothing-captured":
      return "Nothing captured yet — there is nothing on this device that could be lost.";
    case "all-synced":
      return "All captured work has left this device. It is safe.";
    case "awaiting-sync": {
      const count = plural(verdict.pending, "recording");
      // Persisted and on the device: safe from reload/crash/eviction, phrased by
      // *why* it is still here — actively going out, or waiting for the network.
      if (verdict.connectivity === "online") {
        return `Saved and persistent — ${count} uploading now.`;
      }
      const when =
        verdict.connectivity === "probing"
          ? "as soon as the connection is confirmed"
          : "when you are back online";
      return `Saved and persistent — ${count} waiting to upload; they will send ${when}.`;
    }
    case "not-persisted": {
      const count = plural(verdict.pending, "recording");
      return `At risk: this browser's storage is not persistent (${persistencePhrase(
        verdict.persistence,
      )}), so ${count} here could be evicted at any time.`;
    }
    case "failed-permanently": {
      const count = plural(verdict.dead, "recording");
      return `${capitalize(count)} failed and need attention — no amount of waiting will fix them.`;
    }
  }
}

/** Why the grant is not in force, so the at-risk sentence can say which. */
function persistencePhrase(persistence: Exclude<StoragePersistence, "granted">): string {
  switch (persistence) {
    case "denied":
      return "the browser declined the request";
    case "unsupported":
      return "this browser cannot be asked";
    case "unknown":
      return "the request is still being checked";
  }
}

/**
 * Collapse the storage store's richer {@link PersistenceStatus} to the four
 * distinctions `workSafety` classifies on. This mapping is the store's
 * `PersistenceStatus` reading of `navigator.storage`, reduced to "does it change
 * the verdict?" — documented on `StoragePersistence` in `work-safety.ts`.
 */
function toStoragePersistence(status: PersistenceStatus): StoragePersistence {
  switch (status) {
    case "granted":
    case "already-persistent":
      return "granted";
    case "denied":
    case "error":
      return "denied";
    case "unsupported":
      return "unsupported";
    case "checking":
      return "unknown";
  }
}

function plural(n: number, noun: string): string {
  return `${String(n)} ${noun}${n === 1 ? "" : "s"}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function box(level: WorkSafety["level"]): CSSProperties {
  switch (level) {
    case "safe":
      return { ...noticeBox, background: "#dafbe1", border: "1px solid #1f883d", color: "#0f5323" };
    case "protected":
      return { ...noticeBox, background: "#ddf4ff", border: "1px solid #0969da", color: "#0a3069" };
    case "at-risk":
      return noticeBox;
    case "action-required":
      return errorBox;
  }
}
