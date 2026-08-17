import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createRelay, firstCapable, type Outbox, type OutboxItem } from "@azx/ribo-core";

import { extractStep } from "./extractor-store.js";
import { formatBytes, messageOf } from "./format.js";
import { getManagedTranscriber } from "./managed-transcriber-store.js";
import { button, errorBox, monospace, muted, panel } from "./styles.js";
import {
  getTranscriber,
  getWhisperState,
  primeModel,
  refreshCapability,
  startWhisper,
  subscribeToWhisper,
  type WhisperState,
} from "./whisper-store.js";

/**
 * @file On-device transcription — the Phase 3 payoff.
 *
 * Two controls, in order of the demo they enable:
 *
 * 1. **Make available offline** — an explicit, user-initiated download of the
 *    Whisper model, with a real progress bar (~300 MB fp32; a control that shows
 *    nothing during that is unusable). It distinguishes "download required" from
 *    "ready" using the transcriber's Cache-API capability check. Nothing is
 *    fetched until the button is pressed.
 * 2. **Transcribe queued recordings** — hands the shared {@link
 *    getTranscriber} to `ribo-core`'s relay and drains the queue through its
 *    `transcribing` step, rather than bypassing the queue with a direct call.
 *    The transcript lands on each row (see `QueuePanel`).
 *
 * The whole claim of the phase — prime the model, cut the network, record,
 * transcribe, see text — is demonstrable from here.
 */

export function TranscribePanel({ outbox }: { outbox: Outbox }) {
  const whisper = useSyncExternalStore(subscribeToWhisper, getWhisperState);

  // The capability probe is a side effect of the panel being on screen, kept in
  // the component that reports the outcome. `startWhisper` is idempotent.
  useEffect(() => {
    startWhisper();
  }, []);

  return (
    <section style={panel}>
      <h2>3 · On-device transcription</h2>
      <p style={muted}>
        Whisper runs entirely on this device via{" "}
        <code style={monospace}>@azx/ribo-transcriber-ondevice</code>. After a one-time model
        download, transcription needs no network at all.
      </p>

      <ModelControl whisper={whisper} />
      <TranscribeControl outbox={outbox} ready={whisper.phase === "ready"} />

      <p style={{ ...muted, marginTop: "1rem" }}>
        <strong>Offline demo.</strong> Make the model available offline{" "}
        <strong>while online</strong> — that one step is the only thing that needs the network. Then
        cut the network (DevTools → Network → Offline, or airplane mode), record above, and press{" "}
        <em>Transcribe</em>. The transcript is computed with no network, and it survives a cold
        reload too.
      </p>
      <p style={{ ...muted, margin: "0.4rem 0 0" }}>
        Priming caches everything the offline path needs: model weights in the Cache API (
        <code style={monospace}>transformers-cache</code>), the worker + transformers.js in the
        service-worker precache, and the ONNX runtime under <code style={monospace}>/ort/</code> via
        a CacheFirst runtime cache. That last one is easy to miss — the runtime loaders are{" "}
        <code style={monospace}>.mjs</code>/<code style={monospace}>.wasm</code>, which the precache
        glob excludes; without the runtime cache, backend init fails offline with{" "}
        <em>“no available backend found.”</em>
      </p>
      <p style={{ ...muted, margin: "0.4rem 0 0" }}>
        Clips longer than 30&nbsp;seconds are truncated to Whisper&rsquo;s window — no chunking yet.
      </p>
    </section>
  );
}

function ModelControl({ whisper }: { whisper: WhisperState }) {
  switch (whisper.phase) {
    case "checking":
      return <p style={muted}>Checking whether the Whisper model is already cached…</p>;

    case "unsupported":
      return (
        <p style={errorBox}>
          On-device transcription is unavailable here: {whisper.message ?? "unsupported platform"}.
        </p>
      );

    case "needs-download":
      return (
        <div>
          <p style={{ margin: "0 0 0.6rem" }}>
            <strong>Not on this device.</strong>{" "}
            <code style={monospace}>{whisper.detail ?? "whisper-base.en"}</code> — about{" "}
            <strong>{formatBytes(whisper.downloadBytes)}</strong> to download, once, over the
            network. Nothing is fetched until you press the button.
          </p>
          <button type="button" style={button} onClick={() => primeModel()}>
            Make available offline (≈ {formatBytes(whisper.downloadBytes)})
          </button>
        </div>
      );

    case "downloading":
      return <DownloadProgress whisper={whisper} />;

    case "ready":
      return (
        <div>
          <p style={{ margin: "0 0 0.6rem" }}>
            <strong>Model ready ✓</strong> — cached for offline use. Recording and transcription now
            work with no network.
          </p>
          <button type="button" style={button} onClick={() => void refreshCapability()}>
            re-check
          </button>
        </div>
      );

    case "error":
      return (
        <div>
          <p style={errorBox}>Model download failed: {whisper.message ?? "unknown error"}.</p>
          <button
            type="button"
            style={{ ...button, marginTop: "0.5rem" }}
            onClick={() => primeModel()}
          >
            try again
          </button>
        </div>
      );
  }
}

