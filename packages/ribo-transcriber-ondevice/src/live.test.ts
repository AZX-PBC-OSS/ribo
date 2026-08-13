import { describe, expect, test } from "vitest";

import type { LiveSession, Recording } from "@azx/ribo-core";

import { OnDeviceLiveTranscriber } from "./index.js";
import { DEFAULT_MODEL_ID, STREAMING_VAD_MODEL_ID } from "./config.js";
import { TRANSFORMERS_CACHE_NAME } from "./model-cache.js";
import type { MainToWorkerMessage, WorkerToMainMessage } from "./protocol.js";

// ── Test doubles ──────────────────────────────────────────────────────────────
//
// The two tests below drive the main-thread LiveSession with a scriptable worker
// double. No model loads, no browser needed — the double emits canned replies on
// a schedule that makes the non-blocking and late-reply properties assertable.

const recording: Recording = {
  id: "rec-live-1",
  capturedAt: "2026-08-12T10:00:00.000Z",
  durationMs: 0,
  mimeType: "audio/webm;codecs=opus",
  ctx: {},
};

/**
 * Scriptable worker double for the live conversation. `liveOpen` gets an `liveOpened`
 * reply on a microtask (so `openSession` resolves). `liveFeed` gets a `liveSegment`
 * reply on a `setTimeout` — the delay is the inference stand-in, and it is what makes
 * the synchronous assertion in Test A meaningful: the reply is NOT available when
 * `feed()` returns.
 *
 * `emit` lets a test inject a reply directly — Test B uses it to deliver a late
 * `liveSegment` after `close()`, simulating the race where the worker was
 * mid-inference when the session closed.
 */
class FakeLiveWorker {
  readonly posted: MainToWorkerMessage[] = [];
  readonly #listeners = new Map<string, Set<(event: unknown) => void>>();

  addEventListener(type: string, fn: (event: unknown) => void): void {
    const set = this.#listeners.get(type) ?? new Set();
    set.add(fn);
    this.#listeners.set(type, set);
  }
  removeEventListener(type: string, fn: (event: unknown) => void): void {
    this.#listeners.get(type)?.delete(fn);
  }
  postMessage(message: MainToWorkerMessage, _transfer: Transferable[] = []): void {
    this.posted.push(message);
    if (message.type === "liveOpen") {
      queueMicrotask(() => this.emit({ type: "liveOpened", sessionId: message.sessionId }));
    } else if (message.type === "liveFeed") {
      // Inference stand-in: the reply arrives on a timer, NOT synchronously. If feed()
      // blocked until inference completed, this timer would have already fired by the
      // time the synchronous assertion runs — which is exactly what the test catches.
      setTimeout(
        () => this.emit({ type: "liveSegment", sessionId: message.sessionId, text: "hello" }),
        20,
      );
    }
    // liveClose: no reply from the FakeLiveWorker — the real worker flushes the VAD
    // buffer and posts a final `liveSegment`, but tests that need the flush segment
    // deliver it explicitly via `emit()` (see Test C).
  }
  terminate(): void {}

