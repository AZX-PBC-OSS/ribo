import { afterEach, expect, test, vi } from "vitest";

import {
  createRelay,
  openStorage,
  createMemoryBackend,
  removeMemoryDatabase,
  restrictToKind,
  TerminalError,
  type Storage,
  type Recording,
  type SessionExtractStep,
  type SessionWriteStep,
  type Transcriber,
} from "@azx/ribo-core";

import { DEFAULT_MODEL_ID } from "./config.js";
import { ondeviceEngineId } from "./engine-id.js";
import { decodeTo16kMono } from "./decode.js";
import { OnDeviceTranscriber } from "./index.js";
import type { MainToWorkerMessage, WorkerToMainMessage } from "./protocol.js";

/**
 * GATED browser coverage for Task 3. Runs in real Chromium (the `browser` Vitest project) so it has
 * `AudioContext` for the decode step and real RxDB/IndexedDB for the relay step. It downloads **no
 * model**: the worker is faked, so decode + main↔worker plumbing + relay substitutability are proven
 * deterministically and offline. The real-model end-to-end run (actual Whisper text) is the opt-in
 * `transcribe.manual.ts`, deliberately NOT gated — a 150–290 MB CDN fetch is not a check.
 */

const WASM_PATHS = "/ort/";

/** Encode a Float32 signal (one array per channel) as a 16-bit PCM WAV `Blob` — decodable by
 * `decodeAudioData` on Chromium, standing in for the recorder's Opus/WebM. */
function wavBlob(channels: Float32Array[], sampleRate: number): Blob {
  const numChannels = channels.length;
  const numFrames = channels[0]!.length;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataBytes = numFrames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeStr = (offset: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 8 * bytesPerSample, true);
  writeStr(36, "data");
  view.setUint32(40, dataBytes, true);
  let offset = 44;
  for (let frame = 0; frame < numFrames; frame++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, channels[ch]![frame]!));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([buffer], { type: "audio/wav" });
}

/** A constant-valued signal, so the √2 downmix is checkable against an exact expected amplitude. */
function constant(value: number, frames: number): Float32Array {
  return new Float32Array(frames).fill(value);
}

/** Scriptable Worker double that captures each posted message (and its transfer list) and replies
 * with a canned sequence produced by `reply`. */
