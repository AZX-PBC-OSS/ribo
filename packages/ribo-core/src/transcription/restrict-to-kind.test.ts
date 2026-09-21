import { expect, test } from "vitest";

import type { CapturePayload } from "../capture/capture-item.js";
import type { DocumentCapture } from "../capture/capture-item.js";
import { restrictToKind } from "./restrict-to-kind.js";
import type { Recording } from "../capture/recording.js";
import { FakeTranscriber } from "./fake-transcriber.js";
import { UnsupportedItemError } from "./unsupported-item.js";
import type { Transcriber } from "./transcriber.js";
import type { Transcript } from "../capture/transcript.js";

// ---------------------------------------------------------------------------
// Runtime: restrictToKind refuses other kinds and delegates for the matching one
// ---------------------------------------------------------------------------

const audioRecording: Recording = {
  id: "rec-1",
  capturedAt: "2026-07-23T10:00:00.000Z",
  kind: "audio",
  durationMs: 1000,
  mimeType: "audio/webm",
  ctx: {},
};

const documentCapture: DocumentCapture = {
  id: "doc-1",
  capturedAt: "2026-07-23T10:00:00.000Z",
  kind: "document",
  pageCount: 2,
  mimeType: "application/pdf",
  ctx: {},
};

test("restrictToKind delegates for the matching kind", async () => {
  const inner = new FakeTranscriber({ text: "hello" });
  const wrapped = restrictToKind("audio", inner);

  const transcript = await wrapped.transcribe(audioRecording, new Blob([]));
  expect(transcript.text).toBe("hello");
  expect(inner.calls).toHaveLength(1);
});

test("restrictToKind throws UnsupportedItemError for a different kind", async () => {
  const inner = new FakeTranscriber({ text: "hello" });
  const wrapped = restrictToKind("audio", inner);

  await expect(wrapped.transcribe(documentCapture, new Blob([]))).rejects.toThrow(
    UnsupportedItemError,
  );
  expect(inner.calls).toHaveLength(0);
});

test("restrictToKind preserves the engine id", () => {
  const inner = new FakeTranscriber({ engine: "ondevice-whisper" });
  const wrapped = restrictToKind("audio", inner);
  expect(wrapped.engine).toBe("ondevice-whisper");
});

test("restrictToKind delegates capability()", async () => {
  const inner = new FakeTranscriber({ capability: { status: "needs-download", downloadBytes: 1 } });
  const wrapped = restrictToKind("audio", inner);
  const cap = await wrapped.capability();
  expect(cap.status).toBe("needs-download");
});

// ---------------------------------------------------------------------------
// Type-level: the D7a property — method bivariance vs property contravariance
// ---------------------------------------------------------------------------

// These are type-level assertions: the `@ts-expect-error` IS the test. If the
// property flips from `@ts-expect-error` to "unused directive" (TS2578), the
// assertion has inverted and the test fails. Vitest does not typecheck, so
// these fire under `pnpm typecheck`, not `pnpm test`.

test("a Transcriber<Recording> is NOT assignable to Transcriber<CapturePayload>", () => {
  const audioOnly: Transcriber<Recording> = new FakeTranscriber();
  // @ts-expect-error — with property-typed `transcribe`, the contravariant
  // parameter makes this assignment a type error. If `transcribe` were
  // declared as a method, this directive would go unused and the typecheck
  // would fail — which is how you know the test is testing the syntax choice.
  const _wide: Transcriber<CapturePayload> = audioOnly;
  expect(_wide).toBe(audioOnly);
});

test("a Transcriber<CapturePayload> IS assignable to Transcriber<Recording>", () => {
  // The safe direction must keep working; a test that only pins the rejection
  // would also pass if the type were simply broken.
  const wide: Transcriber<CapturePayload> = restrictToKind("audio", new FakeTranscriber());
  const _narrow: Transcriber<Recording> = wide;
  expect(_narrow).toBe(wide);
});

test("bare Transcriber still accepts a Recording and rejects a DocumentCapture", () => {
  // The default type argument has not silently widened the existing contract.
  const t: Transcriber = new FakeTranscriber();
  // A DocumentCapture is not assignable to Recording, so passing one to
  // transcribe is a type error.
  // @ts-expect-error — DocumentCapture is not assignable to Recording.
  void t.transcribe(documentCapture, new Blob([]));
  // A Recording is fine.
  void t.transcribe(audioRecording, new Blob([]));
});

test("a class with an async transcribe method satisfies the property-typed interface", () => {
  // This is what makes the change cost nothing at every existing implementation:
  // a reader who knows variance will assume the opposite.
  class MyEngine implements Transcriber {
    readonly engine = "mine";
    async capability() {
      return { status: "ready" } as const;
    }
    async transcribe(recording: Recording, _bytes: Blob): Promise<Transcript> {
      return { recordingId: recording.id, text: "", engine: this.engine };
    }
  }
  const _t: Transcriber = new MyEngine();
  expect(_t.engine).toBe("mine");
});

test("restrictToKind('audio', audioOnly) is assignable to Transcriber<CapturePayload>", () => {
  const audioOnly: Transcriber<Recording> = new FakeTranscriber();
  const wide: Transcriber<CapturePayload> = restrictToKind("audio", audioOnly);
  expect(wide.engine).toBe(audioOnly.engine);
});

test("something satisfying Transcriber today still satisfies it with no type arguments", () => {
  // Passes today — a regression fence, not a must-fail.
  const t: Transcriber = new FakeTranscriber();
  expect(t.engine).toBeDefined();
});

// The caller's options must reach the wrapped transcriber, by identity. A lift
// that accepted `options` and forwarded none would typecheck — and would make
// the wrapped engine the one place the caller's signal dies.
test("the caller's options reach the wrapped transcriber, by identity", async () => {
  const inner = new FakeTranscriber({ text: "hello" });
  const wrapped = restrictToKind("audio", inner);
  const controller = new AbortController();

  await wrapped.transcribe(audioRecording, new Blob([]), { signal: controller.signal });

  expect(inner.callOptions).toHaveLength(1);
  expect(inner.callOptions[0]?.signal).toBe(controller.signal);
});
