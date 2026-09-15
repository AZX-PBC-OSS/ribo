import { describe, expect, test } from "vitest";

import { FakeTranscriber } from "./fake-transcriber.js";
import { fallbackTranscriber } from "./fallback-transcriber.js";
import { isTransientFailure, TerminalQueueError } from "./queue/backoff.js";
import type { Recording } from "./recording.js";
import { type Transcriber } from "./transcriber.js";
import { unsupportedFallsThrough, type TranscriptionArbiter } from "./transcription-arbitration.js";
import { UnsupportedItemError } from "./unsupported-item.js";

const recording = (id = "rec-1"): Recording => ({
  id,
  capturedAt: "2026-07-23T10:00:00.000Z",
  kind: "audio",
  durationMs: 1_200,
  mimeType: "audio/webm",
  ctx: {},
});

const audio = () => new Blob(["not really audio"], { type: "audio/webm" });

const fake = (engine: string, opts?: ConstructorParameters<typeof FakeTranscriber>[0]) =>
  new FakeTranscriber({ engine, ...opts });

// Compile-time check that fallbackTranscriber returns a Transcriber for a
// concrete item type, not just CaptureItem.
const _typeCheck: Transcriber<Recording> = fallbackTranscriber<Recording>(
  [new FakeTranscriber()],
  unsupportedFallsThrough,
);
void _typeCheck;

