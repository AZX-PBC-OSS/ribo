import { expect, test, vi } from "vitest";

import {
  DEFAULT_FAKE_TRANSCRIBER_ENGINE,
  DEFAULT_FAKE_TRANSCRIPT_TEXT,
  FakeTranscriber,
} from "./fake-transcriber.js";
import type { Recording } from "./recording.js";
import { TranscriberUnavailableError, type Transcriber } from "./transcriber.js";

const recording = (id = "rec-1"): Recording => ({
  id,
  capturedAt: "2026-07-23T10:00:00.000Z",
  durationMs: 1_200,
  mimeType: "audio/webm",
  ctx: {},
});

const audio = () => new Blob(["not really audio"], { type: "audio/webm" });

test("a FakeTranscriber satisfies the Transcriber interface", () => {
  const transcriber: Transcriber = new FakeTranscriber();
  expect(typeof transcriber.transcribe).toBe("function");
  expect(typeof transcriber.capability).toBe("function");
  expect(transcriber.engine).toBe(DEFAULT_FAKE_TRANSCRIBER_ENGINE);
});

test("returns canned text keyed to the recording it was given", async () => {
  const transcriber = new FakeTranscriber();

  const transcript = await transcriber.transcribe(recording("rec-42"), audio());

  expect(transcript.recordingId).toBe("rec-42");
  expect(transcript.text).toBe(DEFAULT_FAKE_TRANSCRIPT_TEXT);
});

test("stamps its own engine id onto every transcript it produces", async () => {
  const transcriber = new FakeTranscriber({ engine: "ondevice-whisper" });

  const transcript = await transcriber.transcribe(recording(), audio());

  expect(transcript.engine).toBe("ondevice-whisper");
});

test("the default text and confidence are configurable at construction", async () => {
  const transcriber = new FakeTranscriber({ text: "attic insulation R-13", confidence: 0.42 });

  const transcript = await transcriber.transcribe(recording(), audio());

  expect(transcript.text).toBe("attic insulation R-13");
  expect(transcript.confidence).toBe(0.42);
});

test("omits confidence when none is configured", async () => {
  const transcriber = new FakeTranscriber();

  const transcript = await transcriber.transcribe(recording(), audio());

  expect(transcript.confidence).toBeUndefined();
});

test("per-recording responses win over the default text", async () => {
  const transcriber = new FakeTranscriber({
    text: "default",
    responses: { "rec-a": "the attic one" },
  });
  transcriber.setResponse("rec-b", { text: "the basement one", confidence: 0.9 });

  await expect(transcriber.transcribe(recording("rec-a"), audio())).resolves.toMatchObject({
    recordingId: "rec-a",
    text: "the attic one",
  });
  await expect(transcriber.transcribe(recording("rec-b"), audio())).resolves.toMatchObject({
    text: "the basement one",
    confidence: 0.9,
  });
  await expect(transcriber.transcribe(recording("rec-c"), audio())).resolves.toMatchObject({
    text: "default",
  });
});

test("records every call so a pipeline test can assert what it was handed", async () => {
  const transcriber = new FakeTranscriber();
  const blob = audio();

  await transcriber.transcribe(recording("rec-1"), blob);
  await transcriber.transcribe(recording("rec-2"), blob);

  expect(transcriber.calls).toHaveLength(2);
  expect(transcriber.calls[0]?.recording.id).toBe("rec-1");
  expect(transcriber.calls[0]?.audio).toBe(blob);
  expect(transcriber.calls[1]?.recording.id).toBe("rec-2");
});

test("failWith makes every subsequent call reject", async () => {
  const transcriber = new FakeTranscriber();
  const boom = new Error("model unavailable");
  transcriber.failWith(boom);

  await expect(transcriber.transcribe(recording(), audio())).rejects.toBe(boom);
  await expect(transcriber.transcribe(recording(), audio())).rejects.toBe(boom);
});

test("failNextWith rejects exactly once, then recovers", async () => {
  const transcriber = new FakeTranscriber({ text: "second time lucky" });
  const boom = new Error("transient");
  transcriber.failNextWith(boom);

  await expect(transcriber.transcribe(recording(), audio())).rejects.toBe(boom);
  await expect(transcriber.transcribe(recording(), audio())).resolves.toMatchObject({
    text: "second time lucky",
  });
});

