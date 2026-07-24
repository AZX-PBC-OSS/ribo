import { useEffect, useSyncExternalStore } from "react";
import type { Outbox } from "@azx/ribo-core";

import { acknowledgeEviction, getEvictionState, startEvictionWatch } from "./eviction-store.js";
import { subscribeToEviction } from "./eviction-store.js";
import { formatClock } from "./format.js";
import { button, muted, noticeBox } from "./styles.js";

/**
 * @file What the user is told when the browser reclaimed their recordings.
 *
 * The copy is the deliverable here, not the markup. Two things it has to do at
 * once: say the recordings are **gone** without hedging, and not read like a
 * crash — per `docs/implementation/09-offline-first.md` this is the expected
 * iOS path, and a field auditor who is told "Error: storage failure" learns to
 * distrust a tool that is behaving exactly as designed.
 *
 * So: plain past tense, who did it (the browser, not a bug), what it took (the
 * queue and the offline shell, together), whether anything can be recovered
 * (no — and saying so immediately is kinder than letting someone go looking),
 * and what actually reduces the odds next time.
 *
 * Rendered above everything else on the page. A data-loss message below the
 * fold is a message nobody read.
 */

export function EvictionNotice({ outbox }: { outbox: Outbox }) {
  const eviction = useSyncExternalStore(subscribeToEviction, getEvictionState);

  useEffect(() => startEvictionWatch(outbox), [outbox]);

  if (eviction.phase !== "evicted") return null;

  const count = eviction.lostItems ?? 0;
  const plural = count === 1 ? "recording" : "recordings";

  return (
    <section data-testid="eviction-notice" style={noticeBox}>
      <p style={{ fontWeight: 600, margin: 0 }}>
        Your queued recordings were removed by the browser to free space.
      </p>
      <p style={{ margin: "0.5rem 0 0" }}>
        {count} {plural} {count === 1 ? "was" : "were"} waiting to sync when this app was last open
        {eviction.lastSeenAt !== undefined && <> ({formatClock(eviction.lastSeenAt)})</>}. They are
        gone, and there is no copy to restore: recordings live only on this device until they sync.
        Nothing was corrupted and nothing failed — the browser reclaimed this app&rsquo;s storage,
        which takes the queue and the cached app shell together.
      </p>
      <p style={{ margin: "0.5rem 0 0" }}>
        On iPhone and iPad this happens after about seven days without opening the app. Two things
        make it less likely: add the app to your Home Screen, and open it at least weekly. Anything
        recorded from here on is unaffected.
      </p>
      <button
        type="button"
        style={{ ...button, marginTop: "0.75rem" }}
        onClick={acknowledgeEviction}
      >
        Got it
      </button>
      <p style={{ ...muted, margin: "0.6rem 0 0" }}>
        Detected by comparing the queue against a marker this app leaves outside IndexedDB. See the
        storage panel for what that marker cannot see.
      </p>
    </section>
  );
}
