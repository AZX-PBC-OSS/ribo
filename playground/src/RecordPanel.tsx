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
  const recordingItem = recordingItems[0];
  const previewSegments = recordingItem?.preview?.segments;

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

      {recording && previewSegments && previewSegments.length > 0 && (
        <div data-testid="live-preview" style={{ marginTop: "0.75rem" }}>
          <div style={muted}>live preview (provisional — replaced by the final transcript):</div>
          <p style={{ ...monospace, margin: "0.25rem 0 0" }}>{previewSegments.join(" ")}</p>
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
