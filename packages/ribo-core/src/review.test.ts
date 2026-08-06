import { describe, expect, test } from "vitest";
import { z } from "zod";

import { extractedSchema } from "./provenance.js";
import type { Extracted } from "./provenance.js";
import { buildReviewRequest, resolveReview, reviewOutcomeSchema } from "./review.js";
import type { ExtractedFields, FieldDecisions, ReviewOutcome, ReviewSubmission } from "./review.js";
import type { Transcript } from "./transcript.js";

// One adapter's field set, as an extractor would produce it: every value wrapped
// in the provenance envelope from `provenance.ts`.
const atticSchema = z.object({
  rValue: z.number(),
  area: z.number(),
  notes: z.string(),
});
type AtticFields = z.infer<typeof atticSchema>;

const TRANSCRIPT_TEXT =
  "The attic is R-19 over about four hundred square feet, and the hatch is uninsulated.";

const transcript: Transcript = {
  recordingId: "rec-1",
  text: TRANSCRIPT_TEXT,
  engine: "ondevice-whisper",
};

const extracted: ExtractedFields<AtticFields> = {
  rValue: { value: 19, confidence: 1, sourceSpan: "The attic is R-19" },
  area: { value: 400, confidence: 0.998, sourceSpan: "about four hundred square feet" },
  // Ungrounded on purpose: the model produced a summary that was never said.
  notes: { value: "hatch needs air sealing", confidence: 1, sourceSpan: "hatch needs air sealing" },
};

/** The same draft with `area` unstated — `null` is a legitimate extraction result. */
const nullArea: ExtractedFields<AtticFields> = {
  ...extracted,
  area: { value: null, confidence: 1, sourceSpan: null },
};

const acceptAll: FieldDecisions<AtticFields> = {
  rValue: { status: "accepted" },
  area: { status: "accepted" },
  notes: { status: "accepted" },
};

describe("buildReviewRequest", () => {
  test("carries each field's provenance envelope through to review", () => {
    const request = buildReviewRequest(extracted, transcript);

    expect(request.transcript).toBe(transcript);
    expect(request.fields.rValue.extracted).toEqual({
      value: 19,
      confidence: 1,
      sourceSpan: "The attic is R-19",
    });
  });

  test("flags each field as span-grounded or not, checked against the transcript", () => {
    const request = buildReviewRequest(extracted, transcript);

    expect(request.fields.rValue.isGrounded).toBe(true);
    expect(request.fields.area.isGrounded).toBe(true);
    // The span reads plausibly but is not in the transcript — this is the signal
    // the UI surfaces, NOT a confidence threshold (confidence here is 1).
    expect(request.fields.notes.isGrounded).toBe(false);
    expect(request.fields.notes.extracted.confidence).toBe(1);
  });

  test("a null span is not grounded", () => {
    const ungroundedArea: ExtractedFields<AtticFields> = {
      ...extracted,
      area: { value: 400, confidence: 1, sourceSpan: null },
    };
    const request = buildReviewRequest(ungroundedArea, transcript);

    expect(request.fields.area.isGrounded).toBe(false);
  });

  test("a field whose value is null still reaches review", () => {
    const request = buildReviewRequest(nullArea, transcript);

    expect(request.fields.area.extracted.value).toBeNull();
    expect(Object.keys(request.fields)).toEqual(["rValue", "area", "notes"]);
  });

  test("accepts envelopes parsed by extractedSchema", () => {
    const parsed = extractedSchema(z.number()).parse({
      value: 19,
      confidence: 1,
      sourceSpan: "The attic is R-19",
    });
    const request = buildReviewRequest({ rValue: parsed }, transcript);

    expect(request.fields.rValue.isGrounded).toBe(true);
  });
});

describe("resolveReview — accepted as-is", () => {
  test("every field accepted yields status 'accepted' with the extracted values", () => {
    const request = buildReviewRequest(extracted, transcript);

    const outcome = resolveReview(request, { status: "submitted", decisions: acceptAll });

    expect(outcome).toEqual({
      status: "accepted",
      fields: { rValue: 19, area: 400, notes: "hatch needs air sealing" },
    });
  });

  test("accepting a null value keeps the null — absence is an answer", () => {
    const request = buildReviewRequest(nullArea, transcript);

    const outcome = resolveReview(request, { status: "submitted", decisions: acceptAll });

    expect(outcome.status).toBe("accepted");
    if (outcome.status !== "accepted") throw new Error("unreachable");
    expect(outcome.fields.area).toBeNull();
  });
});

