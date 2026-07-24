import { Recorder } from "@azx/ribo-core";

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

/** The shared recorder, constructing it on first call. */
export function getRecorder(): Recorder {
  handle ??= new Recorder();
  if (hotData) hotData.recorder = handle;
  return handle;
}

/**
 * Whether capture is underway right now.
 *
 * `stopping` counts. The bytes are still being flushed out of `MediaRecorder`
 * and handed to the outbox at that point, so a reload during `stopping` loses
 * the recording just as completely as one during `recording` — it merely looks
 * safer.
 */
export function isCapturing(): boolean {
  return getRecorder().phase !== "idle";
}
