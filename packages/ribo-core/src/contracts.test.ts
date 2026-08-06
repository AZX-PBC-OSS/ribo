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
  FieldDecisions,
  Recording,
  ReviewRequest,
  ToolAdapter,
  Transcriber,
  Transcript,
} from "./index.js";

/**
 * @file The composition test: one run of the whole Phase 1 vocabulary, in order.
 *
 * Every other test in this package checks one contract in isolation. This one is the proof that
 * they fit together — capture record → transcript → extraction envelopes → review request →
 * leaf decisions → resolved outcome → adapter write, with the host's `ctx` typed the whole way.
 * It imports through `./index.js` on purpose, so it also pins the barrel's public surface:
 * anything this test needs that the barrel stops exporting fails here first.
 *
 * There is no I/O, no model and no network. `FakeTranscriber` stands in for transcription and a
 * hand-built draft stands in for extraction, which is exactly what Phases 4–6 will do. Review
 * itself is a queue state, not a callback the pipeline awaits — see `review.ts`'s file header —
 * so what stands in for "a human reviewed it" here is a hand-built {@link FieldDecisions}, the
 * same shape `Outbox.submitReview` would receive from a real UI.
 *
 * Two threads worth following through the file:
 *
 *   - One field (`notes`) is **deliberately ungrounded**: its `sourceSpan` reads plausibly but was
 *     never said. The span is checked in `buildReviewRequest`, surfaces as `isGrounded: false`, and
 *     is what makes review correct that one field while accepting the rest. Its `confidence` is
 *     1.0, the same as every grounded field: groundedness is the signal, confidence is not.
 *   - The field set is **nested**, and review addresses its leaves by dotted path. `healthSafety`
 *     is a two-test miniature of Snugg Pro's 11-test matrix, and the pipeline below accepts one of
 *     its tests while rejecting the other — which a review keyed on top-level fields could not
 *     express, and which is the reason review moved to leaf paths at all.
 */

// --- The host: one tool's fields, and the context needed to write them -------

/**
 * The PATCH this adapter writes: every leaf `.nullable().optional()`, per design §2.1.
 * `AtticValues` is inferred from it, never re-declared.
 *
 * Both halves of every leaf are load-bearing, and the pipeline below exercises both:
 * `.optional()` because a REJECTED leaf is absent from the patch entirely ("leave this field
 * alone"), and `.nullable()` because a present `null` is a written value ("record this as
 * empty"). Rejecting a leaf and editing it to `null` are therefore different instructions to
 * the host tool, which is exactly the distinction `review.ts` draws.
 */
const atticSchema = z.object({
  rValue: z.number().nullable().optional(),
  area: z.number().nullable().optional(),
  notes: z.string().nullable().optional(),
  healthSafety: z
    .object({
      ambientCo: z.enum(["passed", "failed"]).nullable().optional(),
      gasLeak: z.enum(["passed", "failed"]).nullable().optional(),
    })
    .optional(),
});
type AtticValues = z.infer<typeof atticSchema>;

/** Derived once, so the draft below and the adapter cannot describe different shapes. */
const atticExtractionSchema = enveloped(atticSchema);

/** The host's context: opaque to core, required by the adapter, checked by the type system. */
interface JobContext {
  jobId: string;
}
const jobContextSchema = z.object({ jobId: z.string().min(1) });

interface Write {
  fields: AtticValues;
  ctx: JobContext;
}

