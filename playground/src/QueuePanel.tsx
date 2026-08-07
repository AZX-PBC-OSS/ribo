import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createRelay, FakeTranscriber, type Outbox, type OutboxItem } from "@azx/ribo-core";
import { useConnectivity, useOutboxItems } from "@azx/ribo-ui-react";

import { getEvictionState, subscribeToEviction } from "./eviction-store.js";
import { extractStep } from "./extractor-store.js";
import { formatClock, formatElapsed, messageOf } from "./format.js";
import { ItemAudio } from "./ItemAudio.js";
import { PAGE_LOADED_AT } from "./session.js";
import { button, errorBox, monospace, muted, panel, statusBadge, survivedBadge } from "./styles.js";

/**
 * @file The queue, live.
 *
 * `useOutboxItems()` wraps `outbox.items$` — the RxDB collection query as an
 * observable — as React state: it pushes a fresh array on every write, including
 * writes from another tab. Subscribing to it — rather than re-running `list()` on
 * a timer — is what makes a row appear the instant capture ends, and is the only
 * version of this panel that would still be correct with two tabs open.
 *
 * `outbox` stays a plain prop here (unlike `RecordPanel`/`ConnectivityPanel`):
 * this panel still needs the raw instance for `outbox.clear()` and to build the
 * stub relay `runStubRelay` drains through — neither of those is a hook's job.
 */

