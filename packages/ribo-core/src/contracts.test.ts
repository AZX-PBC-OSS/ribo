import { expect, test } from "vitest";
import { z } from "zod";

import {
  buildReviewRequest,
  enveloped,
  extractedSchema,
  FakeTranscriber,
  firstCapable,
  recordingSchema,
  resolveReview,
} from "./index.js";
import type {
  ExtractedFields,
  FieldDecisions,
  Recording,
  ToolAdapter,
  Transcriber,
  Transcript,
} from "./index.js";

/**
 * @file The composition test: one run of the whole Phase 1 vocabulary, in order.
 *
 * Every other test in this package checks one contract in isolation. This one is the proof that
 * they fit together — capture record → transcript → extraction envelopes → review request →
 * field decisions → resolved outcome → adapter write, with the host's `ctx` typed the whole way.
 * It imports through `./index.js` on purpose, so it also pins the barrel's public surface:
 * anything this test needs that the barrel stops exporting fails here first.
 *
 * There is no I/O, no model and no network. `FakeTranscriber` stands in for transcription and a
 * hand-built draft stands in for extraction, which is exactly what Phases 4–6 will do. Review
 * itself is a queue state, not a callback the pipeline awaits — see `review.ts`'s file header —
 * so what stands in for "a human reviewed it" here is a hand-built {@link FieldDecisions}, the
 * same shape `Outbox.submitReview` would receive from a real UI.
 *
 * One field (`notes`) is **deliberately ungrounded**: its `sourceSpan` reads plausibly but was
 * never said. That is the thread worth following through the file — the span is checked in
 * `buildReviewRequest`, surfaces as `isGrounded: false`, and is what makes review correct that
 * one field while accepting the rest. Note its `confidence` is 1.0, the same as every grounded
 * field: groundedness is the signal, confidence is not.
 */

// --- The host: one tool's fields, and the context needed to write them -------

/** What the adapter extracts and writes. `AtticFields` is inferred from it, never re-declared. */
const atticSchema = z.object({
  rValue: z.number(),
  area: z.number(),
  notes: z.string(),
});
type AtticFields = z.infer<typeof atticSchema>;

/** The host's context: opaque to core, required by the adapter, checked by the type system. */
interface JobContext {
  jobId: string;
}
const jobContextSchema = z.object({ jobId: z.string().min(1) });

interface Write {
  fields: AtticFields;
  ctx: JobContext;
}

const makeAdapter = (sink: Write[]): ToolAdapter<AtticFields, JobContext> => ({
  name: "snuggpro-attic-insulation",
  schema: atticSchema,
  // Derived, never declared beside the patch — `enveloped()` is the one supported
  // way to build it, so the two shapes cannot drift.
  extractionSchema: enveloped(atticSchema),
  // The host's context as a SCHEMA: `recording.ctx` came back out of storage, so
  // the destination of a write is parsed, not merely typed.
  ctxSchema: jobContextSchema,
  instructions: "Extract the attic insulation R-value, the area in square feet, and any notes.",
  write: async (fields, ctx) => {
    sink.push({ fields, ctx });
  },
});

// --- The capture ------------------------------------------------------------

const TRANSCRIPT_TEXT =
  "The attic is R-19 over about four hundred square feet, and the hatch is uninsulated.";

const recording: Recording<typeof jobContextSchema> = recordingSchema(jobContextSchema).parse({
  id: "rec-1",
  capturedAt: "2026-07-23T14:02:00.000Z",
  durationMs: 8_400,
  mimeType: "audio/webm;codecs=opus",
  ctx: { jobId: "job-7" },
});

/**
 * The extraction step, faked: a model would return this shape, parsed through
 * `extractedSchema` because extractor output crosses a trust boundary.
 *
 * `rValue` and `area` quote the transcript verbatim. `notes` does not — the model summarized.
 */
const extractDraft = (transcript: Transcript): ExtractedFields<AtticFields> => {
  expect(transcript.text).toBe(TRANSCRIPT_TEXT);

  return {
    rValue: extractedSchema(z.number()).parse({
      value: 19,
      confidence: 1,
      sourceSpan: "The attic is R-19",
    }),
    area: extractedSchema(z.number()).parse({
      value: 400,
      confidence: 1,
      sourceSpan: "about four hundred square feet",
    }),
    notes: extractedSchema(z.string()).parse({
      value: "hatch needs air sealing",
      confidence: 1,
      // Never said. Same confidence as the grounded fields — which is the point.
      sourceSpan: "hatch needs air sealing",
    }),
  };
};

// --- The pipeline -----------------------------------------------------------

