import { afterEach, expect, test } from "vitest";

import {
  createRelay,
  openOutbox,
  removeOutboxDatabase,
  type ExtractStep,
  type Outbox,
  type Recording,
  type Transcriber,
  type WriteStep,
} from "@azx/ribo-core";

import { decodeTo16kMono, ONDEVICE_WHISPER_ENGINE, OnDeviceTranscriber } from "./index.js";
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
  constructor(private readonly reply: (message: MainToWorkerMessage) => WorkerToMainMessage[]) {}
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
  return (message: MainToWorkerMessage): WorkerToMainMessage[] =>
    message.type === "transcribe"
      ? [{ type: "transcribed", requestId: message.requestId, text }]
      : [{ type: "primed", requestId: message.requestId }];
}

const recording: Recording = {
  id: "rec-1",
  capturedAt: "2026-07-23T10:00:00.000Z",
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
    engine: ONDEVICE_WHISPER_ENGINE,
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

// ── relay substitutability: drop-in for FakeTranscriber, zero relay changes ───────────────────────

const DB_NAME = "ribo-outbox-ondevice-test";

afterEach(async () => {
  await removeOutboxDatabase(DB_NAME).catch(() => undefined);
});

test("the queue relay drives an OnDeviceTranscriber with no changes", async () => {
  const outbox: Outbox = await openOutbox({ name: DB_NAME });
  // A real, decodable capture blob — the relay hands this straight to transcribe().
  const audio = wavBlob([constant(0.1, 16_000)], 16_000);
  const enqueued = await outbox.enqueue({ recording, audio });

  const transcriber: Transcriber = new OnDeviceTranscriber({
    wasmPaths: WASM_PATHS,
    createWorker: () =>
      new FakeWorker(transcribeReply("on-device transcript")) as unknown as Worker,
  });

  const extract: ExtractStep = () => Promise.resolve({ ok: true });
  const write: WriteStep = () => Promise.resolve();
  const relay = createRelay({ outbox, transcriber, extract, write });

  await relay.syncNow();
  await relay.settled();

  const item = await outbox.get(enqueued.id);
  // The transcript the relay persisted carries this engine's provenance (transcript.ts contract).
  expect(item?.transcript).toEqual({
    recordingId: "rec-1",
    text: "on-device transcript",
    engine: ONDEVICE_WHISPER_ENGINE,
  });
  await outbox.close();
});
