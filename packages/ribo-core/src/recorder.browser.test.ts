import { afterEach, describe, expect, test, vi } from "vitest";
import { getRxStorageMemory } from "rxdb/plugins/storage-memory";
import { baseRecordingSchema } from "./recording.js";
import {
  DEFAULT_MIME_TYPE_PREFERENCES,
  negotiateMimeType,
  Recorder,
  RecorderError,
  type RecorderPhase,
  type RecorderState,
} from "./recorder.js";
import {
  CAPTURE_LOCK,
  holdLock,
  isLockFree,
  openCaptureSession,
  openOutbox,
} from "./queue/index.js";
import type { CaptureSession } from "./queue/index.js";
import type { Recording } from "./recording.js";

// Browser mode, not jsdom, and the filename says so: `*.browser.test.ts` is the
// discovery contract in vitest.config.ts. Renaming this file to `*.test.ts`
// hands it to the `unit` (node) project, where `MediaRecorder` does not exist
// and every failure below reads as a product bug instead of a config mistake.
//
// `getUserMedia` resolves unattended here because the Playwright launch passes
// `--use-fake-device-for-media-stream` (a synthetic audio source, since CI
// runners have no microphone) and `--use-fake-ui-for-media-stream` (auto-grants
// the permission prompt nobody is there to click). Both live in
// vitest.config.ts and are explained there.
//
// The first `getUserMedia` in a cold Chromium takes ~10s while that fake audio
// subsystem spins up (measured: ~9.9s cold, ~74ms warm). That is why the browser
// project sets a 30s testTimeout. It is not flakiness and must not be "fixed"
// with retries.

/** Recorders started by a test, stopped in `afterEach` so no mic stays hot. */
const started: Recorder<unknown>[] = [];

const startTracked = async (recorder: Recorder<unknown>): Promise<void> => {
  started.push(recorder);
  await recorder.start();
};

afterEach(async () => {
  while (started.length > 0) {
    const recorder = started.pop();
    // `failed` needs cleanup too: the microphone is still open, and stop()
    // accepts it as a valid phase to tear down from.
    if (recorder && (recorder.phase === "recording" || recorder.phase === "failed")) {
      await recorder.stop().catch(() => undefined);
    }
  }
  // The capture lock is released asynchronously (promise resolution → browser
  // lock release), and a failed start() releases it from the catch block without
  // going through stop()/teardown. One `await` in the test is not always enough
  // for the browser to actually release it — a macrotask boundary guarantees
  // the microtask queue has drained and the lock is free for the next test.
  await new Promise((resolve) => setTimeout(resolve, 0));
});

/** Wait without fake timers — real `MediaRecorder` needs real time to pass. */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A `getUserMedia` that rejects the way the browser does, for the sad paths. */
const rejectingGetUserMedia = (name: string, message: string) => () =>
  Promise.reject(new DOMException(message, name));

describe("negotiateMimeType", () => {
  test("prefers Opus-in-WebM on a browser that supports it", () => {
    // Pins what this Chromium actually reports. If a future Chromium drops
    // Opus-in-WebM this fails loudly rather than silently recording something
    // Phase 3's decoder has never seen.
    expect(MediaRecorder.isTypeSupported("audio/webm;codecs=opus")).toBe(true);
    expect(negotiateMimeType()).toBe("audio/webm;codecs=opus");
  });

  test("walks the preference list in order and returns the first supported type", () => {
    expect(
      negotiateMimeType(["audio/definitely-not-a-real-container", "audio/webm;codecs=opus"]),
    ).toBe("audio/webm;codecs=opus");
  });

  test("every default preference is a concrete type, not a wildcard", () => {
    // A bare `audio/webm` with no codecs parameter is legal as a *fallback*,
    // but the entries must never be patterns — `isTypeSupported` does not glob,
    // and a MIME type recorded onto a `Recording` must be one a decoder can act
    // on.
    for (const type of DEFAULT_MIME_TYPE_PREFERENCES) {
      expect(type).toMatch(/^audio\/[a-z0-9.+-]+(;codecs=[a-z0-9,.+-]+)?$/);
    }
    expect(DEFAULT_MIME_TYPE_PREFERENCES[0]).toBe("audio/webm;codecs=opus");
  });

  test("throws an actionable RecorderError when nothing in the list is supported", () => {
    // The alternative — letting MediaRecorder pick its own default — means the
    // `mimeType` on the Recording lies about the container. That breaks Phase 3
    // decoding in a way that is very hard to trace back to here.
    const attempt = () => negotiateMimeType(["audio/nope", "audio/also-nope"]);

    expect(attempt).toThrow(RecorderError);
    expect(attempt).toThrow(/audio\/nope/);
    try {
      attempt();
    } catch (error) {
      expect((error as RecorderError).code).toBe("unsupported-mime-type");
    }
  });
});