export function QueuePanel({ outbox }: { outbox: Outbox }) {
  const { items, loading, error: watchError } = useOutboxItems({}, outbox);
  const [error, setError] = useState<string | undefined>(undefined);
  const [syncing, setSyncing] = useState(false);
  const [autoSync, setAutoSync] = useState(false);

  const connectivity = useConnectivity();

  // Guards a drain against re-entry: the connectivity effect below can fire while
  // a drain is already running (the queue's own writes re-render this component),
  // and `syncing` state is a render behind. A ref is read synchronously.
  const drainingRef = useRef(false);

  const drain = useCallback(() => {
    if (drainingRef.current) return;
    drainingRef.current = true;
    setError(undefined);
    setSyncing(true);
    void runStubRelay(outbox)
      .catch((cause: unknown) => {
        setError(messageOf(cause));
      })
      .finally(() => {
        drainingRef.current = false;
        setSyncing(false);
      });
  }, [outbox]);

  const syncNow = drain;

  // Items in a resting, drainable state — not mid-flight ones, so a drain in
  // progress does not re-trigger this effect into a second concurrent drain.
  const hasDrainable = items.some((i) => i.status === "queued" || i.status === "failed");

  // The ONLY place connectivity is allowed to drive work, and only opt-in. Off by
  // default (see the toggle copy) so the reload demo is untouched: a `queued` item
  // must survive a reload, which an auto-drain on mount would empty out. When on,
  // it drains on the stably-`online` edge — the same edge the real relay uses.
  useEffect(() => {
    if (!autoSync) return;
    if (connectivity.status !== "online") return;
    if (!hasDrainable) return;
    drain();
  }, [autoSync, connectivity.status, hasDrainable, drain]);

  const clear = useCallback(() => {
    setError(undefined);
    // One storage write, one re-render. This used to be `list()` plus a
    // `remove()` per item, which repainted the panel once per row.
    void outbox.clear().catch((cause: unknown) => {
      setError(messageOf(cause));
    });
  }, [outbox]);

  return (
    <section style={panel}>
      <h2>2 · Outbox</h2>
      <p style={muted}>
        Durable, in IndexedDB (<code style={monospace}>ribo-outbox</code>). Items stay at{" "}
        <code style={monospace}>queued</code>: Phase 2 ends at capture and persistence, so nothing
        drains this queue unless you ask it to.
      </p>

      <div style={{ display: "flex", gap: "0.5rem", margin: "0.75rem 0" }}>
        <button type="button" style={button} onClick={syncNow} disabled={syncing}>
          {syncing ? "syncing…" : "sync now (stub transcriber)"}
        </button>
        <button type="button" style={button} onClick={clear} disabled={items.length === 0}>
          clear queue
        </button>
      </div>

      <label style={{ ...muted, alignItems: "center", display: "flex", gap: "0.4rem" }}>
        <input
          type="checkbox"
          checked={autoSync}
          onChange={(event) => {
            setAutoSync(event.target.checked);
          }}
        />
        auto-sync when online (stub transcriber)
      </label>
      <p style={{ ...muted, margin: "0.25rem 0 0" }}>
        Off by default, on purpose. When on, the queue drains itself on the stably-
        <code style={monospace}>online</code> connectivity edge — the same edge the real relay uses.
        Left off, connectivity only <em>displays</em> and feeds “is my work safe?”, so a{" "}
        <code style={monospace}>queued</code> item still survives a reload instead of being emptied
        out from under the reload check.
      </p>

      {error !== undefined && <p style={errorBox}>{error}</p>}
      {watchError !== undefined && <p style={errorBox}>{watchError.message}</p>}

      {loading ? (
        <p style={muted}>reading the outbox…</p>
      ) : items.length === 0 ? (
        <EmptyQueue />
      ) : (
        <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {items.map((item) => (
            <QueueRow key={item.id} outbox={outbox} item={item} />
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * The empty state — which is two different facts wearing the same face.
 *
 * "Nothing queued yet" is true on a fresh device and a **lie** on one whose
 * recordings the browser just deleted: "yet" says none were ever made. Since
 * `EvictionNotice` already knows which of the two happened, this line asks it
 * rather than guessing, so the list under the notice does not quietly
 * contradict it.
 */
function EmptyQueue() {
  const eviction = useSyncExternalStore(subscribeToEviction, getEvictionState);
  return (
    <p data-testid="queue-empty" style={muted}>
      {eviction.phase === "evicted"
        ? "Empty — the recordings that were here were removed by the browser, as described above. Anything you record from now on is queued normally."
        : "Nothing queued yet — record something above."}
    </p>
  );
}

function QueueRow({ outbox, item }: { outbox: Outbox; item: OutboxItem }) {
  // Enqueued before this page load, so it can only have come back out of
  // IndexedDB. This is the reload check, stated by the UI rather than by the
  // person reading it.
  const survivedReload = item.enqueuedAt < PAGE_LOADED_AT;

  return (
    <li data-testid="queue-item" style={{ borderTop: "1px solid #eaeef2", padding: "0.75rem 0" }}>
      <div style={{ alignItems: "center", display: "flex", flexWrap: "wrap", gap: "0.6rem" }}>
        <strong style={monospace}>#{item.seq}</strong>
        <span style={statusBadge(item.status)}>{item.status}</span>
        {survivedReload && <span style={survivedBadge}>survived reload ✓</span>}
        <span style={muted}>
          queued {formatClock(item.enqueuedAt)} · {formatElapsed(item.recording.durationMs)} long ·
          attempt{item.attempts === 1 ? "" : "s"} {item.attempts}
        </span>
      </div>

      <div style={{ margin: "0.5rem 0" }}>
        <ItemAudio
          outbox={outbox}
          id={item.id}
          hasAudio={item.hasAudio}
          audioBytes={item.audioBytes}
          mimeType={item.recording.mimeType}
        />
      </div>

      <div style={muted}>
        <code style={monospace}>id {item.id}</code>
      </div>
      {item.transcript && <div style={muted}>transcript: “{item.transcript.text}”</div>}
      {item.lastError !== undefined && <div style={errorBox}>{item.lastError}</div>}
    </li>
  );
}

/**
 * Drains the queue with a stub transcriber, the SHARED real extract step, and a
 * stub write.
 *
 * Explicitly **not** the default path, and built per click rather than started
 * at app boot: `relay.start()` drains on mount and again on the connectivity
 * model's stably-online edge, which would mean a reload silently emptied the
 * very queue the reload check exists to inspect.
 *
 * Transcription is a `FakeTranscriber` here (this is the pre-Phase-3 button that
 * only shows the state machine turns over); the on-device transcriber lives in
 * `TranscribePanel`. Extraction, though, is the **same {@link extractStep}** both
 * panels share (`extractor-store.ts`) — `FakeExtractor` by default, a real model
 * when a key is configured. An extracted item now parks at `awaiting-review`
 * rather than reaching `done` on its own — `ReviewPanel` is the only way past
 * that gate — so this button drains as far as a human review, not further.
 */
async function runStubRelay(outbox: Outbox): Promise<void> {
  const relay = createRelay({
    outbox,
    transcriber: new FakeTranscriber(),
    extract: extractStep,
    write: () => Promise.resolve({ writtenBy: "playground stub" }),
  });
  await relay.syncNow();
}