test("the contracts compose: record → transcribe → extract → review → write", async () => {
  const written: Write[] = [];
  const adapter = makeAdapter(written);

  // 1. Transcribe. The audio blob is passed alongside the record, never inside it.
  //    Selection is part of the contract now: `firstCapable` prefers on-device and
  //    falls through to the managed path only when on-device cannot run here. The
  //    transcript records which one actually ran.
  const transcriber: Transcriber = firstCapable([
    new FakeTranscriber({
      engine: "ondevice-whisper",
      capability: { status: "needs-download", downloadBytes: 165_000_000 },
    }),
    new FakeTranscriber({
      engine: "managed-azure",
      responses: { "rec-1": { text: TRANSCRIPT_TEXT, confidence: 0.94 } },
    }),
  ]);
  const transcript = await transcriber.transcribe(recording, new Blob(["audio"]));

  expect(transcript.recordingId).toBe(recording.id);
  expect(transcript.engine).toBe("managed-azure");

  // 2. Extract into provenance envelopes.
  const extracted = extractDraft(transcript);

  // 3. Prepare for review. Each span is checked against the transcript here — this is where
  //    the invented `notes` quote is caught, without asking the model how sure it was.
  const request = buildReviewRequest(extracted, transcript);

  expect(request.fields.rValue.isGrounded).toBe(true);
  expect(request.fields.area.isGrounded).toBe(true);
  expect(request.fields.notes.isGrounded).toBe(false);
  expect(request.fields.notes.extracted.confidence).toBe(1);

  // 4. A human decides field by field: take the grounded values, correct the one whose
  //    justification does not check out. There is no presenter to invoke here — review is a
  //    queue state a UI reports back into, not a callback the pipeline awaits, so a hand-built
  //    `FieldDecisions` stands in for what `Outbox.submitReview` would receive from a real one.
  const decisions: FieldDecisions<AtticFields> = {
    rValue: { status: "accepted" },
    area: { status: "accepted" },
    notes: request.fields.notes.isGrounded
      ? { status: "accepted" }
      : { status: "edited", value: "hatch is uninsulated" },
  };

  // 5. Classify the submission. One field was touched, so this is `edited`, not `accepted`.
  const outcome = resolveReview(request, { status: "submitted", decisions });

  expect(outcome.status).toBe("edited");
  if (outcome.status !== "edited") throw new Error("unreachable");
  expect(outcome.editedFields).toEqual(["notes"]);
  expect(outcome.rejectedFields).toEqual([]);

  // 6. The adapter is the trust boundary: review returns nullable, possibly partial values, and
  //    `schema.parse` is what decides they are a legal `AtticFields`.
  const fields = adapter.schema.parse(outcome.fields);

  // 7. Write, with a `ctx` the type system checks — it comes off the recording's own context —
  //    and a `meta` that does not: the idempotency key is the queue's, not the recording's,
  //    which is why it is a third parameter rather than another key on `ctx`.
  await adapter.write(fields, adapter.ctxSchema.parse(recording.ctx), {
    idempotencyKey: "outbox-item-1",
  });

  expect(written).toEqual([
    {
      fields: { rValue: 19, area: 400, notes: "hatch is uninsulated" },
      ctx: { jobId: "job-7" },
    },
  ]);
});

test("review does not narrow nullability — the adapter schema rejects an unstated field", async () => {
  const transcriber = new FakeTranscriber({ responses: { "rec-1": TRANSCRIPT_TEXT } });
  const transcript = await transcriber.transcribe(recording, new Blob(["audio"]));

  // The auditor never gave an area, so the model correctly returns `null` rather than guessing.
  const draft: ExtractedFields<AtticFields> = {
    ...extractDraft(transcript),
    area: extractedSchema(z.number()).parse({ value: null, confidence: 1, sourceSpan: null }),
  };

  const outcome = resolveReview(buildReviewRequest(draft, transcript), {
    status: "submitted",
    decisions: {
      rValue: { status: "accepted" },
      area: { status: "accepted" },
      notes: { status: "accepted" },
    },
  });

  expect(outcome.status).toBe("accepted");
  if (outcome.status !== "accepted") throw new Error("unreachable");
  expect(outcome.fields.area).toBeNull();

  // Core carries the null through; the adapter decides it is not writable.
  expect(atticSchema.safeParse(outcome.fields).success).toBe(false);
});

// --- Type-level check -------------------------------------------------------
//
// Enforced by `tsc`, not by the Vitest run above. The `@ts-expect-error` is the
// assertion: if the error stops happening, the typecheck fails.

test("the adapter's ctx is typed end to end — a foreign context does not compile", async () => {
  const adapter = makeAdapter([]);
  // Hoisted so the call below stays on ONE line: `@ts-expect-error` applies to the
  // line that follows it, and a call Prettier wraps would attach the directive to
  // `await adapter.write(` — where nothing is wrong — instead of to the bad ctx.
  const fields = { rValue: 19, area: 400, notes: "" };
  const meta = { idempotencyKey: "outbox-item-1" };

  // @ts-expect-error - `ToolAdapter<AtticFields, JobContext>` needs a `jobId`. This is the hole
  // that `ctx: unknown` left open, and the reason `C` is a real type parameter. A valid `meta`
  // is supplied so the ctx is the only thing wrong with the call.
  await adapter.write(fields, { assessmentId: "a-1" }, meta);

  expect(adapter.name).toBe("snuggpro-attic-insulation");
});