describe("Recorder capture", () => {
  test("records real audio and reports the negotiated container", async () => {
    const recorder = new Recorder({ ctx: { jobId: "job_42" } });
    await startTracked(recorder);
    await sleep(700);
    const { recording, audio } = await recorder.stop();

    // Metadata goes through the Phase 1 schema, not a hand-rolled shape check.
    expect(baseRecordingSchema.parse(recording)).toEqual(recording);
    expect(recording.mimeType).toBe("audio/webm;codecs=opus");
    expect(recording.ctx).toEqual({ jobId: "job_42" });
    expect(recording.durationMs).toBeGreaterThanOrEqual(500);
    expect(Date.parse(recording.capturedAt)).toBeLessThanOrEqual(Date.now());

    // Real bytes, in the container we said we produced. `toBeTruthy()` on the
    // blob would pass for an empty one.
    expect(audio.type).toBe(recording.mimeType);
    expect(audio.size).toBeGreaterThan(500);
    expect((await audio.arrayBuffer()).byteLength).toBe(audio.size);
  });

  test("gives every recording a distinct id", async () => {
    const recorder = new Recorder();
    await startTracked(recorder);
    await sleep(150);
    const first = await recorder.stop();
    await startTracked(recorder);
    await sleep(150);
    const second = await recorder.stop();

    expect(first.recording.id).not.toBe(second.recording.id);
    expect(recorder.phase).toBe("idle");
  });

  test("releases the media stream on stop", async () => {
    // A recorder that leaves the mic hot is a privacy problem in a field tool,
    // and the browser leaves its recording indicator lit. This is the assertion
    // that keeps it honest.
    let captured: MediaStream | undefined;
    const recorder = new Recorder({
      getUserMedia: async (constraints) => {
        captured = await navigator.mediaDevices.getUserMedia(constraints);
        return captured;
      },
    });

    await startTracked(recorder);
    expect(captured?.getAudioTracks().every((track) => track.readyState === "live")).toBe(true);

    await sleep(150);
    await recorder.stop();

    expect(captured?.getAudioTracks()).not.toHaveLength(0);
    expect(captured?.getAudioTracks().every((track) => track.readyState === "ended")).toBe(true);
    expect(captured?.active).toBe(false);
  });
});

describe("Recorder observation", () => {
  test("emits elapsed time and input level while recording", async () => {
    const recorder = new Recorder({ tickMs: 50 });
    const states: { phase: string; elapsedMs: number; level: number }[] = [];
    const unsubscribe = recorder.subscribe((state) => states.push({ ...state }));

    // Subscribers get the current state immediately, so a UI can paint before
    // the first tick.
    expect(states).toHaveLength(1);
    expect(states[0]).toEqual({ phase: "idle", elapsedMs: 0, level: 0, error: undefined });

    await startTracked(recorder);
    await sleep(700);
    await recorder.stop();
    unsubscribe();

    const ticks = states.filter((state) => state.phase === "recording");
    expect(ticks.length).toBeGreaterThanOrEqual(5);
    expect(ticks.at(-1)!.elapsedMs).toBeGreaterThan(ticks[0]!.elapsedMs);
    expect(ticks.every((tick) => tick.level >= 0 && tick.level <= 1)).toBe(true);
    // The fake device is a real generated signal, so a level pinned at zero
    // means the analyser is not wired to the stream.
    expect(Math.max(...ticks.map((tick) => tick.level))).toBeGreaterThan(0);
    expect(states.at(-1)).toEqual({ phase: "idle", elapsedMs: 0, level: 0, error: undefined });
  });

  test("stops delivering to an unsubscribed listener", async () => {
    const recorder = new Recorder({ tickMs: 25 });
    let calls = 0;
    const unsubscribe = recorder.subscribe(() => (calls += 1));
    unsubscribe();
    const after = calls;

    await startTracked(recorder);
    await sleep(200);
    await recorder.stop();

    expect(calls).toBe(after);
  });

  test("exposes elapsedMs and level without subscribing", async () => {
    const recorder = new Recorder();
    expect(recorder.elapsedMs).toBe(0);

    await startTracked(recorder);
    await sleep(200);
    expect(recorder.elapsedMs).toBeGreaterThan(100);

    await recorder.stop();
    expect(recorder.elapsedMs).toBe(0);
  });
});