describe("resolveReview — accepted with edits", () => {
  test("one edited field yields status 'edited' and the edited value", () => {
    const request = buildReviewRequest(extracted, transcript);

    const outcome = resolveReview(request, {
      status: "submitted",
      decisions: { ...acceptAll, rValue: { status: "edited", value: 30 } },
    });

    expect(outcome.status).toBe("edited");
    if (outcome.status !== "edited") throw new Error("unreachable");
    expect(outcome.fields).toEqual({ rValue: 30, area: 400, notes: "hatch needs air sealing" });
  });

  test("reports which fields the human touched", () => {
    const request = buildReviewRequest(extracted, transcript);

    const outcome = resolveReview(request, {
      status: "submitted",
      decisions: {
        rValue: { status: "edited", value: 30 },
        area: { status: "accepted" },
        notes: { status: "rejected" },
      },
    });

    if (outcome.status !== "edited") throw new Error("unreachable");
    expect(outcome.editedFields).toEqual(["rValue"]);
    expect(outcome.rejectedFields).toEqual(["notes"]);
  });

  test("a rejected field is omitted from the resolved fields entirely", () => {
    const request = buildReviewRequest(extracted, transcript);

    const outcome = resolveReview(request, {
      status: "submitted",
      decisions: { ...acceptAll, notes: { status: "rejected" } },
    });

    if (outcome.status !== "edited") throw new Error("unreachable");
    expect(outcome.fields).toEqual({ rValue: 19, area: 400 });
    expect("notes" in outcome.fields).toBe(false);
  });

  test("editing a field to null is NOT the same as rejecting it", () => {
    const request = buildReviewRequest(extracted, transcript);

    const outcome = resolveReview(request, {
      status: "submitted",
      decisions: { ...acceptAll, notes: { status: "edited", value: null } },
    });

    if (outcome.status !== "edited") throw new Error("unreachable");
    expect(outcome.fields.notes).toBeNull();
    expect("notes" in outcome.fields).toBe(true);
    expect(outcome.editedFields).toEqual(["notes"]);
  });

  test("rejecting every field still yields 'edited', not 'discarded'", () => {
    const request = buildReviewRequest(extracted, transcript);

    const outcome = resolveReview(request, {
      status: "submitted",
      decisions: {
        rValue: { status: "rejected" },
        area: { status: "rejected" },
        notes: { status: "rejected" },
      },
    });

    expect(outcome.status).toBe("edited");
    if (outcome.status !== "edited") throw new Error("unreachable");
    expect(outcome.fields).toEqual({});
    expect(outcome.rejectedFields).toEqual(["rValue", "area", "notes"]);
  });

  test("an edit that restores the extracted value still counts as touched", () => {
    const request = buildReviewRequest(extracted, transcript);

    const outcome = resolveReview(request, {
      status: "submitted",
      decisions: { ...acceptAll, rValue: { status: "edited", value: 19 } },
    });

    // Touched is the signal worth measuring — we deliberately do not compare
    // values to decide whether an edit "counted".
    expect(outcome.status).toBe("edited");
    if (outcome.status !== "edited") throw new Error("unreachable");
    expect(outcome.editedFields).toEqual(["rValue"]);
  });
});

describe("resolveReview — the adapter is still the trust boundary", () => {
  test("resolved values feed the adapter schema, which decides whether a null is legal", () => {
    const outcome = resolveReview(buildReviewRequest(extracted, transcript), {
      status: "submitted",
      decisions: acceptAll,
    });

    if (outcome.status !== "accepted") throw new Error("unreachable");
    expect(atticSchema.parse(outcome.fields)).toEqual(outcome.fields);

    // Review does not narrow nullability — `ToolAdapter.schema.parse` does.
    const withNull = resolveReview(buildReviewRequest(nullArea, transcript), {
      status: "submitted",
      decisions: acceptAll,
    });
    expect(atticSchema.safeParse((withNull as { fields: unknown }).fields).success).toBe(false);
  });
});

