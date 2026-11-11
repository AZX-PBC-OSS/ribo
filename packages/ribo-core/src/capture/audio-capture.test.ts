import { describe, expect, test } from "vitest";
import { z } from "zod";
import { baseAudioCaptureSchema, audioCaptureSchema, type AudioCapture } from "./audio-capture.js";

const jobContext = z.object({ jobId: z.string().min(1) });
const schema = audioCaptureSchema(jobContext);

const valid = {
  id: "rec_01",
  capturedAt: "2026-07-23T10:15:30.000Z",
  kind: "audio",
  durationMs: 12_500,
  mimeType: "audio/webm;codecs=opus",
  ctx: { jobId: "job_42" },
};

describe("audioCaptureSchema", () => {
  test("parses a well-formed recording", () => {
    const parsed = schema.parse(valid);

    expect(parsed).toEqual(valid);
    expect(parsed.ctx.jobId).toBe("job_42");
  });

  test("round-trips a valid record unchanged", () => {
    const parsed = schema.parse(valid);
    const reparsed = schema.parse(JSON.parse(JSON.stringify(parsed)));

    expect(reparsed).toEqual(valid);
  });

  test.each(["id", "capturedAt", "durationMs", "mimeType", "ctx"] as const)(
    "rejects a record missing %s",
    (key) => {
      const { [key]: _omitted, ...rest } = valid;

      expect(schema.safeParse(rest).success).toBe(false);
    },
  );

  test("rejects an unknown extra key", () => {
    expect(schema.safeParse({ ...valid, audio: "oops" }).success).toBe(false);
  });

  test("rejects an empty id", () => {
    expect(schema.safeParse({ ...valid, id: "" }).success).toBe(false);
  });

  test("rejects an empty mimeType", () => {
    expect(schema.safeParse({ ...valid, mimeType: "" }).success).toBe(false);
  });

  test("rejects a non-ISO capturedAt", () => {
    expect(schema.safeParse({ ...valid, capturedAt: "yesterday" }).success).toBe(false);
  });

  test.each([-1, 12.5])("rejects a durationMs of %s", (durationMs) => {
    expect(schema.safeParse({ ...valid, durationMs }).success).toBe(false);
  });

  test("accepts a zero-length recording", () => {
    expect(schema.safeParse({ ...valid, durationMs: 0 }).success).toBe(true);
  });

  test("rejects a ctx that does not match the host's context schema", () => {
    expect(schema.safeParse({ ...valid, ctx: { jobId: 42 } }).success).toBe(false);
  });

  test("supplies kind: audio via the branch default when the input omits it", () => {
    const { kind: _kind, ...withoutKind } = valid;
    const parsed = schema.parse(withoutKind);
    expect(parsed.kind).toBe("audio");
  });

  test("keeps the host context typed through inference", () => {
    const parsed: AudioCapture<typeof jobContext> = schema.parse(valid);
    const jobId: string = parsed.ctx.jobId;

    expect(jobId).toBe("job_42");
  });
});

describe("baseAudioCaptureSchema", () => {
  test("parses a recording whose context is unvalidated", () => {
    expect(baseAudioCaptureSchema.safeParse({ ...valid, ctx: { anything: true } }).success).toBe(
      true,
    );
  });

  test("still requires the ctx key to be present — an opaque slot is not an absent one", () => {
    const { ctx: _ctx, ...withoutCtx } = valid;

    expect(baseAudioCaptureSchema.safeParse(withoutCtx).success).toBe(false);
  });

  test("is still strict about the fields it does own", () => {
    expect(baseAudioCaptureSchema.safeParse({ ...valid, audio: "oops" }).success).toBe(false);
    expect(baseAudioCaptureSchema.safeParse({ ...valid, id: "" }).success).toBe(false);
  });
});