class FakeWorker {
  readonly posted: { message: MainToWorkerMessage; transfer: Transferable[] }[] = [];
  readonly #listeners = new Map<string, Set<(event: unknown) => void>>();
  constructor(
    private readonly reply: (
      message: Extract<MainToWorkerMessage, { requestId: string }>,
    ) => WorkerToMainMessage[],
  ) {}
  addEventListener(type: string, fn: (event: unknown) => void): void {
    const set = this.#listeners.get(type) ?? new Set();
    set.add(fn);
    this.#listeners.set(type, set);
  }
  removeEventListener(type: string, fn: (event: unknown) => void): void {
    this.#listeners.get(type)?.delete(fn);
  }
  postMessage(message: MainToWorkerMessage, transfer: Transferable[] = []): void {
    this.posted.push({ message, transfer });
    if (!("requestId" in message)) return;
    const replies = this.reply(message);
    queueMicrotask(() => {
      for (const reply of replies)
        for (const fn of this.#listeners.get("message") ?? []) fn({ data: reply });
    });
  }
  terminate(): void {}
}

/** Reply script: canned transcript text for a transcribe, `primed` for a prime. */
function transcribeReply(text: string) {
  return (message: Extract<MainToWorkerMessage, { requestId: string }>): WorkerToMainMessage[] =>
    message.type === "transcribe"
      ? [{ type: "transcribed", requestId: message.requestId, text }]
      : [{ type: "primed", requestId: message.requestId }];
}

const recording: Recording = {
  id: "rec-1",
  capturedAt: "2026-07-23T10:00:00.000Z",
  kind: "audio",
  durationMs: 500,
  mimeType: "audio/webm;codecs=opus",
  ctx: { jobId: "job-7" },
};

// ── decode: doc 11 §3 conventions ────────────────────────────────────────────────────────────────

test("decodeTo16kMono resamples to 16 kHz mono length", async () => {
  const sr = 48_000;
  const seconds = 0.5;
  const mono = wavBlob([constant(0.25, sr * seconds)], sr);
  const samples = await decodeTo16kMono(mono);
  expect(samples).toBeInstanceOf(Float32Array);
  // 0.5 s at 16 kHz ≈ 8000 samples (resampler may differ by a frame or two).
  expect(Math.abs(samples.length - 16_000 * seconds)).toBeLessThan(20);
});

test("decodeTo16kMono uses the √2 ffmpeg downmix, not a naive average", async () => {
  const sr = 48_000;
  const c = 0.4;
  // Identical L and R at amplitude c. Naive (l+r)/2 = c; the ffmpeg (√2·(l+r))/2 = √2·c.
  const stereo = wavBlob([constant(c, sr), constant(c, sr)], sr);
  const samples = await decodeTo16kMono(stereo);
  // Sample the steady-state middle (avoid resampler edge transients).
  const mid = samples[Math.floor(samples.length / 2)]!;
  expect(mid).toBeCloseTo(Math.SQRT2 * c, 2);
  expect(mid).not.toBeCloseTo(c, 2);
});

// ── transcribe: main → worker plumbing + Transcript shape ─────────────────────────────────────────

test("transcribe decodes on the main thread, transfers samples, and stamps the engine", async () => {
  let worker: FakeWorker | undefined;
  const transcriber = new OnDeviceTranscriber({
    wasmPaths: WASM_PATHS,
    // Pinned to Whisper on purpose: this test drives the decoder-prefix priming path, and the
    // default model is Moonshine, which cannot be primed and now REFUSES hints at construction.
    // Leaving this on the default would have turned a priming test into a constructor-throw test.
    modelId: "Xenova/whisper-base.en",
    hints: { vocabulary: ["R-value", "CFM50"], prompt: "energy audit" },
    createWorker: () =>
      (worker = new FakeWorker(
        transcribeReply("the attic R-value is forty nine"),
      )) as unknown as Worker,
  });

  const audio = wavBlob([constant(0.1, 16_000)], 16_000);
  const transcript = await transcriber.transcribe(recording, audio);

  expect(transcript).toEqual({
    recordingId: "rec-1",
    text: "the attic R-value is forty nine",
    // Names the model this instance was pinned to, not the package default — which is the
    // whole point of deriving the id: a persisted transcript can be attributed to the
    // configuration that produced it.
    engine: ondeviceEngineId({ modelId: "Xenova/whisper-base.en" }),
  });

  const posted = worker!.posted.at(-1)!;
  expect(posted.message.type).toBe("transcribe");
  if (posted.message.type === "transcribe") {
    // A 16 kHz mono Float32Array crossed the seam — never the Blob (doc 11 §4).
    expect(posted.message.request.samples).toBeInstanceOf(Float32Array);
    // Hints were assembled into the priming text the worker turns into a decoder prefix.
    expect(posted.message.request.prompt).toBe("R-value, CFM50. energy audit");
    expect(posted.message.config).toMatchObject({
      modelId: "Xenova/whisper-base.en",
      wasmPaths: WASM_PATHS,
    });
  }
  // The samples' backing buffer was handed to the transfer list (moved, not copied).
  expect(posted.transfer).toHaveLength(1);
  expect(posted.transfer[0]).toBeInstanceOf(ArrayBuffer);
});

test("transcribe omits the prompt when no hints are configured", async () => {
  let worker: FakeWorker | undefined;
  const transcriber = new OnDeviceTranscriber({
    wasmPaths: WASM_PATHS,
    createWorker: () => (worker = new FakeWorker(transcribeReply("hello"))) as unknown as Worker,
  });
  await transcriber.transcribe(recording, wavBlob([constant(0.1, 16_000)], 16_000));
  const message = worker!.posted.at(-1)!.message;
  expect(message.type === "transcribe" && message.request.prompt).toBeUndefined();
});

test("a worker that dies SILENTLY fails the attempt instead of hanging forever", async () => {
  // The failure this guards is the worst one available: an out-of-memory kill does not
  // fire `error`, so without a timeout the promise stays pending, and because the relay
  // drains serially with no timeout of its own, every capture behind it is stranded for
  // the rest of the day — no `failed`, no backoff, nothing surfaced.
  //
  // The fake worker accepts the message and never replies, which is exactly what that
  // looks like from the main thread.
  const silent = new FakeWorker(() => []);
  const transcriber = new OnDeviceTranscriber({
    wasmPaths: WASM_PATHS,
    workerTimeoutMs: 50,
    createWorker: () => silent as unknown as Worker,
  });

  await expect(
    transcriber.transcribe(recording, wavBlob([constant(0.1, 16_000)], 16_000)),
  ).rejects.toThrow(/did not reply/i);
});

test("transcribe rejects (attempt failure) when the worker reports an error", async () => {
  const transcriber = new OnDeviceTranscriber({
    wasmPaths: WASM_PATHS,
    createWorker: () =>
      new FakeWorker((message) => [
        { type: "error", requestId: message.requestId, message: "OOM" },
      ]) as unknown as Worker,
  });
  await expect(
    transcriber.transcribe(recording, wavBlob([constant(0.1, 16_000)], 16_000)),
  ).rejects.toThrow(/OOM/);
});

// ── Cancellation (widen-transcriber-contract plan, Task 3) ────────────────────
//
// The main-thread half of the signal channel: an abort must post
// `cancelTranscribe` for the in-flight batch's requestId — asserted on the
// message the worker OBSERVES, not on the promise rejecting — and an error
// reply that arrives while the caller's signal is aborted is classified as a
// cancellation (terminal), not an attempt failure.

test("an abort mid-transcription posts cancelTranscribe for the in-flight batch's requestId", async () => {
  // A silent worker: the batch is in flight and nothing replies, which is
  // exactly the state an abort is meant to interrupt.
  const worker = new FakeWorker(() => []);
  const transcriber = new OnDeviceTranscriber({
    wasmPaths: WASM_PATHS,
    workerTimeoutMs: 100,
    createWorker: () => worker as unknown as Worker,
  });
  const controller = new AbortController();

  const pending = transcriber.transcribe(recording, wavBlob([constant(0.1, 16_000)], 16_000), {
    signal: controller.signal,
  });
  // Wait until the batch request is actually on the channel, then abort.
  await vi.waitFor(() =>
    expect(worker.posted.some((p) => p.message.type === "transcribe")).toBe(true),
  );
  controller.abort();

  const transcribeMsg = worker.posted.find((p) => p.message.type === "transcribe")!.message;
  const cancelMsg = worker.posted.find((p) => p.message.type === "cancelTranscribe")?.message;
  // The worker observed a cancel message whose requestId matches the batch it
  // belongs to — no crosstalk, and no terminate (the FakeWorker's terminate is
  // never the mechanism; only dispose() may call it).
  expect(transcribeMsg.type === "transcribe").toBe(true);
  expect(cancelMsg?.type === "cancelTranscribe").toBe(true);
  if (cancelMsg?.type === "cancelTranscribe" && transcribeMsg.type === "transcribe") {
    expect(cancelMsg.requestId).toBe(transcribeMsg.requestId);
  }

  // The worker never replies (silent death); the attempt then fails — as a
  // cancellation (terminal), not as the retryable worker-timeout it would
  // otherwise be classified as.
  const error = await pending.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(TerminalError);
});

test("an error reply arriving while the caller's signal is aborted is classified as a cancellation, not an attempt failure", async () => {
  // A controllable worker: the test decides when the error reply is emitted, so
  // the abort deterministically precedes it — the order the worker's chunk-boundary
  // cancellation actually produces.
  class ManualWorker {
    readonly posted: MainToWorkerMessage[] = [];
    #listener?: (event: unknown) => void;
    addEventListener(type: string, fn: (event: unknown) => void): void {
      if (type === "message") this.#listener = fn;
    }
    removeEventListener(type: string, fn: (event: unknown) => void): void {
      if (type === "message" && this.#listener === fn) this.#listener = undefined;
    }
    postMessage(message: MainToWorkerMessage): void {
      this.posted.push(message);
    }
    emit(message: WorkerToMainMessage): void {
      this.#listener?.({ data: message });
    }
  }
  const worker = new ManualWorker();
  const transcriber = new OnDeviceTranscriber({
    wasmPaths: WASM_PATHS,
    createWorker: () => worker as unknown as Worker,
  });
  const controller = new AbortController();

  const pending = transcriber.transcribe(recording, wavBlob([constant(0.1, 16_000)], 16_000), {
    signal: controller.signal,
  });
  await vi.waitFor(() => expect(worker.posted.some((m) => m.type === "transcribe")).toBe(true));
  controller.abort();
  const posted = worker.posted[0];
  worker.emit({
    type: "error",
    requestId: posted?.type === "transcribe" ? posted.requestId : "",
    message: "stopped at the chunk boundary",
  });

  const error = await pending.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(TerminalError);
});

// ── relay substitutability: drop-in for FakeTranscriber, zero relay changes ───────────────────────

const DB_NAME = "ribo-storage-ondevice-test";

afterEach(async () => {
  removeMemoryDatabase(DB_NAME);
});

test("the queue relay drives an OnDeviceTranscriber with no changes", async () => {
  const storage: Storage = await openStorage({ backend: createMemoryBackend(DB_NAME) });
  const session = await storage.sessions.open({ ctx: recording.ctx, ref: "job-7" });
  // A real, decodable capture blob — the relay hands this straight to transcribe().
  const audio = wavBlob([constant(0.1, 16_000)], 16_000);
  const enqueued = await storage.captures.enqueue({ recording, audio, sessionId: session.id });

  const transcriber: Transcriber = new OnDeviceTranscriber({
    wasmPaths: WASM_PATHS,
    createWorker: () =>
      new FakeWorker(transcribeReply("on-device transcript")) as unknown as Worker,
  });

  const sessionExtract: SessionExtractStep = () => Promise.resolve({ fields: { ok: true } });
  const sessionWrite: SessionWriteStep = () => Promise.resolve();
  const relay = createRelay({
    storage,
    transcriber: restrictToKind("audio", transcriber),
    sessionExtract,
    sessionWrite,
  });

  await relay.syncNow();
  await relay.settled();

  const item = await storage.captures.get(enqueued.id);
  // The transcript the relay persisted carries this engine's provenance (transcript.ts contract).
  expect(item?.transcript).toEqual({
    recordingId: "rec-1",
    text: "on-device transcript",
    engine: ondeviceEngineId({ modelId: DEFAULT_MODEL_ID }),
  });
  await storage.close();
});
