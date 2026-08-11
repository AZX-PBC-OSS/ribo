import { openCaptureSession, Recorder } from "@azx/ribo-core";

import { getOutbox } from "./outbox-handle.js";

/**
 * @file One {@link Recorder} per page load, shared by every component.
 *
 * It is a module singleton for the same reason the outbox is
 * (`outbox-handle.ts`) — StrictMode's double mount and Vite's module
 * replacement both otherwise produce a second instance holding a second
 * microphone stream — and for one reason the outbox does not have:
 *
 * **The update prompt needs to know whether a recording is in progress.**
 * "In progress" is `recorder.phase !== "idle"`, and that state lives in the
 * `Recorder`. If `RecordPanel` owned the recorder in component state, the only
 * component that could answer the question would be the one component that must
 * not be asked — `UpdatePanel` is rendered as a sibling, and prop-drilling a
 * recorder through `App` just to gate a service-worker message would put
 * capture state in the render tree, where a remount resets it. A module
 * singleton gives both the panel and the non-React guard in `update-store.ts`
 * one authoritative answer.
 *
 * `import.meta.hot.data` carries the instance across HMR replacements so an edit
 * to this file mid-capture does not orphan a live `MediaRecorder`.
 */

interface HotData {
  recorder?: Recorder;
}

const hotData = import.meta.hot?.data as HotData | undefined;

let handle: Recorder | undefined = hotData?.recorder;

/**
 * The shared recorder, constructing it on first call.
 *
 * **`captureSession` is what makes capture durable.** With it, `start()` inserts
 * a `recording` row and `MediaRecorder` runs with a timeslice, so each
 * `dataavailable` is written as its own attachment; without it the recorder
 * keeps every chunk in memory until `stop()`, and an interrupted recording is
 * simply gone.
 *
 * The factory is `async` and is called at `start()`, which is what dissolves the
 * apparent ordering problem: this handle is a *synchronous* singleton, but the
 * outbox opens asynchronously. Nothing here has to await anything — `getOutbox()`
 * hands back a promise the factory can await at the one moment an outbox is
 * actually needed, long after it has resolved in practice.
 */
export function getRecorder(): Recorder {
  handle ??= new Recorder({
    captureSession: async ({ recording, sourceId, mimeType }) =>
      await openCaptureSession({ outbox: await getOutbox(), recording, sourceId, mimeType }),
  });
  if (hotData) hotData.recorder = handle;
  return handle;
}

/**
 * Whether capture is underway right now.
 *
 * `stopping` counts, and now for a narrower reason than it used to. Durable
 * capture means an interrupted recording is no longer *lost* — every flushed
 * chunk is on disk, and startup recovery turns them back into a queued row. What
 * a reload during `stopping` still costs is the tail: whatever `MediaRecorder`
 * has buffered since the last timeslice, plus the merge and decode-verify that
 * `finalize()` was in the middle of. Interrupting is no longer catastrophic, but
 * it is still worse than waiting a moment.
 */
export function isCapturing(): boolean {
  return getRecorder().phase !== "idle";
}