const makeAdapter = (sink: Write[]): ToolAdapter<AtticValues, JobContext> => ({
  name: "snuggpro-attic-insulation",
  schema: atticSchema,
  // Derived, never declared beside the patch — `enveloped()` is the one supported
  // way to build it, so the two shapes cannot drift.
  extractionSchema: atticExtractionSchema,
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
  "The attic is R-19 over about four hundred square feet, the hatch is uninsulated, " +
  "and ambient CO came back clean.";

const recording: Recording<typeof jobContextSchema> = recordingSchema(jobContextSchema).parse({
  id: "rec-1",
  capturedAt: "2026-07-23T14:02:00.000Z",
  durationMs: 8_400,
  mimeType: "audio/webm;codecs=opus",
  ctx: { jobId: "job-7" },
});

/**
 * The extraction step, faked: a model would return this shape, parsed through the DERIVED
 * extraction schema because extractor output crosses a trust boundary.
 *
 * Parsing through `atticExtractionSchema` rather than field-by-field envelopes is itself part
 * of the composition: it is what proves the model's payload matches the shape `enveloped()`
 * derived from the patch, including the nested matrix being 2 envelopes rather than 1.
 *
 * `rValue`, `area` and `ambientCo` quote the transcript verbatim. `notes` does not — the model
 * summarized. `gasLeak` was never mentioned, so it is an explicit `null` with no span: the
 * anti-hallucination rule means the model must SAY it has nothing rather than omit the key.
 */
const extractDraft = (transcript: Transcript): z.infer<typeof atticExtractionSchema> => {
  expect(transcript.text).toBe(TRANSCRIPT_TEXT);

  return atticExtractionSchema.parse({
    rValue: { value: 19, confidence: 1, sourceSpan: "The attic is R-19" },
    area: { value: 400, confidence: 1, sourceSpan: "about four hundred square feet" },
    notes: {
      value: "hatch needs air sealing",
      confidence: 1,
      // Never said. Same confidence as the grounded fields — which is the point.
      sourceSpan: "hatch needs air sealing",
    },
    healthSafety: {
      ambientCo: { value: "passed", confidence: 1, sourceSpan: "ambient CO came back clean" },
      gasLeak: { value: null, confidence: 1, sourceSpan: null },
    },
  });
};

/**
 * One leaf of a review request, or a failure naming the path. `ReviewFields` is a `Record`
 * keyed by dotted path, so every read is `ReviewField | undefined` — which is precisely why
 * `resolveReview` checks completeness at runtime rather than trusting the type.
 */
const field = (request: ReviewRequest, path: string) => {
  const found = request.fields[path];
  if (found === undefined) throw new Error(`no review field at "${path}"`);
  return found;
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

  // 3. Prepare for review. The ADAPTER'S PATCH is what enumerates the leaves — the extracted
  //    data is only looked up, path by path — and each span is checked against the transcript
  //    here, which is where the invented `notes` quote is caught without asking the model how
  //    sure it was.
  //
  //    NOTE the schema is passed as `atticSchema`, not `adapter.schema`. `ToolAdapter.schema`
  //    is typed `ZodType<V>` (design §2.3), which binds `V` but is not walkable — it has no
  //    `.shape`. `buildReviewRequest` needs the `z.ZodObject` to enumerate leaves from. Every
  //    caller today holds the concrete schema, so this is not a hole yet; reconciling the two
  //    is a `toWriteStep`/hook-layer question, flagged in the Task 4 report.
  const request = buildReviewRequest(extracted, transcript, atticSchema);

  expect(Object.keys(request.fields)).toEqual([
    "rValue",
    "area",
    "notes",
    "healthSafety.ambientCo",
    "healthSafety.gasLeak",
  ]);
  expect(field(request, "rValue").isGrounded).toBe(true);
  expect(field(request, "healthSafety.ambientCo").isGrounded).toBe(true);
  expect(field(request, "notes").isGrounded).toBe(false);
  expect(field(request, "notes").extracted.confidence).toBe(1);

  // 4. A human decides LEAF by leaf: take the grounded values, correct the one whose
  //    justification does not check out, drop the health-safety test that was never run. There
  //    is no presenter to invoke here — review is a queue state a UI reports back into, not a
  //    callback the pipeline awaits, so a hand-built `FieldDecisions` stands in for what
  //    `Outbox.submitReview` would receive from a real one. The two `healthSafety` leaves get
  //    DIFFERENT verdicts, which is the thing top-level-key review could not do.
  const decisions: FieldDecisions = {
    rValue: { status: "accepted" },
    area: { status: "accepted" },
    notes: field(request, "notes").isGrounded
      ? { status: "accepted" }
      : { status: "edited", value: "hatch is uninsulated" },
    "healthSafety.ambientCo": { status: "accepted" },
    "healthSafety.gasLeak": { status: "rejected" },
  };

  // 5. Classify the submission. One leaf was corrected and one dropped, so this is `edited`.
  //    Each accepted and edited value is parsed against its own leaf schema on the way through,
  //    so a UI that submitted "thirty" for a number would be told here, by path, rather than
  //    failing at the write step as a dead queue row.
  const outcome = resolveReview(request, { status: "submitted", decisions });

  expect(outcome.status).toBe("edited");
  if (outcome.status !== "edited") throw new Error("unreachable");
  expect(outcome.editedFields).toEqual(["notes"]);
  expect(outcome.rejectedFields).toEqual(["healthSafety.gasLeak"]);

  // 6. The adapter is the outer trust boundary: review returns a nested, partial patch, and
  //    `schema.parse` is what decides it is a legal `AtticValues`. The rejected leaf is absent
  //    from the nested `healthSafety` object rather than present as `null`.
  const fields = adapter.schema.parse(outcome.fields);

  // 7. Write, with a `ctx` the type system checks — it comes off the recording's own context —
  //    and a `meta` that does not: the idempotency key is the queue's, not the recording's,
  //    which is why it is a third parameter rather than another key on `ctx`.
  await adapter.write(fields, adapter.ctxSchema.parse(recording.ctx), {
    idempotencyKey: "outbox-item-1",
  });

  expect(written).toEqual([
    {
      fields: {
        rValue: 19,
        area: 400,
        notes: "hatch is uninsulated",
        healthSafety: { ambientCo: "passed" },
      },
      ctx: { jobId: "job-7" },
    },
  ]);
});

test("a rejected leaf and a leaf reviewed to null are different instructions to the write", async () => {
  const transcriber = new FakeTranscriber({ responses: { "rec-1": TRANSCRIPT_TEXT } });
  const transcript = await transcriber.transcribe(recording, new Blob(["audio"]));
  const adapter = makeAdapter([]);

  // The auditor never gave an area, so the model correctly returns `null` rather than guessing.
  const draft = {
    ...extractDraft(transcript),
    area: extractedSchema(z.number()).parse({ value: null, confidence: 1, sourceSpan: null }),
  };

  const outcome = resolveReview(buildReviewRequest(draft, transcript, atticSchema), {
    status: "submitted",
    decisions: {
      rValue: { status: "accepted" },
      // Accepted as `null`: "I have nothing to record here" — a value that gets written.
      area: { status: "accepted" },
      // Rejected: "do not touch this field at all" — absent from the patch entirely.
      notes: { status: "rejected" },
      "healthSafety.ambientCo": { status: "accepted" },
      "healthSafety.gasLeak": { status: "accepted" },
    },
  });

  if (outcome.status !== "edited") throw new Error("unreachable");

  // The patch is the write contract, and the two absences are NOT interchangeable in it:
  // `area` is present and null (design §2.1: "write this field as empty" — Snugg Pro's
  // `Not Tested`), while `notes` has no key at all ("leave whatever is there alone").
  const fields = adapter.schema.parse(outcome.fields);

  expect("area" in fields).toBe(true);
  expect(fields.area).toBeNull();
  expect("notes" in fields).toBe(false);
  // A nested group survives with the leaves that survived, nulls included.
  expect(fields.healthSafety).toEqual({ ambientCo: "passed", gasLeak: null });
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

  // @ts-expect-error - `ToolAdapter<AtticValues, JobContext>` needs a `jobId`. This is the hole
  // that `ctx: unknown` left open, and the reason `C` is a real type parameter. A valid `meta`
  // is supplied so the ctx is the only thing wrong with the call.
  await adapter.write(fields, { assessmentId: "a-1" }, meta);

  expect(adapter.name).toBe("snuggpro-attic-insulation");
});