  /** Directly emit a worker→main message to the listeners — simulates a late reply. */
  emit(message: WorkerToMainMessage): void {
    for (const fn of this.#listeners.get("message") ?? []) fn({ data: message });
  }
}

/** Open a live session backed by the given fake worker. */
async function openSession(worker: FakeLiveWorker): Promise<LiveSession> {
  const transcriber = new OnDeviceLiveTranscriber({
    wasmPaths: "/ort/",
    createWorker: () => worker as unknown as Worker,
  });
  return transcriber.openSession(recording);
}

// ── Test A: feed() returns before inference completes ─────────────────────────
//
// The trap (from the plan): "If it awaits the model, the audio thread stalls and capture
// degrades — which this whole feature is forbidden from doing." A test that merely awaits
// and then checks the result passes against a blocking feed, because by the time the await
// resolves the blocking feed has already finished. The assertion must be SYNCHRONOUS —
// check that a post-feed observation happens before the inference the frame triggered has
// resolved.
//
// How this fails against a blocking feed: if feed() ran inference synchronously and emitted
// the segment before returning, `segmentReceived` would be `true` by the time the synchronous
// assertion runs, and `expect(segmentReceived).toBe(false)` would go red.

describe("Test A — feed() returns before inference completes", () => {
  test("a synchronous post-feed observation happens before the segment arrives", async () => {
    const worker = new FakeLiveWorker();
    const session = await openSession(worker);

    let segmentReceived = false;
    session.segments$.subscribe(() => {
      segmentReceived = true;
    });

    // Feed a frame. feed() must return BEFORE the inference it triggers.
    session.feed(new Float32Array(512));

    // ── Synchronous assertion ──
    // This line runs before any setTimeout callback (the inference stand-in). If feed()
    // had blocked until the segment was ready, segmentReceived would already be true.
    expect(segmentReceived).toBe(false);

    // Now let the inference stand-in fire and confirm the segment does arrive.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(segmentReceived).toBe(true);
  });

  test("feed() is typed void, not Promise — the audio callback cannot accidentally await it", () => {
    // A compile-time guard: if someone changes feed to `async feed(...)`, the return type
    // widens to Promise<void> and this assignment fails to typecheck. The runtime test
    // above catches the behaviour; this catches the type.
    const worker = new FakeLiveWorker();
    return openSession(worker).then((session) => {
      const result: void = session.feed(new Float32Array(512));
      expect(result).toBeUndefined();
      session.close();
    });
  });
});

// ── Test B: close() stops feeding but does not drop in-flight segments ────────
//
// The listener no longer gates on `#closed`: a segment arriving after close() may be the
// flush of the last buffered speech (the worker's `liveClose` handler transcribes it and
// posts it back), or a feed that was mid-inference when close arrived. Both are real speech
// that must reach the subscriber — dropping them would lose data, the exact bug the flush
// exists to fix. The `#closed` flag only prevents further `feed()` calls from posting frames.
//
// How this fails against the old guard: if the listener checked `#closed` and returned, the
// segment would be dropped — and the auditor's last sentence would be gone. The test keeps
// the subscription active and the listener in place, so the only thing that can drop the
// segment is a `#closed` check inside the listener. Remove that check (the fix) and the
// segment reaches the subscriber.

describe("Test B — close() stops feeding but forwards segments from the worker", () => {
  test("a segment reply after close() reaches the subscriber — it may be the flush", async () => {
    const worker = new FakeLiveWorker();
    const session = await openSession(worker);

    const segments: string[] = [];
    // IMPORTANT: keep the subscription active — the guard must not be "no subscribers".
    session.segments$.subscribe((text) => segments.push(text));

    // Close the session. close() sets #closed = true (preventing further feed() calls) and
    // posts liveClose to the worker. The listener stays installed — no #closed guard.
    session.close();

    // A segment arrives after close — the flush, or a feed that was mid-inference. This
    // simulates the race where the worker was processing audio when close() arrived.
    worker.emit({ type: "liveSegment", sessionId: session.sessionId, text: "last words" });

    // The segment IS emitted — dropping it would lose the auditor's last sentence.
    expect(segments).toEqual(["last words"]);
  });

  test("close() prevents further feed() calls from reaching the worker", async () => {
    const worker = new FakeLiveWorker();
    const session = await openSession(worker);

    session.close();
    const feedCountBefore = worker.posted.filter((m) => m.type === "liveFeed").length;
    session.feed(new Float32Array(512));
    const feedCountAfter = worker.posted.filter((m) => m.type === "liveFeed").length;

    // feed() after close() is a no-op — the frame is not posted.
    expect(feedCountAfter).toBe(feedCountBefore);
  });
});

// ── Test C: a flush segment reaches the subscriber after close ─────────────────
//
// The worker's `liveClose` handler flushes the VAD buffer, transcribes it, and posts the
// text back as a `liveSegment`. That segment arrives AFTER `close()` was called on the
// main thread — so the listener must forward it, not drop it. This test simulates the
// flush segment delivery directly (the FakeLiveWorker does not run a real VAD) and asserts
// it reaches the subscriber.

describe("Test C — a flush segment after close() reaches the subscriber", () => {
  test("a segment posted by the worker's liveClose flush is emitted on segments$", async () => {
    const worker = new FakeLiveWorker();
    const session = await openSession(worker);

    const segments: string[] = [];
    session.segments$.subscribe((text) => segments.push(text));

    // Feed a frame so the worker has buffered speech (simulated — the FakeLiveWorker
    // would emit a segment on the feed timer, but we are interested in the flush).
    session.feed(new Float32Array(512));
    // Let the feed's inference stand-in fire so its segment arrives before close.
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Close the session — posts liveClose. The worker flushes and posts a final segment.
    session.close();
    worker.emit({ type: "liveSegment", sessionId: session.sessionId, text: "flushed last words" });

    // The flush segment reached the subscriber — it was not dropped by a close guard.
    expect(segments).toContain("flushed last words");
  });
});

// ── Test D: a mid-session worker error reaches the host ───────────────────────
//
// The `liveError` listener in `openSession`'s promise is removed by `cleanup()` as soon as
// `liveOpened` arrives. After open, the only listener on the worker's message channel is
// `OnDeviceLiveSession`'s own `#onMessage` — which, before this fix, forwarded `liveSegment`
// and silently dropped `liveError`. A mid-session error (a per-utterance transcription
// failure, a VAD error) was posted into the void: no console output, no host signal, no
// error on any observable. The recording itself was perfect, and the auditor's only clue was
// that text quietly stopped appearing.
//
// This test opens a session, delivers a `liveError` AFTER open (via `emit`), and asserts the
// host observes it on `errors$`. Against the old code this fails: `errors$` did not exist and
// `liveError` was dropped.

describe("Test D — a mid-session worker error reaches the host", () => {
  test("a liveError posted after open is emitted on errors$", async () => {
    const worker = new FakeLiveWorker();
    const session = await openSession(worker);

    const errors: string[] = [];
    session.errors$.subscribe((message) => errors.push(message));

    // Deliver a mid-session error — the worker posted liveError after the session opened.
    worker.emit({
      type: "liveError",
      sessionId: session.sessionId,
      message: "OOM during generate",
    });

    expect(errors).toEqual(["OOM during generate"]);
  });

  test("a mid-session error does not error segments$ — the segment stream stays alive", async () => {
    const worker = new FakeLiveWorker();
    const session = await openSession(worker);

    const segments: string[] = [];
    session.segments$.subscribe((text) => segments.push(text));

    // A mid-session error arrives.
    worker.emit({ type: "liveError", sessionId: session.sessionId, message: "transient failure" });

    // A segment arrives after the error — the preview must still work for later utterances.
    worker.emit({ type: "liveSegment", sessionId: session.sessionId, text: "next utterance" });

    expect(segments).toEqual(["next utterance"]);
  });
});

// ── liveCapability: the separate probe for live readiness ─────────────────────
//
// `liveCapability()` is separate from `capability()` because live additionally needs
// the streaming VAD (Silero). "ASR cached but VAD missing" is a real state the batch
// probe cannot express — and it is the one tested explicitly below.

/** Minimal CacheStorage double keyed the way transformers.js keys `transformers-cache`. */
function fakeCacheStorage(urls: string[] = []): CacheStorage {
  const has = urls.length > 0;
  return {
    has: (name: string) => Promise.resolve(has && name === TRANSFORMERS_CACHE_NAME),
    open: () =>
      Promise.resolve({
        keys: () => Promise.resolve(urls.map((url) => ({ url }) as Request)),
      } as unknown as Cache),
  } as unknown as CacheStorage;
}

const asrUrls = [
  `https://huggingface.co/${DEFAULT_MODEL_ID}/resolve/main/onnx/encoder_model.onnx`,
  `https://huggingface.co/${DEFAULT_MODEL_ID}/resolve/main/onnx/decoder_model_merged.onnx`,
];
const vadUrl = `https://huggingface.co/${STREAMING_VAD_MODEL_ID}/resolve/main/model.onnx`;

describe("liveCapability", () => {
  test("unavailable when there is no Cache API", async () => {
    const t = new OnDeviceLiveTranscriber({ wasmPaths: "/ort/", cacheStorage: undefined });
    const cap = await t.liveCapability();
    expect(cap.status).toBe("unavailable");
  });

  test("needs-download when neither ASR nor VAD is cached", async () => {
    const t = new OnDeviceLiveTranscriber({
      wasmPaths: "/ort/",
      cacheStorage: fakeCacheStorage([]),
    });
    const cap = await t.liveCapability();
    expect(cap.status).toBe("needs-download");
  });

  test("needs-download (VAD only) when ASR is cached but VAD is not — the state batch capability cannot express", async () => {
    const t = new OnDeviceLiveTranscriber({
      wasmPaths: "/ort/",
      cacheStorage: fakeCacheStorage(asrUrls),
    });
    const cap = await t.liveCapability();
    expect(cap.status).toBe("needs-download");
    if (cap.status === "needs-download") {
      // Only the small VAD download remains — not the full ASR figure.
      expect(cap.downloadBytes).toBeLessThan(5_000_000);
      expect(cap.detail).toBe(STREAMING_VAD_MODEL_ID);
    }
  });

  test("ready when both ASR and VAD are cached", async () => {
    const t = new OnDeviceLiveTranscriber({
      wasmPaths: "/ort/",
      cacheStorage: fakeCacheStorage([...asrUrls, vadUrl]),
    });
    await expect(t.liveCapability()).resolves.toEqual({ status: "ready" });
  });
});