test("a failed call is still recorded — retry tests need to see it", async () => {
  const transcriber = new FakeTranscriber();
  transcriber.failNextWith(new Error("transient"));

  await expect(transcriber.transcribe(recording(), audio())).rejects.toThrow("transient");

  expect(transcriber.calls).toHaveLength(1);
});

test("reset clears recorded calls and any queued failure", async () => {
  const transcriber = new FakeTranscriber();
  transcriber.failWith(new Error("boom"));
  await expect(transcriber.transcribe(recording(), audio())).rejects.toThrow("boom");

  transcriber.reset();

  await expect(transcriber.transcribe(recording(), audio())).resolves.toMatchObject({
    text: DEFAULT_FAKE_TRANSCRIPT_TEXT,
  });
  expect(transcriber.calls).toHaveLength(1);
});

test("resolves asynchronously so callers cannot depend on a synchronous result", async () => {
  const transcriber = new FakeTranscriber();
  const observed = vi.fn();

  const pending = transcriber.transcribe(recording(), audio()).then(observed);
  expect(observed).not.toHaveBeenCalled();

  await pending;
  expect(observed).toHaveBeenCalledOnce();
});

// ---------------------------------------------------------------------------
// Capability simulation. Phase 3's download UI and the relay's retry tests both
// need to drive every state without a model on disk.
// ---------------------------------------------------------------------------

test("reports ready by default", async () => {
  await expect(new FakeTranscriber().capability()).resolves.toEqual({ status: "ready" });
});

test("every capability state can be simulated, at construction or later", async () => {
  const transcriber = new FakeTranscriber({
    capability: { status: "needs-download", downloadBytes: 165_000_000, detail: "whisper-base.en" },
  });

  await expect(transcriber.capability()).resolves.toEqual({
    status: "needs-download",
    downloadBytes: 165_000_000,
    detail: "whisper-base.en",
  });

  transcriber.setCapability({
    status: "unavailable",
    reason: "unsupported-platform",
    detail: "no WebGPU",
  });

  await expect(transcriber.capability()).resolves.toEqual({
    status: "unavailable",
    reason: "unsupported-platform",
    detail: "no WebGPU",
  });

  // The download finished: availability is dynamic, so this must be able to go
  // the other way too.
  transcriber.setCapability({ status: "ready" });
  await expect(transcriber.capability()).resolves.toEqual({ status: "ready" });
});

test("counts capability probes, so a caching test can prove it did not re-probe", async () => {
  const transcriber = new FakeTranscriber();

  await transcriber.capability();
  await transcriber.capability();

  expect(transcriber.capabilityCalls).toBe(2);
});

test("failWithUnavailable simulates a capability failure discovered mid-attempt", async () => {
  const transcriber = new FakeTranscriber({ engine: "ondevice-whisper" });
  // Deliberately still claims to be ready — this is the case where the probe was
  // optimistic and the runtime only fails when it is actually asked to run.
  transcriber.failWithUnavailable("unsupported-platform", "ORT init threw");

  await expect(transcriber.capability()).resolves.toEqual({ status: "ready" });
  const rejection = await transcriber.transcribe(recording(), audio()).catch((e: unknown) => e);

  expect(rejection).toBeInstanceOf(TranscriberUnavailableError);
  expect((rejection as TranscriberUnavailableError).engine).toBe("ondevice-whisper");
  expect((rejection as TranscriberUnavailableError).reason).toBe("unsupported-platform");
});

test("reset restores the constructed capability and clears the probe count", async () => {
  const transcriber = new FakeTranscriber({
    capability: { status: "needs-download", downloadBytes: 1 },
  });
  transcriber.setCapability({ status: "ready" });
  await transcriber.capability();

  transcriber.reset();

  expect(transcriber.capabilityCalls).toBe(0);
  await expect(transcriber.capability()).resolves.toEqual({
    status: "needs-download",
    downloadBytes: 1,
  });
});