describe("Recorder failure modes", () => {
  test("maps a denied permission to a permission-denied error", async () => {
    const recorder = new Recorder({
      getUserMedia: rejectingGetUserMedia("NotAllowedError", "Permission denied"),
    });

    await expect(recorder.start()).rejects.toMatchObject({
      name: "RecorderError",
      code: "permission-denied",
    });
    expect(recorder.phase).toBe("idle");
  });

  test("maps a missing microphone to a no-input-device error", async () => {
    const recorder = new Recorder({
      getUserMedia: rejectingGetUserMedia("NotFoundError", "Requested device not found"),
    });

    await expect(recorder.start()).rejects.toMatchObject({
      name: "RecorderError",
      code: "no-input-device",
    });
    expect(recorder.phase).toBe("idle");
  });

  test("keeps the original browser error as the cause", async () => {
    const recorder = new Recorder({
      getUserMedia: rejectingGetUserMedia("NotAllowedError", "Permission denied"),
    });

    const error = await recorder.start().catch((thrown: unknown) => thrown as RecorderError);

    expect(error).toBeInstanceOf(RecorderError);
    expect((error as RecorderError).cause).toBeInstanceOf(DOMException);
  });

  test("rejects start() while already recording, without disturbing the capture", async () => {
    const recorder = new Recorder();
    await startTracked(recorder);

    await expect(recorder.start()).rejects.toMatchObject({ code: "already-recording" });

    await sleep(150);
    const { audio } = await recorder.stop();
    expect(audio.size).toBeGreaterThan(0);
  });

  test("rejects stop() before start()", async () => {
    const recorder = new Recorder();

    await expect(recorder.stop()).rejects.toMatchObject({ code: "not-recording" });
  });

  test("rejects stop() twice", async () => {
    const recorder = new Recorder();
    await startTracked(recorder);
    await sleep(150);
    await recorder.stop();

    await expect(recorder.stop()).rejects.toMatchObject({ code: "not-recording" });
  });

  test("releases the stream when the recorder cannot be constructed", async () => {
    // Acquiring the mic succeeds, then setup fails. The stream must still be
    // released — otherwise a failed start leaves the indicator lit forever.
    let captured: MediaStream | undefined;
    const recorder = new Recorder({
      mimeTypes: ["audio/webm;codecs=opus"],
      getUserMedia: async (constraints) => {
        captured = await navigator.mediaDevices.getUserMedia(constraints);
        return captured;
      },
      createRecorder: () => {
        throw new TypeError("boom");
      },
    });

    await expect(recorder.start()).rejects.toMatchObject({ code: "capture-failed" });
    expect(captured?.getAudioTracks().every((track) => track.readyState === "ended")).toBe(true);
    expect(recorder.phase).toBe("idle");
  });
});

