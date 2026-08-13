import type { LiveSession, LiveTranscriber, Outbox, Recording } from "@azx/ribo-core";
import { OnDeviceLiveTranscriber } from "@azx/ribo-transcriber-ondevice";

import { getOutbox } from "./outbox-handle.js";

/**
 * @file Host-owned {@link LiveTranscriber} singleton and live-session lifecycle.
 *
 * Mirrors `whisper-store.ts`'s pattern: a module singleton, constructed on first
 * use, shared by every component. The live transcriber is held beside the
 * recorder/outbox/coordinator handles and wired through `RiboProvider` so the
 * hook layer can report live availability.
 *
 * ## Why the playground manages the session, not the hook
 *
 * `useRecorder` calls `recorder.start()`, and the `captureSession` factory —
 * which the recorder handle owns — is where the `Recording` metadata is
 * available. The hook never sees the `Recording` object, so it cannot call
 * `liveTranscriber.openSession(recording)` directly. Instead, the capture
 * session factory calls {@link openLiveSession} after inserting the row, and
 * the `createSampleTap` teardown calls {@link closeLiveSession} when recording
 * stops. The hook's `start()`/`stop()` trigger both indirectly through
 * `recorder.start()`/`recorder.stop()`, which is what "useRecorder opens and
 * closes a live session" means in practice.
 *
 * ## Live must never degrade recording
 *
 * Every failure path in {@link openLiveSession} ends with recording continuing
 * and no preview. The `onSamples` callback on the `Recorder` forwards to
 * {@link feedFrame}, which is a no-op when no session is open — so frames are
 * silently dropped if the session failed to open, and capture is unaffected.
 */

/** Same-origin ORT runtime base served by `serveOrtRuntime` in `vite.config.ts`. */
const WASM_PATHS = "/ort/";

interface HotData {
  transcriber?: LiveTranscriber;
}

const hotData = import.meta.hot?.data as HotData | undefined;

let transcriber: LiveTranscriber | undefined = hotData?.transcriber;

/**
 * The shared live transcriber, constructing on first call.
 *
 * One instance for the whole app: the worker it creates is reused across
 * recordings. `createWorker` is injected for the same reason
 * `whisper-store.ts` injects it — the Vite library-mode worker bug
 * (vitejs/vite#15618). The live transcriber's worker is separate from the
 * batch transcriber's; sharing one worker is a future optimisation, not a
 * requirement.
 */
export function getLiveTranscriber(): LiveTranscriber {
  transcriber ??= new OnDeviceLiveTranscriber({
    wasmPaths: WASM_PATHS,
    dtype: "fp32",
    createWorker: () =>
      new Worker(new URL("./whisper.worker.ts", import.meta.url), { type: "module" }),
  });
  if (hotData) hotData.transcriber = transcriber;
  return transcriber;
}

/**
 * Replace the live transcriber — test-only.
 *
 * The browser test injects a fake so a preview segment can appear without
 * downloading the Moonshine + Silero models (~250 MB). The fake's
 * `openSession` returns a session whose `segments$` emits on demand.
 */
export function setLiveTranscriber(t: LiveTranscriber | undefined): void {
  transcriber = t;
}

/**
 * Download the streaming VAD, so a live preview can ever start.
 *
 * **The feature cannot turn on without this.** `liveCapability()` requires both the ASR and Silero
 * cached; the only code that fetches Silero runs inside the live worker's session open, which is
 * behind that gate. Priming the ASR alone leaves the gate reporting `needs-download` forever and the
 * preview silently absent — recording perfect, no error anywhere. `whisper-store.ts` calls this from
 * the same button that primes the ASR.
 *
 * Tolerant of a transcriber without `prime` because tests inject a fake through
 * {@link setLiveTranscriber}, and a fake needs no models. A real one always has it.
 */
export async function primeLiveModels(): Promise<void> {
  const t = getLiveTranscriber() as Partial<OnDeviceLiveTranscriber>;
  if (typeof t.prime === "function") await t.prime();
}

/** The currently open live session, or `undefined` when none is open. */
let currentSession: LiveSession | undefined;

/** Subscription to `currentSession.segments$`, torn down on close. Minimal — just `unsubscribe`. */
let segmentSubscription: { unsubscribe: () => void } | undefined;