function DownloadProgress({ whisper }: { whisper: WhisperState }) {
  const fraction = whisper.progress?.fraction ?? 0;
  const percent = Math.round(fraction * 100);
  const loaded = whisper.progress?.loaded ?? 0;
  const total = whisper.progress?.total ?? 0;

  return (
    <div>
      <p style={{ margin: "0 0 0.5rem" }}>
        Downloading <code style={monospace}>{whisper.detail ?? "whisper-base.en"}</code>… {percent}%
        {total > 0 && (
          <>
            {" "}
            ({formatBytes(loaded)} / {formatBytes(total)})
          </>
        )}
      </p>
      <div
        style={{ background: "#eaeef2", borderRadius: 7, height: 14, overflow: "hidden" }}
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          style={{
            background: "#1f883d",
            height: "100%",
            transition: "width 120ms linear",
            width: `${String(percent)}%`,
          }}
        />
      </div>
      <p style={{ ...muted, margin: "0.4rem 0 0" }}>
        Explicit, user-initiated — leave this tab open until it finishes.
      </p>
    </div>
  );
}

function TranscribeControl({ outbox, ready }: { outbox: Outbox; ready: boolean }) {
  const [items, setItems] = useState<OutboxItem[] | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  // Guards against a re-entrant drain the way `QueuePanel` does: the relay's own
  // writes re-render this component, and `busy` state is a render behind.
  const runningRef = useRef(false);

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

  const drainable = items?.some((i) => i.status === "queued" || i.status === "failed") ?? false;

  const run = useCallback(() => {
    if (runningRef.current) return;
    runningRef.current = true;
    setError(undefined);
    setBusy(true);
    void runOnDeviceRelay(outbox)
      .catch((cause: unknown) => {
        setError(messageOf(cause));
      })
      .finally(() => {
        runningRef.current = false;
        setBusy(false);
      });
  }, [outbox]);

  return (
    <div style={{ marginTop: "1rem" }}>
      <button type="button" style={button} onClick={run} disabled={!ready || busy || !drainable}>
        {busy ? "transcribing…" : "Transcribe queued recordings on-device"}
      </button>
      <p style={{ ...muted, margin: "0.4rem 0 0" }}>
        Drains the queue through <code style={monospace}>ribo-core</code>&rsquo;s relay — the real
        Whisper transcriber in the queue&rsquo;s <code style={monospace}>transcribing</code> step,
        not a bypass, then the real <code style={monospace}>extracting</code> step (the shared
        extractor — sample data by default, a live model when configured). Its fields, with their
        provenance, show in <em>Review extracted fields</em> below. Write-back is still a stub, so
        items finish at <code style={monospace}>done</code>.
      </p>
      {!ready && (
        <p style={{ ...muted, margin: "0.25rem 0 0" }}>Make the model available offline first.</p>
      )}
      {error !== undefined && <p style={errorBox}>{error}</p>}
    </div>
  );
}

/**
 * Drain the queue with the real transcriber **roster** in the transcribing step
 * and the SHARED real extract step in the extracting step.
 *
 * The roster is `firstCapable([onDevice, managed])` — the composition a host
 * actually ships. On-device comes first because it is faster to reach, works with
 * no uplink, and keeps the audio on the machine; the managed engine covers the
 * devices that cannot run the model or cannot run it quickly enough.
 *
 * With `VITE_MANAGED_TRANSCRIPTION` unset the managed engine reports
 * `not-configured` and `firstCapable` skips it, so this button behaves exactly as
 * it did before. Set it, and an unprimed model means the drain falls through to
 * the managed engine — which is the fallback, watchable.
 *
 * Built per click rather than started at boot, and via `syncNow` — the manual
 * path that bypasses connectivity hysteresis, so it transcribes even while the
 * connectivity model reports `offline` (which is the whole offline demo).
 *
 * `extract` is the same {@link extractStep} `QueuePanel` uses (`extractor-store.ts`)
 * — one shared extractor over the one outbox. By default that is a `FakeExtractor`,
 * so the offline demo still needs no network for extraction; with a key it is a
 * real model, which is network-bound and rests in `extracting` until online.
 * Write-back stays a stub (Phase 4 Task 6, gated on A1).
 */
async function runOnDeviceRelay(outbox: Outbox): Promise<void> {
  const relay = createRelay({
    outbox,
    transcriber: firstCapable([getTranscriber(), getManagedTranscriber()]),
    extract: extractStep,
    write: () => Promise.resolve({ writtenBy: "playground on-device demo" }),
  });
  await relay.syncNow();
}
