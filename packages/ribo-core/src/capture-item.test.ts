import { describe, expect, test } from "vitest";
import { z } from "zod";

import {
  basePayloadSchema,
  baseDocumentCaptureSchema,
  capturePayloadSchema,
  type CapturePayload,
  type DocumentCapture,
} from "./capture-item.js";
import { baseRecordingSchema, type Recording } from "./recording.js";

const jobContext = z.object({ jobId: z.string().min(1) });
const schema = capturePayloadSchema(jobContext);

const audioValid = {
  id: "rec_01",
  capturedAt: "2026-07-23T10:15:30.000Z",
  kind: "audio" as const,
  durationMs: 12_500,
  mimeType: "audio/webm;codecs=opus",
  ctx: { jobId: "job_42" },
};

const documentValid = {
  id: "doc_01",
  capturedAt: "2026-07-23T10:15:30.000Z",
  kind: "document" as const,
  pageCount: 3,
  mimeType: "application/pdf",
  ctx: { jobId: "job_42" },
};

describe("capturePayloadSchema", () => {
  test("parses an audio capture", () => {
    const parsed = schema.parse(audioValid);
    expect(parsed).toEqual(audioValid);
    expect(parsed.kind).toBe("audio");
  });

  test("parses a document capture", () => {
    const parsed = schema.parse(documentValid);
    expect(parsed).toEqual(documentValid);
    expect(parsed.kind).toBe("document");
    if (parsed.kind === "document") {
      expect(parsed.pageCount).toBe(3);
    }
  });

  test("rejects a document capture carrying durationMs — strictObject makes the lie unwritable", () => {
    expect(schema.safeParse({ ...documentValid, durationMs: 0 }).success).toBe(false);
  });

  test("rejects pageCount of 0, -1 and 2.5", () => {
    for (const pageCount of [0, -1, 2.5]) {
      expect(schema.safeParse({ ...documentValid, pageCount }).success).toBe(false);
    }
  });

  test("still accepts durationMs: 0 on the audio branch", () => {
    expect(schema.safeParse({ ...audioValid, durationMs: 0 }).success).toBe(true);
  });

  test("a row with no kind key parses through the union as audio, and comes back with kind stamped", () => {
    const { kind: _kind, ...noKind } = audioValid;
    const parsed = schema.parse(noKind);
    expect(parsed.kind).toBe("audio");
    // The full audio record comes back, with kind supplied.
    expect(parsed).toEqual(audioValid);
  });

  test("a bare z.discriminatedUnion over the same two branches rejects that same row", () => {
    // This pins the zod behaviour from D3, not our code — it is what stops
    // someone deleting the preprocess as redundant.
    const bare = z.discriminatedUnion("kind", [
      z.strictObject({
        id: z.string().min(1),
        capturedAt: z.iso.datetime(),
        kind: z.literal("audio").default("audio"),
        durationMs: z.number().int().nonnegative(),
        mimeType: z.string().min(1),
        ctx: z.unknown(),
      }),
      baseDocumentCaptureSchema,
    ]);

    const { kind: _kind, ...noKind } = audioValid;
    expect(bare.safeParse(noKind).success).toBe(false);
  });

  test("a row carrying kind: video is rejected, and not rewritten to audio", () => {
    const result = schema.safeParse({ ...audioValid, kind: "video" });
    expect(result.success).toBe(false);
    if (!result.success) {
      // The discriminator error names the expected values, not the received
      // one — but the row is rejected, not silently rewritten to audio.
      expect(result.error.issues.some((i) => i.code === "invalid_union")).toBe(true);
      // A successful parse would have produced kind: "audio", proving rewrite.
      // This asserts the opposite: the bad discriminator stopped the parse.
      expect(result.success).toBe(false);
    }
  });

  test("a document missing pageCount produces an issue whose path is [pageCount]", () => {
    const { pageCount: _pc, ...missingPageCount } = documentValid;
    const result = schema.safeParse(missingPageCount);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => JSON.stringify(i.path));
      expect(paths).toContain(JSON.stringify(["pageCount"]));
    }
  });
});

describe("capturePayloadSchema — outbox document integration", () => {
  test("an outbox document whose recording is a document capture parses", () => {
    // basePayloadSchema is what captureDocumentSchema uses for `recording`.
    expect(basePayloadSchema.safeParse(documentValid).success).toBe(true);
  });

  test("an outbox document whose recording predates the discriminant parses and reports kind === audio", () => {
    const legacyRecording = {
      id: "rec_legacy",
      capturedAt: "2026-07-23T10:00:00.000Z",
      durationMs: 5000,
      mimeType: "audio/webm",
      ctx: {},
    };
    const parsed = basePayloadSchema.parse(legacyRecording);
    expect(parsed.kind).toBe("audio");
    if (parsed.kind === "audio") {
      expect(parsed.durationMs).toBe(5000);
    }
  });
});

describe("capturePayloadSchema — type-level properties", () => {
  test("the union narrows on kind in TypeScript", () => {
    const item: CapturePayload = basePayloadSchema.parse(audioValid);
    if (item.kind === "audio") {
      // durationMs is accessible after narrowing.
      const _ms: number = item.durationMs;
      expect(_ms).toBe(12_500);
    } else {
      // pageCount is accessible on the document branch.
      const _pc: number = item.pageCount;
      expect(_pc).toBe(3);
    }
  });

  test("Recording and DocumentCapture are both CapturePayload members", () => {
    const rec: Recording = baseRecordingSchema.parse({
      id: "r",
      capturedAt: "2026-07-23T10:00:00.000Z",
      kind: "audio",
      durationMs: 0,
      mimeType: "audio/webm",
      ctx: {},
    });
    const doc: DocumentCapture = baseDocumentCaptureSchema.parse(documentValid);

    const items: CapturePayload[] = [rec, doc];
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.kind)).toEqual(["audio", "document"]);
  });
});