describe("Recorder pause and resume", () => {
  test("pausing and resuming keeps the phase honest", async () => {
    const recorder = new Recorder();
    const phases: RecorderPhase[] = [];
    const stop = recorder.subscribe((state) => phases.push(state.phase));

    await recorder.start();
    recorder.pause();
    expect(recorder.phase).toBe("paused");
    recorder.resume();
    expect(recorder.phase).toBe("recording");
    await recorder.stop();

    stop();
    expect(phases).toContain("paused");
    expect(recorder.phase).toBe("idle");
  });

  test("elapsed time excludes the paused span", async () => {
    const recorder = new Recorder();
    await recorder.start();
    await sleep(150);
    recorder.pause();
    const atPause = recorder.elapsedMs;

    await sleep(300);
    // The whole point: a paused recorder is not accruing duration.
    expect(recorder.elapsedMs).toBe(atPause);

    recorder.resume();
    await sleep(150);
    const { recording } = await recorder.stop();

    // ~300ms of real recording across a 300ms pause. Generous bounds: this asserts
    // the pause is excluded, not the precision of a timer under a headless browser.
    expect(recording.durationMs).toBeGreaterThanOrEqual(250);
    expect(recording.durationMs).toBeLessThan(560);
  });

  test("level reads zero while paused", async () => {
    const recorder = new Recorder();
    await recorder.start();
    await sleep(150);
    recorder.pause();
    expect(recorder.level).toBe(0);
    await recorder.stop();
  });

  test("#tick does not resample the analyser while paused", async () => {
    // The microphone stays open while paused (see Recorder.pause), so the analyser
    // keeps tapping a live stream unless #tick's own guard stops it. A `level`-based
    // assertion cannot prove this reliably: measured against this Chromium's fake
    // audio device, the synthetic tone reads as ~0 RMS for roughly the first second
    // of a stream (it ramps up only after that), so `expect(recorder.level).toBe(0)`
    // would pass at this timing whether or not the guard exists — confirmed by
    // temporarily deleting the guard and re-running this suite, which left the
    // level-based assertion above green. Spying on the analyser call itself proves
    // the guard fires, independent of what the fake signal happens to be doing.
    const spy = vi.spyOn(AnalyserNode.prototype, "getByteTimeDomainData");
    try {
      const recorder = new Recorder();
      await recorder.start();
      await sleep(150);
      recorder.pause();
      const callsAtPause = spy.mock.calls.length;

      // Two-plus tick intervals (default tickMs is 100): #tick's ticker keeps firing
      // while paused, so this proves the guard returns early rather than the ticker
      // having stopped.
      await sleep(250);
      expect(spy.mock.calls.length).toBe(callsAtPause);

      await recorder.stop();
    } finally {
      // A GLOBAL prototype spy: a red assertion above must not leave it patched
      // for the rest of the file — every later test in this suite shares this
      // one `AnalyserNode.prototype`.
      spy.mockRestore();
    }
  });

  test("stop works from paused, and releases the microphone", async () => {
    const recorder = new Recorder();
    await recorder.start();
    recorder.pause();
    const { recording, audio } = await recorder.stop();
    expect(recording.durationMs).toBeGreaterThanOrEqual(0);
    expect(audio.size).toBeGreaterThan(0);
    expect(recorder.phase).toBe("idle");
  });

  test("pause and resume refuse the phases they cannot serve", async () => {
    const recorder = new Recorder();
    expect(() => recorder.pause()).toThrow(
      expect.objectContaining({ name: "RecorderError", code: "not-recording" }),
    );
    expect(() => recorder.resume()).toThrow(
      expect.objectContaining({ name: "RecorderError", code: "not-recording" }),
    );

    await recorder.start();
    expect(() => recorder.resume()).toThrow(
      expect.objectContaining({ name: "RecorderError", code: "already-recording" }),
    );
    recorder.pause();
    expect(() => recorder.pause()).toThrow(
      expect.objectContaining({ name: "RecorderError", code: "not-recording" }),
    );
    await recorder.stop();
  });

  test("a paused recorder cannot be started again", async () => {
    const recorder = new Recorder();
    await recorder.start();
    recorder.pause();
    await expect(recorder.start()).rejects.toThrow(
      expect.objectContaining({ code: "already-recording" }),
    );
    await recorder.stop();
  });
});

