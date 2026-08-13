import { useCallback } from "react";
import { useOutboxItems, useRecorder } from "@azx/ribo-ui-react";

import { formatElapsed } from "./format.js";
import { button, errorBox, monospace, muted, panel, recordButton } from "./styles.js";

/**
 * @file Start/stop/pause capture, with the two readouts that prove the microphone
 * is live: elapsed time and input level.
 *
 * `useRecorder()` resolves the shared `Recorder` (and, for enqueueing a stopped
 * capture, the shared `Outbox`) through `RiboProvider`, and pushes fresh state on
 * every ~100 ms tick and on every phase change. Nothing here polls, and nothing
 * here owns a `Recorder` of its own — see `recorder-handle.ts` for why that
 * instance is a host-level singleton rather than component state.
 */

/** Height of the level meter, in pixels. */
const METER_HEIGHT = 14;

export function RecordPanel() {
  const { phase, elapsedMs, level, scaledLevel, busy, error, toggle, pause, resume } =
    useRecorder();
  // The recording row is already in the outbox (durable capture inserts it at
  // `start()`), so `useOutboxItems` delivers its `preview` reactively — no new
  // subscription mechanism is added (design §Delivery). `preview` is absent
  // before the first utterance closes and after the batch transcript lands.
  const { items: recordingItems } = useOutboxItems({ status: "recording" });
  // **The LAST row, not the first.** `useOutboxItems` sorts by `seq` ascending — that ordering is the
  // queue's capture-order guarantee and is not optional — so `[0]` is the OLDEST `recording` row.
  // Durable capture leaves one behind for every interrupted capture until startup recovery sweeps
  // it, so on any device that has ever lost a recording, `[0]` is an orphan with no preview and the
  // live text lands on a row nobody is watching. Only one capture can be live at a time (the capture
  // lock enforces it), so the highest `seq` is always the current one.
  //
  // Found by hand: the console showed segments arriving and being appended while the panel stayed
  // empty. A fresh browser profile has no orphans, so `[0]` happens to be right — which is why every
  // automated run of this passed.
  const recordingItem = recordingItems.at(-1);
  const previewCommitted = recordingItem?.preview?.committed;
  const previewTail = recordingItem?.preview?.tail;

  const recording = phase === "recording";
  const paused = phase === "paused";

  // `toggle()` is asymmetric: `start()` swallows its own failure into `error`
  // state, but `stop()` — and so `toggle()` when it calls `stop()` — rethrows,
  // because its resolved value carries the `Capture` a caller might need next.
  // This button has no further use for that value, but it still must not let the
  // rejection go unhandled, or a failed stop is a console error on top of the
  // `error` state that already reports it.
  const handleToggle = useCallback(() => {
    toggle().catch(() => {
      // Already captured in `error` state above.
    });
  }, [toggle]);

  return (
    <section style={panel}>
      <h2>1 · Capture</h2>
      <div style={{ alignItems: "center", display: "flex", gap: "1.25rem" }}>
        <button
          type="button"
          onClick={handleToggle}
          disabled={busy || phase === "stopping"}
          style={recordButton(recording)}
        >
          {recording || paused ? "■ Stop and queue" : "● Start recording"}
        </button>
        <button
          type="button"
          onClick={paused ? resume : pause}
          disabled={busy || !(recording || paused)}
          style={button}
        >
          {paused ? "▶ Resume" : "❙❙ Pause"}
        </button>
        <div>
          <div style={{ ...monospace, fontSize: "1.6rem" }}>{formatElapsed(elapsedMs)}</div>
          <div style={muted}>phase: {phase}</div>
        </div>
      </div>

      <LevelMeter level={level} scaledLevel={scaledLevel} active={recording} />

      {recording && (previewCommitted?.length || previewTail) && (
        <div data-testid="live-preview" style={{ marginTop: "0.75rem" }}>
          <div style={muted}>live preview (provisional — replaced by the final transcript):</div>
          {previewCommitted && previewCommitted.length > 0 && (
            <p style={{ ...monospace, margin: "0.25rem 0 0" }}>{previewCommitted.join(" ")}</p>
          )}
          {/* The tail is provisional text the system is still rewriting — it will visibly
              change under the reader as the region grows. Italic and muted so it does not
              look identical to the settled committed text above; the design calls this out
              as an honesty requirement, not a polish item. */}
          {previewTail && (
            <p
              data-testid="live-preview-tail"
              style={{ ...monospace, ...muted, fontStyle: "italic", margin: "0.15rem 0 0" }}
            >
              {previewTail}…
            </p>
          )}
        </div>
      )}

      {error !== undefined && <p style={errorBox}>{error.message}</p>}
    </section>
  );
}

/**
 * The input level, as a bar.
 *
 * `level` is the honest RMS of the most recent analyser frame in `[0, 1]` — kept
 * in the numeric readout below because that line exists to document the real
 * value, not a flattering one. `scaledLevel` (from `useRecorder`, `Math.sqrt`
 * under a perceptual curve) is what drives the bar's width: for ordinary speech
 * the raw value sits low enough that a linear bar barely twitches, which reads as
 * a broken meter rather than a quiet room.
 */
function LevelMeter({
  level,
  scaledLevel,
  active,
}: {
  level: number;
  scaledLevel: number;
  active: boolean;
}) {
  const width = `${String(Math.round(scaledLevel * 100))}%`;
  return (
    <div style={{ marginTop: "1rem" }}>
      <div
        style={{
          background: "#eaeef2",
          borderRadius: METER_HEIGHT / 2,
          height: METER_HEIGHT,
          overflow: "hidden",
        }}
      >
        <div
          data-testid="level-meter-fill"
          style={{
            background: active ? "#1f883d" : "#d0d7de",
            height: "100%",
            transition: "width 80ms linear",
            width,
          }}
        />
      </div>
      <div style={muted}>
        input level {level.toFixed(3)}
        {active && level === 0 ? " — silence, or no signal reaching the analyser" : ""}
      </div>
    </div>
  );
}