/** Subscription to `currentSession.errors$`, torn down on close. */
let errorSubscription: { unsubscribe: () => void } | undefined;

/**
 * Monotonic generation counter, incremented on every {@link openLiveSession}
 * and {@link closeLiveSession} call. A pending `openLiveSession` that was
 * superseded by a newer open or a close sees a stale generation and aborts —
 * preventing a late open from installing a session whose lifecycle nobody
 * manages.
 *
 * The race this guards: `openLiveForCapture` is fire-and-forget from the
 * capture session factory, so `openLiveSession` runs asynchronously. If
 * `recorder.stop()` (and thus `closeLiveSession`) arrives while
 * `liveCapability()` or `openSession()` is still pending, the late open would
 * set `currentSession` and `segmentSubscription` *after* close cleared them —
 * a session opened after recording ended, whose subscription leaks forever
 * because nobody will call `closeLiveSession` again. The generation check
 * makes the late open close its own session and bail.
 */
let liveGeneration = 0;

/**
 * Open a live session and connect its segments to the outbox row.
 *
 * Called by the `captureSession` factory after `beginRecording` inserts the
 * row — `itemId` is the row the preview is committed to. Best-effort:
 * if the live transcriber is unavailable, not ready, or `openSession` throws,
 * recording continues with no preview. The `onSamples` callback on the
 * `Recorder` forwards to {@link feedFrame}, which is a no-op when no session
 * is open.
 */
export async function openLiveSession(
  recording: Recording,
  itemId: string,
  outbox: Outbox,
): Promise<void> {
  const myGeneration = ++liveGeneration;
  const liveTranscriber = getLiveTranscriber();
  try {
    const capability = await liveTranscriber.liveCapability();
    if (capability.status !== "ready") return;
    const session = await liveTranscriber.openSession(recording);
    // closeLiveSession (or a newer openLiveSession) may have been called while
    // we were awaiting liveCapability/openSession. A session installed after
    // its close is a leak: its subscription would never be torn down and its
    // segments would be committed to a row that has already moved past
    // recording. Close the orphan and bail.
    if (myGeneration !== liveGeneration) {
      session.close();
      return;
    }
    currentSession = session;
    segmentSubscription = session.segments$.subscribe((text) => {
      console.log(`@@LIVE@@ host: segment received ${JSON.stringify(text)} -> item ${itemId}`);
      void outbox.commitPreview(itemId, text).then(
        () => console.log("@@LIVE@@ host: commitPreview OK"),
        (e: unknown) => console.log("@@LIVE@@ host: commitPreview FAILED", e),
      );
    });
    // Surface live errors to the console so a mid-session failure is visible, not silent.
    // Live is best-effort: the error must never affect recording, and it does not — this
    // subscription only logs. The batch pass after `stop()` recovers the full transcript.
    errorSubscription = session.errors$.subscribe((message) => {
      console.warn("[ribo live] preview error:", message);
    });
  } catch {
    // Live must never degrade recording — a failed open is silently no-preview.
  }
}

/** Close the current live session and clear all live state. Idempotent. */
export function closeLiveSession(): void {
  // Supersede any pending openLiveSession — a late open after close is a leak.
  liveGeneration++;
  segmentSubscription?.unsubscribe();
  segmentSubscription = undefined;
  errorSubscription?.unsubscribe();
  errorSubscription = undefined;
  currentSession?.close();
  currentSession = undefined;
}

/**
 * Feed one 512-sample frame to the current live session.
 *
 * Called by the `Recorder`'s `onSamples` callback. A no-op when no session is
 * open — frames are silently dropped, and capture continues unaffected.
 */
export function feedFrame(frame: Float32Array): void {
  currentSession?.feed(frame);
}

/**
 * Open a live session for a capture session's recording.
 *
 * Wraps {@link openLiveSession} with the outbox resolved from the shared
 * handle, so the `captureSession` factory in `recorder-handle.ts` can call it
 * without awaiting `getOutbox()` separately.
 */
export async function openLiveForCapture(recording: Recording, itemId: string): Promise<void> {
  try {
    const outbox = await getOutbox();
    await openLiveSession(recording, itemId, outbox);
  } catch {
    // Live must never degrade recording.
  }
}