describe("Recorder mid-capture failure", () => {
  // A `createRecorder` that wraps the real `MediaRecorder` and dispatches a
  // synthetic `error` event on it after a delay. `dispatchEvent` fires the
  // event on the target's listeners without triggering the browser's internal
  // error handling, so the recorder keeps running normally — which is exactly
  // the shape we need: the error handler fires, but `stop()` can still call
  // `recorder.stop()` and flush chunks. The real failure mode this stands in
  // for (device disconnect, track ending, quota exhaustion) may or may not
  // leave the recorder `inactive` on its own; our `stop()` handles both.
  const recorderThatErrorsAfter =
    (
      ms: number,
      errorName = "NotReadableError",
      errorMessage = "The track ended prematurely.",
    ): ((stream: MediaStream, options: MediaRecorderOptions) => MediaRecorder) =>
    (stream, options) => {
      const recorder = new MediaRecorder(stream, options);
      setTimeout(() => {
        recorder.dispatchEvent(
          new ErrorEvent("error", { error: new DOMException(errorMessage, errorName) }),
        );
      }, ms);
      return recorder;
    };

  test("surfaces the failure on the observable state the moment it happens", async () => {
    const recorder = new Recorder({
      tickMs: 50,
      createRecorder: recorderThatErrorsAfter(150),
    });
    const states: RecorderState[] = [];
    const unsubscribe = recorder.subscribe((state) => states.push({ ...state }));

    await startTracked(recorder);
    // Wait long enough for the error to fire and the state to settle.
    await sleep(400);

    // The phase is honestly not "recording" — a UI that switches on it sees
    // `failed`, not a lie.
    expect(recorder.phase).toBe("failed");
    expect(recorder.state.error).toBeInstanceOf(RecorderError);
    expect(recorder.state.error?.code).toBe("capture-failed");

    // A subscriber saw the transition: the `failed` phase was emitted with the
    // error, not held back until stop().
    const failedStates = states.filter((s) => s.phase === "failed");
    expect(failedStates.length).toBeGreaterThanOrEqual(1);
    expect(failedStates[0]!.error).toBeInstanceOf(RecorderError);
    expect(failedStates[0]!.error?.code).toBe("capture-failed");

    await recorder.stop().catch(() => undefined);
    unsubscribe();
  });

  test("stop() rejects with the same error and tears down to idle", async () => {
    const recorder = new Recorder({
      createRecorder: recorderThatErrorsAfter(100),
    });
    await startTracked(recorder);
    await sleep(250);

    expect(recorder.phase).toBe("failed");
    const failure = recorder.state.error;
    expect(failure).toBeInstanceOf(RecorderError);

    // The same failure object — not a new one minted at stop time.
    await expect(recorder.stop()).rejects.toBe(failure);

    // Teardown ran: the recorder is idle, the mic is released, the error is
    // cleared so a fresh start() begins clean.
    expect(recorder.phase).toBe("idle");
    expect(recorder.state.error).toBeUndefined();
  });

  test("remains reusable after a mid-capture failure", async () => {
    const recorder = new Recorder({
      createRecorder: recorderThatErrorsAfter(100),
    });
    await startTracked(recorder);
    await sleep(250);
    await recorder.stop().catch(() => undefined);
    expect(recorder.phase).toBe("idle");

    // Second capture with a real recorder — no fake error.
    const second = new Recorder();
    await startTracked(second);
    await sleep(200);
    const { audio } = await second.stop();
    expect(audio.size).toBeGreaterThan(0);
    expect(second.phase).toBe("idle");
  });

  test("freezes elapsedMs at the moment of failure", async () => {
    const recorder = new Recorder({
      tickMs: 50,
      createRecorder: recorderThatErrorsAfter(200),
    });
    await startTracked(recorder);
    await sleep(300); // error fires at ~200ms

    const elapsedAtFailure = recorder.elapsedMs;
    expect(elapsedAtFailure).toBeGreaterThan(100);

    await sleep(200);
    // elapsedMs is frozen — it does not keep advancing after the failure.
    expect(recorder.elapsedMs).toBe(elapsedAtFailure);

    await recorder.stop().catch(() => undefined);
  });

  test("level reads zero after the failure", async () => {
    // The fake audio device reads ~0 RMS for roughly the first second before
    // ramping up (measured — see the `#tick does not resample the analyser
    // while paused` test for the same caveat). Firing the error at 150ms would
    // leave the level at zero whether or not the error handler zeroes it and
    // the tick guard fires — confirmed by mutation: removing both `this.#level
    // = 0` and the `failed` tick guard left this test green. Firing at 1200ms
    // means the signal is already non-zero, so without the zeroing and the
    // guard the tick would push the live level back up after the failure.
    const recorder = new Recorder({
      tickMs: 50,
      createRecorder: recorderThatErrorsAfter(1200),
    });
    await startTracked(recorder);
    // Wait for the signal to ramp up and confirm the level is genuinely
    // non-zero before the error fires.
    await sleep(1100);
    expect(recorder.level).toBeGreaterThan(0);

    // Error fires at ~1200ms; wait for it to land and for a few ticks to
    // have had a chance to overwrite the level if the guard were missing.
    await sleep(300);

    // The analyser is still tapping a live stream (the mic has not been
    // released yet), but the error handler zeroed the level and the tick guard
    // keeps it there.
    expect(recorder.level).toBe(0);
    expect(recorder.state.level).toBe(0);

    await recorder.stop().catch(() => undefined);
  });

  test("start and pause refuse on a failed recorder", async () => {
    const recorder = new Recorder({
      createRecorder: recorderThatErrorsAfter(100),
    });
    await startTracked(recorder);
    await sleep(250);

    expect(recorder.phase).toBe("failed");

    // start() refuses — the recorder is not idle, stop() must tear down first.
    await expect(recorder.start()).rejects.toMatchObject({ code: "already-recording" });
    // pause() refuses — there is nothing recording to pause.
    expect(() => recorder.pause()).toThrow(
      expect.objectContaining({ name: "RecorderError", code: "not-recording" }),
    );

    await recorder.stop().catch(() => undefined);
  });
});