describe("fallbackTranscriber", () => {
  test("an UnsupportedItemError from the first candidate falls through to a successful second", async () => {
    const first = fake("pdfjs");
    first.failWithUnsupported("no-text-layer", "scanned PDF");
    const second = fake("ocr", { text: "OCR text" });

    const composite = fallbackTranscriber([first, second], unsupportedFallsThrough);
    const transcript = await composite.transcribe(recording(), audio());

    expect(transcript.text).toBe("OCR text");
    // The transcript carries the engine that actually ran, not the wrapper's.
    expect(transcript.engine).toBe("ocr");
    expect(first.calls).toHaveLength(1);
    expect(second.calls).toHaveLength(1);
  });

  // The single most important test in this task. An UnsupportedItemError must
  // leave the failing engine's cached capability untouched, and the ladder must
  // never call capability() at all. One unreadable item must never demote an
  // engine for every future item, exactly as one bad clip must never demote a
  // device to the cloud.
  test("an UnsupportedItemError leaves the failing engine's capability untouched", async () => {
    const first = fake("pdfjs");
    // Probe capability before the ladder runs — it is ready.
    await expect(first.capability()).resolves.toEqual({ status: "ready" });
    const probesBefore = first.capabilityCalls;

    first.failWithUnsupported("no-text-layer", "scanned PDF");
    const second = fake("ocr", { text: "OCR text" });

    const composite = fallbackTranscriber([first, second], unsupportedFallsThrough);
    await composite.transcribe(recording(), audio());

    // Capability is still ready — the engine is fine, the item was not.
    await expect(first.capability()).resolves.toEqual({ status: "ready" });

    // The ladder never called capability() on the first candidate. The only
    // probes are the two explicit ones in this test (before and after).
    expect(first.capabilityCalls).toBe(probesBefore + 1);
  });

  test("a plain attempt failure does not call the second candidate and rethrows unchanged", async () => {
    const first = fake("ondevice");
    const oom = new Error("out of memory decoding this clip");
    first.failNextWith(oom);
    const second = fake("managed");

    const composite = fallbackTranscriber([first, second], unsupportedFallsThrough);

    await expect(composite.transcribe(recording(), audio())).rejects.toBe(oom);
    expect(second.calls).toHaveLength(0);
    expect(isTransientFailure(oom)).toBe(true);
  });

  test("every candidate throwing UnsupportedItemError gives up with a terminal error", async () => {
    const first = fake("pdfjs");
    first.failWithUnsupported("no-text-layer", "scanned PDF");
    const second = fake("ocr");
    second.failWithUnsupported("unsupported-format", "corrupted bytes");

    const composite = fallbackTranscriber([first, second], unsupportedFallsThrough);
    const error = await composite.transcribe(recording(), audio()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UnsupportedItemError);
    expect(error).toBeInstanceOf(TerminalQueueError);
    expect(isTransientFailure(error)).toBe(false);
  });

  // D7 rule 2: at exhaustion, prefer a retryable error over a terminal one.
  // The naive "give up with the first error" implementation passes every other
  // test in this file — this is the one that catches it.
  test("a mix of UnsupportedItemError and retryable failure gives up with the retryable one", async () => {
    const first = fake("pdfjs");
    first.failWithUnsupported("no-text-layer", "scanned PDF");
    const second = fake("ocr");
    const networkError = Object.assign(new Error("OCR service 503"), { status: 503 });
    second.failWith(networkError);

    const composite = fallbackTranscriber([first, second], unsupportedFallsThrough);
    const error = await composite.transcribe(recording(), audio()).catch((e: unknown) => e);

    expect(isTransientFailure(error)).toBe(true);
    expect(error).toBe(networkError);
  });

  test("a TranscriberUnavailableError from the first candidate routes to the second", async () => {
    const first = fake("ondevice");
    first.failWithUnavailable("offline", "no network");
    const second = fake("managed", { text: "managed text" });

    const composite = fallbackTranscriber([first, second], unsupportedFallsThrough);
    const transcript = await composite.transcribe(recording(), audio());

    expect(transcript.engine).toBe("managed");
    expect(first.calls).toHaveLength(1);
    expect(second.calls).toHaveLength(1);
  });

  // The property that distinguishes fallbackTranscriber from firstCapable:
  // it never consults capability() before calling a candidate. A candidate
  // reporting unavailable is still called, and the arbiter decides.
  test("does not consult capability() before calling a candidate", async () => {
    const first = fake("pdfjs", {
      capability: { status: "unavailable", reason: "not-configured", detail: "no worker URL" },
    });
    const second = fake("ocr", { text: "OCR text" });

    const composite = fallbackTranscriber([first, second], unsupportedFallsThrough);
    const transcript = await composite.transcribe(recording(), audio());

    // The first candidate was called despite reporting unavailable, and it
    // succeeded — the ladder never looked at capability().
    expect(first.calls).toHaveLength(1);
    expect(transcript.engine).toBe("pdfjs");
    expect(second.calls).toHaveLength(0);
  });

  test("an arbiter returning continue at exhaustion fails naming the arbiter", async () => {
    const alwaysContinue: TranscriptionArbiter = () => ({ continue: true });
    const composite = fallbackTranscriber([fake("a", { text: "text" })], alwaysContinue);

    await expect(composite.transcribe(recording(), audio())).rejects.toThrow(TypeError);
    await expect(composite.transcribe(recording(), audio())).rejects.toThrow(/arbiter/);
  });

  test("an arbiter accepting a transcript no candidate produced fails", async () => {
    const rogue: TranscriptionArbiter = () => ({
      accept: { recordingId: "synthesised", text: "never produced", engine: "nobody" },
    });
    const composite = fallbackTranscriber([fake("a", { text: "text" })], rogue);

    await expect(composite.transcribe(recording(), audio())).rejects.toThrow(TypeError);
    await expect(composite.transcribe(recording(), audio())).rejects.toThrow(
      /not produced by any candidate/,
    );
  });

  // Lesson carried over from arbitration.ts: an arbiter that accepts
  // `undefined` must not match an error outcome whose `result` is also
  // `undefined`. The guard discriminates on the value, not key presence.
  test("an arbiter accepting undefined names the arbiter, not crashing inside the engine", async () => {
    const rogue = (() => ({ accept: undefined })) as unknown as TranscriptionArbiter;
    const first = fake("a");
    first.failWith(new Error("candidate failed"));

    const composite = fallbackTranscriber([first], rogue);

    await expect(composite.transcribe(recording(), audio())).rejects.toThrow(TypeError);
    await expect(composite.transcribe(recording(), audio())).rejects.toThrow(
      /not produced by any candidate/,
    );
  });

  test("an empty candidate list is refused at construction", () => {
    expect(() => fallbackTranscriber([], unsupportedFallsThrough)).toThrow(TypeError);
    expect(() => fallbackTranscriber([], unsupportedFallsThrough)).toThrow(/at least one/);
  });

  test("duplicate engine ids are refused at construction", () => {
    expect(() =>
      fallbackTranscriber([fake("same"), fake("same")], unsupportedFallsThrough),
    ).toThrow(TypeError);
    expect(() =>
      fallbackTranscriber([fake("same"), fake("same")], unsupportedFallsThrough),
    ).toThrow(/same/);
  });

  test("the composite's capability reports the best of its delegates", async () => {
    // ready beats unavailable.
    await expect(
      fallbackTranscriber(
        [
          fake("a", {
            capability: { status: "unavailable", reason: "offline", detail: "no network" },
          }),
          fake("b"),
        ],
        unsupportedFallsThrough,
      ).capability(),
    ).resolves.toEqual({ status: "ready" });

    // ready beats needs-download.
    await expect(
      fallbackTranscriber(
        [
          fake("a", {
            capability: { status: "needs-download", downloadBytes: 165_000_000 },
          }),
          fake("b"),
        ],
        unsupportedFallsThrough,
      ).capability(),
    ).resolves.toEqual({ status: "ready" });

    // needs-download beats unavailable.
    await expect(
      fallbackTranscriber(
        [
          fake("a", {
            capability: { status: "unavailable", reason: "offline", detail: "no network" },
          }),
          fake("b", {
            capability: { status: "needs-download", downloadBytes: 165_000_000 },
          }),
        ],
        unsupportedFallsThrough,
      ).capability(),
    ).resolves.toEqual({ status: "needs-download", downloadBytes: 165_000_000 });

    // all unavailable → first in order.
    await expect(
      fallbackTranscriber(
        [
          fake("a", {
            capability: {
              status: "unavailable",
              reason: "unsupported-platform",
              detail: "no WebGPU",
            },
          }),
          fake("b", {
            capability: { status: "unavailable", reason: "offline", detail: "no network" },
          }),
        ],
        unsupportedFallsThrough,
      ).capability(),
    ).resolves.toEqual({
      status: "unavailable",
      reason: "unsupported-platform",
      detail: "no WebGPU",
    });
  });

  test("the composite's engine defaults to 'fallback'", () => {
    expect(fallbackTranscriber([fake("a")], unsupportedFallsThrough).engine).toBe("fallback");
  });

  test("the composite's engine is overridable", () => {
    expect(
      fallbackTranscriber([fake("a")], unsupportedFallsThrough, { engine: "custom" }).engine,
    ).toBe("custom");
  });

  // D7 rule 4 and non-negotiable #2. An attempt failure ends the ladder even
  // when a later rung could have succeeded. This looks like a missed
  // opportunity and is not — pinning it is what stops someone "improving" the
  // arbiter into continuing on attempt failures.
  test("an attempt failure ends the ladder even when a later rung could have succeeded", async () => {
    const first = fake("a");
    const oom = new Error("out of memory");
    first.failNextWith(oom);
    const second = fake("b", { text: "would have succeeded" });

    const composite = fallbackTranscriber([first, second], unsupportedFallsThrough);

    await expect(composite.transcribe(recording(), audio())).rejects.toBe(oom);
    expect(second.calls).toHaveLength(0);
  });

  // The caller's options must reach every candidate that runs, by identity. A
  // combinator that accepted `options` and forwarded none typechecks, because
  // the parameter is optional — the identity assertion is the only guard (the
  // same lesson as fallbackExtractor's abort-signal test).
  test("the caller's options reach every candidate that runs, by identity", async () => {
    const first = fake("pdfjs");
    first.failWithUnsupported("no-text-layer", "scanned PDF");
    const second = fake("ocr", { text: "OCR text" });
    const composite = fallbackTranscriber([first, second], unsupportedFallsThrough);
    const controller = new AbortController();

    const transcript = await composite.transcribe(recording(), audio(), {
      signal: controller.signal,
    });

    expect(transcript.engine).toBe("ocr");
    expect(first.callOptions).toHaveLength(1);
    expect(first.callOptions[0]?.signal).toBe(controller.signal);
    expect(second.callOptions).toHaveLength(1);
    expect(second.callOptions[0]?.signal).toBe(controller.signal);
  });
});