describe("resolveReview — discarded", () => {
  test("a discarded submission yields a discarded outcome, with no fields", () => {
    const request = buildReviewRequest(extracted, transcript);

    const outcome = resolveReview(request, { status: "discarded" });

    expect(outcome).toEqual({ status: "discarded" });
    expect("fields" in outcome).toBe(false);
  });

  test("a discard reason is carried through", () => {
    const request = buildReviewRequest(extracted, transcript);

    const outcome = resolveReview(request, {
      status: "discarded",
      reason: "wrong job — recorded against the neighbour's attic",
    });

    expect(outcome).toEqual({
      status: "discarded",
      reason: "wrong job — recorded against the neighbour's attic",
    });
  });
});

// --- Type-level tests -------------------------------------------------------
//
// Enforced by `tsc` (`pnpm --filter @azx/ribo-core typecheck`), not by the
// Vitest run above — esbuild strips types without checking them. Each
// `@ts-expect-error` is itself the assertion: if the error stops happening, tsc
// fails with "Unused '@ts-expect-error' directive".

test("the outcome is a discriminated union, not `T | null`", () => {
  // Returned from a function so control-flow analysis cannot narrow the union
  // away at the declaration site — the point is what an unnarrowed outcome is.
  const anyOutcome = (): ReviewOutcome<AtticFields> => ({ status: "discarded" });
  const outcome = anyOutcome();

  // @ts-expect-error - `fields` only exists once the union is narrowed; this is
  // exactly what `T | null` could not express.
  const _fields = outcome.fields;

  if (outcome.status === "accepted") {
    // Accepted-as-is carries every field, so there is no optionality to unwrap.
    const rValue: number | null = outcome.fields.rValue;
    expect(rValue).toBeNull();
  }

  expect(outcome.status).toBe("discarded");
});

test("a rejected field makes the resolved fields optional, so callers must handle absence", () => {
  const outcome = resolveReview(buildReviewRequest(extracted, transcript), {
    status: "submitted",
    decisions: { ...acceptAll, notes: { status: "rejected" } },
  });

  if (outcome.status === "edited") {
    // @ts-expect-error - a field may have been rejected, so it is `| undefined`.
    const notes: string | null = outcome.fields.notes;
    expect(notes).toBeUndefined();
  }

  expect(outcome.status).toBe("edited");
});

test("an edited value must have the field's type", () => {
  const decisions: FieldDecisions<AtticFields> = {
    // @ts-expect-error - `rValue` is a number; a string edit does not compile.
    rValue: { status: "edited", value: "thirty" },
    area: { status: "accepted" },
    notes: { status: "accepted" },
  };

  expect(decisions.area.status).toBe("accepted");
});

test("an edited decision must actually carry a value", () => {
  const decisions: FieldDecisions<AtticFields> = {
    // @ts-expect-error - "edited" without a value is meaningless.
    rValue: { status: "edited" },
    area: { status: "accepted" },
    notes: { status: "accepted" },
  };

  expect(decisions.rValue.status).toBe("edited");
});

test("a submission must decide every field — silence is not a decision", () => {
  const submission: ReviewSubmission<AtticFields> = {
    status: "submitted",
    // @ts-expect-error - `notes` is missing; every field gets an explicit verdict,
    // the same anti-silence rule the provenance envelope enforces on the model.
    decisions: { rValue: { status: "accepted" }, area: { status: "accepted" } },
  };

  expect(submission.status).toBe("submitted");
});

test("Extracted<T> lines up with ExtractedFields<F>", () => {
  const rValue: Extracted<number> = extracted.rValue;

  expect(rValue.value).toBe(19);
});

test("reviewOutcomeSchema accepts what resolveReview produces, for all three branches", () => {
  const accepted = { status: "accepted", fields: { atticRValue: 19 } };
  expect(reviewOutcomeSchema.parse(accepted)).toEqual(accepted);

  const edited = {
    status: "edited",
    fields: { atticRValue: 30 },
    editedFields: ["atticRValue"],
    rejectedFields: ["blowerDoorCfm50"],
  };
  expect(reviewOutcomeSchema.parse(edited)).toEqual(edited);

  const discarded = { status: "discarded", reason: "misspoke" };
  expect(reviewOutcomeSchema.parse(discarded)).toEqual(discarded);
  expect(reviewOutcomeSchema.parse({ status: "discarded" })).toEqual({ status: "discarded" });
});

test("reviewOutcomeSchema rejects an edited outcome missing its touched-field lists", () => {
  // `editedFields`/`rejectedFields` are what name the human's work. An `edited`
  // outcome without them is indistinguishable from `accepted` and must not parse.
  expect(() => reviewOutcomeSchema.parse({ status: "edited", fields: {} })).toThrow();
});