describe("Recorder durable capture", () => {
  test("start refuses when another tab holds the lock, WITHOUT prompting for the microphone", async () => {
    // Refusing before the microphone matters: the recording indicator must not
    // light on the way to throwing.
    const getUserMedia = vi.fn();
    let releaseLock!: () => void;
    const held = await holdLock(
      CAPTURE_LOCK,
      () =>
        new Promise<void>((resolve) => {
          releaseLock = resolve;
        }),
    );
    expect(held).toBeDefined();

    const outbox = await openOutbox({
      name: `t-${crypto.randomUUID()}`,
      storage: getRxStorageMemory(),
    });
    const factory = ({
      recording,
      sourceId,
      mimeType,
    }: {
      recording: Recording;
      sourceId: string;
      mimeType: string;
    }): Promise<CaptureSession> => openCaptureSession({ outbox, recording, sourceId, mimeType });
    const recorder = new Recorder({
      getUserMedia,
      captureSession: factory,
    });

    try {
      await expect(recorder.start()).rejects.toThrow(/another tab|busy/i);
      expect(getUserMedia).not.toHaveBeenCalled();
    } finally {
      // Release the lock even if the assertion fails, so later tests are not poisoned.
      releaseLock();
      await held!.released;
      await outbox.close();
    }
  });

  test("a failure after the row is created unwinds it and releases the lock", async () => {
    // The factory creates the recording row (via openCaptureSession), then
    // recorder.start(timeslice) throws — the catch in start() must teardown,
    // which aborts the session (removing the row) and releases the lock.
    const outbox = await openOutbox({
      name: `t-${crypto.randomUUID()}`,
      storage: getRxStorageMemory(),
    });
    const factory = ({
      recording,
      sourceId,
      mimeType,
    }: {
      recording: Recording;
      sourceId: string;
      mimeType: string;
    }): Promise<CaptureSession> => openCaptureSession({ outbox, recording, sourceId, mimeType });
    const recorder = new Recorder({
      captureSession: factory,
      createRecorder: (stream: MediaStream, options: MediaRecorderOptions) => {
        const r = new MediaRecorder(stream, options);
        // Fail at recorder.start(timeslice) — AFTER the factory has created the row.
        r.start = () => {
          throw new DOMException("boom", "InvalidStateError");
        };
        return r;
      },
    });

    await expect(recorder.start()).rejects.toThrow();
    await vi.waitFor(async () => {
      expect(await isLockFree(CAPTURE_LOCK)).toBe(true);
    });
    await vi.waitFor(async () => {
      const rows = await outbox.list({ status: ["recording"] });
      expect(rows).toHaveLength(0);
    });
    await outbox.close();
  });

  test("enqueue-free recording still takes the lock and still gets no durability", async () => {
    const recorder = new Recorder({});
    started.push(recorder);
    const id = await recorder.start();
    expect(id).toBeUndefined();
    // Two tabs recording at once is wrong either way — the lock is held
    // regardless of whether durable capture is configured.
    expect(await isLockFree(CAPTURE_LOCK)).toBe(false);
    await recorder.stop();
    // stop() releases the lock.
    expect(await isLockFree(CAPTURE_LOCK)).toBe(true);
  });
});
