import { openCaptureSession, Recorder } from "@azx/ribo-core";
import type { SampleTapOptions, SampleTapTeardown } from "@azx/ribo-core";

import workletUrl from "./pcm-worklet.ts?worker&url";

import { closeLiveSession, feedFrame, openLiveForCapture } from "./live-handle.js";
import { getOutbox } from "./outbox-handle.js";

/**
 * The sample rate the live path operates at — Silero VAD's frame rate. The
 * `AudioContext` is constructed at this rate so the browser resamples the
 * `MediaStream` to 16 kHz before the worklet sees it.
 */
const LIVE_SAMPLE_RATE = 16000;

/** Matches the name in `@azx/ribo-core`'s `worklet.ts` `registerProcessor` call. */
const PCM_PROCESSOR_NAME = "pcm-frame-processor";

/**
 * Playground-owned sample tap: loads the `AudioWorklet` from
 * `./pcm-worklet.ts` (which re-exports `@azx/ribo-core/worklet`) and wires it
 * to `onSamples`.
 *
 * This mirrors `whisper-store.ts`'s `createWorker` injection for the same
 * reason (AGENTS.md §5.2): the default `createSampleTap` in `ribo-core`'s
 * `Recorder` uses `new URL("./worklet.js", import.meta.url)`, which under the
 * `@azx/source` condition resolves to `src/worklet.js` — a file that does not
 * exist because the source is TypeScript. The failure is swallowed, so
 * recording works and frames silently never arrive. Loading from a
 * playground-owned `.ts` file lets Vite transform and serve it in dev mode and
 * emit it as a separate asset in production.
 *
 * The teardown also closes the live session — a worklet left on a dead stream
 * is a leak, and the live session must close when recording stops.
 */
const createSampleTap = async ({
  stream,
  onSamples,
}: SampleTapOptions): Promise<SampleTapTeardown> => {
  const audioContext = new AudioContext({ sampleRate: LIVE_SAMPLE_RATE });
  try {
    // `?worker&url`, NOT `new URL("./pcm-worklet.ts", import.meta.url)`.
    //
    // Vite special-cases `new Worker(new URL(…))` and compiles the target; a bare `new URL` to a
    // `.ts` file is not that pattern, so nothing was emitted and the href pointed at a file the build
    // never produced. `addModule` rejected, the recorder's fire-and-forget `.catch` swallowed it, and
    // the result was a perfect recording whose preview never appeared with no error anywhere —
    // confirmed by instrumenting: the live session opened, then received exactly zero frames.
    //
    // `?worker&url` compiles the module and hands back the built asset's URL, which is the documented
    // way to load a worklet under Vite.
    await audioContext.audioWorklet.addModule(workletUrl);
  } catch (error) {
    void audioContext.close().catch(() => undefined);
    throw error;
  }
  let node: AudioWorkletNode;
  try {
    node = new AudioWorkletNode(audioContext, PCM_PROCESSOR_NAME);
  } catch (error) {
    void audioContext.close().catch(() => undefined);
    throw error;
  }
  void audioContext.resume().catch(() => undefined);
  node.port.onmessage = (event) => {
    try {
      onSamples(event.data as Float32Array);
    } catch {
      /* the caller's callback is the caller's problem; capture is not */
    }
  };
  audioContext.createMediaStreamSource(stream).connect(node);
  return () => {
    node.port.close();
    node.disconnect();
    void audioContext.close().catch(() => undefined);
    closeLiveSession();
  };
};

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
    captureSession: async ({ recording, sourceId, mimeType }) => {
      const outbox = await getOutbox();
      const session = await outbox.openSession({ ctx: recording.ctx, ref: "playground" });
      const captureSession = await openCaptureSession({
        outbox,
        recording,
        sourceId,
        mimeType,
        sessionId: session.id,
      });
      // Fire-and-forget: recording starts immediately, the live session opens
      // async. Frames arriving before the session is open are silently dropped
      // by `feedFrame` — live must never degrade recording.
      void openLiveForCapture(recording, captureSession.itemId);
      return captureSession;
    },
    onSamples: (frame) => feedFrame(frame),
    createSampleTap,
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
