import type { CSSProperties } from "react";
import type { StoragePersistence, WorkSafety } from "@azx/ribo-core";
import { useWorkSafety } from "@azx/ribo-ui-react";

import { errorBox, monospace, muted, noticeBox, panel } from "./styles.js";

/**
 * @file "Is my work safe?" — the one honest sentence, for an auditor.
 *
 * The plumbing (seq / attempts / per-row status) stays in `QueuePanel`. This
 * panel answers the actual question in words, off `useWorkSafety()` — the same
 * composition of the outbox, the storage-persistence grant and connectivity that
 * a real host UI would use, so the verbose panels above and this one can never
 * disagree.
 *
 * `workSafety` is written to never overstate safety — its `safe` level is
 * reserved for work that has *left the device*; a persistence grant only ever
 * earns `protected`. This panel honours that: the sentence for `at-risk` and
 * `action-required` never contains the word “safe”, and every sentence is phrased
 * from the verdict's own carried facts so the three field situations read
 * differently.
 */

export function WorkSafetyPanel() {
  const { safety, work, loading, error } = useWorkSafety();

  return (
    <section style={panel}>
      <h2>Is my work safe?</h2>

      {error !== undefined ? (
        <p style={errorBox}>{error.message}</p>
      ) : loading || safety === undefined ? (
        <p style={muted}>reading the outbox…</p>
      ) : (
        <Verdict verdict={safety} />
      )}

      {work !== undefined && work.awaitingReview > 0 && (
        <p style={{ ...muted, margin: "0.5rem 0 0" }}>
          {plural(work.awaitingReview, "recording")} need review — see{" "}
          <strong>4 · Review extracted fields</strong> below.
        </p>
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
    case "recording":
      return "Recording — audio is being saved as you dictate. Each chunk reaches disk as it is captured.";
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
    case "capture-stalled": {
      const count = plural(verdict.pending, "recording");
      return `At risk: ${count} has a stalled capture — audio in memory is not reaching disk.`;
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
function persistencePhrase(
  persistence: Exclude<StoragePersistence, "granted"> | undefined,
): string {
  if (persistence === undefined) return "the grant is unknown";
  switch (persistence) {
    case "denied":
      return "the browser declined the request";
    case "unsupported":
      return "this browser cannot be asked";
    case "unknown":
      return "the request is still being checked";
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
