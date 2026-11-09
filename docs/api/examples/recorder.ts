/**
 * The type-checked example behind docs/api/recorder.html.
 *
 * Constructing a `Recorder` and driving a capture needs `MediaRecorder`, a
 * microphone and an `AudioContext` — browser globals the node runner does not
 * have — so this file is never executed. It is type-checked by the examples
 * tsconfig (see docs/api/index.md), so the shapes shown on the page are real.
 * Runtime behaviour is covered by `packages/ribo-core/src/recorder.test.ts`.
 */

import { negotiateMimeType, type RecorderState, Recorder } from "@azx/ribo-core";

// #region usage
const recorder = new Recorder({ ctx: { jobId: "job-1" } });

// The listener fires immediately with the current state, then on every tick —
// a UI never polls and never renders a blank frame.
const stopWatching = recorder.subscribe((state: RecorderState) => {
  console.log(state.phase, state.elapsedMs, state.level);
});

await recorder.start();
const { recording, audio } = await recorder.stop();
stopWatching();
// #endregion usage

// #region mime-negotiation
// Probes MediaRecorder.isTypeSupported against the preference list, best
// first. Throws RecorderError("unsupported-mime-type") when none is supported
// — louder than falling back to a container the bytes may not match.
const mimeType = negotiateMimeType(["audio/webm;codecs=opus"]);
// #endregion mime-negotiation

console.log(recording.id, mimeType, audio.size);
