import { useCallback, useEffect, useState } from "react";
import type { Outbox, RecorderState } from "@azx/ribo-core";

import { formatElapsed, messageOf } from "./format.js";
import { getRecorder } from "./recorder-handle.js";
import { errorBox, monospace, muted, panel, recordButton } from "./styles.js";

/**
 * @file Start/stop capture, with the two readouts that prove the microphone is
 * live: elapsed time and input level.
 *
 * Both come from `Recorder.subscribe`, which pushes a {@link RecorderState} on
 * every ~100 ms tick and on every phase change, and which calls its listener
 * once immediately so the first paint is never blank. Nothing here polls.
 */

/** Height of the level meter, in pixels. */
const METER_HEIGHT = 14;

export function RecordPanel({ outbox }: { outbox: Outbox }) {
  // The shared, module-scoped Recorder rather than one owned by this component:
  // the update prompt has to be able to ask "is a recording in progress?" from
  // outside the render tree. See `recorder-handle.ts`.
  const recorder = getRecorder();
  const [state, setState] = useState<RecorderState>(() => recorder.state);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  // `subscribe` returns its own unsubscribe handle, so it *is* the cleanup.
  useEffect(() => recorder.subscribe(setState), [recorder]);

  const toggle = useCallback(() => {
    setError(undefined);
    setBusy(true);
    const work =
      recorder.phase === "recording"
        ? recorder.stop().then((capture) => outbox.enqueue(capture))
        : recorder.start();
    void work
      .catch((cause: unknown) => {
        setError(messageOf(cause));
      })
      .finally(() => {
        setBusy(false);
      });
  }, [outbox, recorder]);

  const recording = state.phase === "recording";

  return (
    <section style={panel}>
      <h2>1 · Capture</h2>
      <div style={{ alignItems: "center", display: "flex", gap: "1.25rem" }}>
        <button
          type="button"
          onClick={toggle}
          disabled={busy || state.phase === "stopping"}
          style={recordButton(recording)}
        >
          {recording ? "■ Stop and queue" : "● Start recording"}
        </button>
        <div>
          <div style={{ ...monospace, fontSize: "1.6rem" }}>{formatElapsed(state.elapsedMs)}</div>
          <div style={muted}>phase: {state.phase}</div>
        </div>
      </div>

      <LevelMeter level={state.level} active={recording} />

      {error !== undefined && <p style={errorBox}>{error}</p>}
    </section>
  );
}

/**
 * The input level, as a bar.
 *
 * `level` is the RMS of the most recent analyser frame in `[0, 1]`, which for
 * speech sits low — a linear bar barely twitches. The square root spreads the
 * useful range across the width, which is what makes "the microphone is hearing
 * me" legible rather than a technically accurate sliver.
 */
function LevelMeter({ level, active }: { level: number; active: boolean }) {
  const width = `${String(Math.round(Math.sqrt(level) * 100))}%`;
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
