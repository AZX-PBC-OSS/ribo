import { describe, expect, test } from "vitest";
import { z } from "zod";

import type { enveloped } from "../provenance/enveloped.js";
import type { ExtractOptions, Extractor, SkippedItem } from "../extraction/extractor.js";
import { deriveExtractionShape } from "../extraction/shape/shape-operations.js";
import type { AnnotatedTranscript } from "../capture/annotated-transcript.js";
import type { ExistingRecord } from "./instance-identity.js";
import {
  buildReviewRequest,
  resolveReview,
  ReviewValidationError,
  reviewOutcomeSchema,
} from "./review.js";
import type {
  FieldDecision,
  FieldDecisions,
  ReviewField,
  ReviewNode,
  ReviewOutcome,
  ReviewPlan,
  ReviewRequest,
  ReviewSectionNode,
} from "./review.js";
import type { Transcript } from "../capture/transcript.js";

/**
 * @file The review contract, over a values schema shaped like a real adapter's.
 *
 * `atticSchema` below is a **patch** (design §2.1): every leaf `.nullable().optional()`,
 * and one nested group. It is small so the assertions stay readable, but the nesting is
 * not decorative — Snugg Pro's `healthSafety` matrix is exactly this shape, and mapping
 * review over top-level keys instead of leaves is the defect this task exists to fix.
 */
const atticSchema = z.object({
  rValue: z.number().nullable().optional(),
  // Declared in the MIDDLE on purpose. `review.ts` documents that leaves are presented
  // in schema-declaration order, with a nested group inline at its own key's position.
  // With the group declared LAST, an implementation that collected every top-level leaf
  // first and appended nested groups afterwards would produce the same order, and the
  // order assertions below could not fail. Declared here, that implementation yields
  // ["rValue", "notes", "healthSafety.*"] and they do.
  healthSafety: z
    .object({
      ambientCo: z.enum(["passed", "failed"]).nullable().optional(),
      gasLeak: z.enum(["passed", "failed"]).nullable().optional(),
    })
    .optional(),
  notes: z.string().nullable().optional(),
});

/** The shape the model emits, derived from the patch — never declared beside it. */
type AtticDraft = z.infer<ReturnType<typeof enveloped<typeof atticSchema>>>;

const TRANSCRIPT_TEXT =
  "The attic is R-19 over about four hundred square feet, and ambient CO came back clean.";

const transcript: Transcript = {
  recordingId: "rec-1",
  text: TRANSCRIPT_TEXT,
  engine: "ondevice-whisper",
};

const draft: AtticDraft = {
  rValue: { value: 19, confidence: 1, sourceSpan: "The attic is R-19" },
  healthSafety: {
    ambientCo: { value: "passed", confidence: 1, sourceSpan: "ambient CO came back clean" },
    gasLeak: { value: null, confidence: 1, sourceSpan: null },
  },
  // Ungrounded on purpose: the model produced a summary that was never said.
  notes: { value: "hatch needs air sealing", confidence: 1, sourceSpan: "hatch needs air sealing" },
};

/**
 * Declaration order, which is the order the review card renders in — and note the
 * nested group's leaves sit INLINE at their key's position, not appended at the end.
 */
const LEAF_PATHS = ["rValue", "healthSafety.ambientCo", "healthSafety.gasLeak", "notes"];

const requestFor = (extracted: Record<string, unknown>): ReviewRequest =>
  buildReviewRequest(extracted, transcript, atticSchema);

/**
 * One leaf, or a failure naming the path. `ReviewFields` is a `Record`, so every read
 * is `ReviewField | undefined` — the price of addressing 34 differently-typed leaves
 * through one key space, and the reason completeness is checked at runtime.
 */
const leaf = (request: ReviewRequest, path: string): ReviewField => {
  const field = request.fields[path];
  if (field === undefined) throw new Error(`no review field at "${path}"`);
  return field;
};

const decisionsFor = (
  paths: readonly string[],
  status: "accepted" | "rejected" = "accepted",
): FieldDecisions =>
  Object.fromEntries(paths.map((path): [string, FieldDecision] => [path, { status }]));

/** Every leaf accepted — the baseline every "one thing differs" case is spread over. */
const acceptAll = decisionsFor(LEAF_PATHS);

/** `acceptAll` with one path left out, for the completeness cases. */
const acceptAllExcept = (dropped: string): FieldDecisions =>
  decisionsFor(LEAF_PATHS.filter((path) => path !== dropped));

describe("buildReviewRequest — the schema enumerates the fields, not the data", () => {
  test("presents one leaf per schema leaf, nested groups as dotted paths", () => {
    const request = requestFor(draft);

    expect(Object.keys(request.fields)).toEqual(LEAF_PATHS);
    expect(request.transcript).toBe(transcript);
  });

  test("a nested group's leaves sit inline at its key's position, not appended", () => {
    // The documented contract (`ReviewFields`) is schema-DECLARATION order, and a
    // nested group is not a special case that gets sorted to the end. `atticSchema`
    // declares `healthSafety` between `rValue` and `notes` precisely so a walk that
    // took top-level leaves first and appended groups afterwards would produce
    // ["rValue", "notes", "healthSafety.*"] and fail here.
    expect(Object.keys(requestFor(draft).fields)).toEqual([
      "rValue",
      "healthSafety.ambientCo",
      "healthSafety.gasLeak",
      "notes",
    ]);
  });

  test("the touched-field lists follow that same order", () => {
    const outcome = resolveReview(requestFor(draft), {
      status: "submitted",
      decisions: {
        rValue: { status: "rejected" },
        "healthSafety.ambientCo": { status: "edited", value: "failed" },
        "healthSafety.gasLeak": { status: "rejected" },
        notes: { status: "edited", value: "hatch is uninsulated" },
      },
    });

    if (outcome.status !== "edited") throw new Error("unreachable");
    // Not sorted, and not grouped by verdict — the order the schema declares.
    expect(outcome.editedFields).toEqual(["healthSafety.ambientCo", "notes"]);
    expect(outcome.rejectedFields).toEqual(["rValue", "healthSafety.gasLeak"]);
  });

  test("a nested group is one verdict per test, not one for the matrix", () => {
    const request = requestFor(draft);

    expect(leaf(request, "healthSafety.ambientCo").extracted).toEqual({
      value: "passed",
      confidence: 1,
      sourceSpan: "ambient CO came back clean",
    });
    expect(leaf(request, "healthSafety.gasLeak").extracted.value).toBeNull();
    // The group itself is never a field: it has no envelope of its own to accept.
    expect("healthSafety" in request.fields).toBe(false);
  });

  test("a leaf the model omitted is still presented, with the sentinel envelope", () => {
    // No `notes` key at all, and a health matrix missing one of its two tests.
    const partial = {
      rValue: draft.rValue,
      healthSafety: { ambientCo: draft.healthSafety.ambientCo },
    };

    const request = requestFor(partial);

    expect(Object.keys(request.fields)).toEqual(LEAF_PATHS);
    expect(leaf(request, "notes").extracted).toEqual({
      value: null,
      confidence: 0,
      sourceSpan: null,
    });
    expect(leaf(request, "healthSafety.gasLeak").extracted).toEqual({
      value: null,
      confidence: 0,
      sourceSpan: null,
    });
  });

  test("a whole nested group missing from the data still yields all its leaves", () => {
    const request = requestFor({ rValue: draft.rValue });

    expect(Object.keys(request.fields)).toEqual(LEAF_PATHS);
    expect(leaf(request, "healthSafety.ambientCo").extracted.confidence).toBe(0);
  });

  test("the sentinel is a fresh object per leaf, not one shared instance", () => {
    const request = requestFor({});

    expect(leaf(request, "rValue").extracted).not.toBe(leaf(request, "notes").extracted);
  });

  test("flags each leaf as span-grounded or not, checked against the transcript", () => {
    const request = requestFor(draft);

    expect(leaf(request, "rValue").isGrounded).toBe(true);
    expect(leaf(request, "healthSafety.ambientCo").isGrounded).toBe(true);
    // The span reads plausibly but is not in the transcript — this is the signal
    // the UI surfaces, NOT a confidence threshold (confidence here is 1).
    expect(leaf(request, "notes").isGrounded).toBe(false);
    expect(leaf(request, "notes").extracted.confidence).toBe(1);
    // A null span cannot be a verbatim quote, so an omitted leaf is never grounded.
    expect(leaf(request, "healthSafety.gasLeak").isGrounded).toBe(false);
  });
});

describe("buildReviewRequest — each leaf carries its own value schema", () => {
  test("the leaf schema parses a legal value and rejects an illegal one", () => {
    const request = requestFor(draft);

    expect(leaf(request, "rValue").schema.parse(30)).toBe(30);
    expect(leaf(request, "rValue").schema.safeParse("thirty").success).toBe(false);

    // An enum leaf: the schema is the ONLY runtime source for its members, which is
    // why a UI can render this editor knowing nothing about the adapter.
    const ambientCo = leaf(request, "healthSafety.ambientCo").schema;
    expect(ambientCo.parse("failed")).toBe("failed");
    expect(ambientCo.safeParse("clean").success).toBe(false);
  });

  test("the leaf schema keeps the patch's nullability — null is a legal reviewed value", () => {
    const request = requestFor(draft);

    expect(leaf(request, "rValue").schema.parse(null)).toBeNull();
  });
});

describe("resolveReview — accepted as-is", () => {
  test("every leaf accepted yields 'accepted' with the extracted values, renested", () => {
    const outcome = resolveReview(requestFor(draft), {
      status: "submitted",
      decisions: acceptAll,
    });

    expect(outcome).toEqual({
      status: "accepted",
      fields: {
        rValue: 19,
        notes: "hatch needs air sealing",
        healthSafety: { ambientCo: "passed", gasLeak: null },
      },
    });
  });

  test("the reassembled fields are nested, never dotted keys", () => {
    const outcome = resolveReview(requestFor(draft), {
      status: "submitted",
      decisions: acceptAll,
    });

    if (outcome.status !== "accepted") throw new Error("unreachable");
    expect("healthSafety.ambientCo" in outcome.fields).toBe(false);
    expect(outcome.fields.healthSafety).toEqual({ ambientCo: "passed", gasLeak: null });
  });

  test("accepting a null value keeps the null — absence is an answer", () => {
    const outcome = resolveReview(requestFor(draft), {
      status: "submitted",
      decisions: acceptAll,
    });

    if (outcome.status !== "accepted") throw new Error("unreachable");
    expect((outcome.fields.healthSafety as Record<string, unknown>).gasLeak).toBeNull();
  });

  test("accepting a leaf the model omitted writes its sentinel null", () => {
    const outcome = resolveReview(requestFor({ rValue: draft.rValue }), {
      status: "submitted",
      decisions: acceptAll,
    });

    if (outcome.status !== "accepted") throw new Error("unreachable");
    expect(outcome.fields.notes).toBeNull();
  });
});

describe("resolveReview — accepted with edits", () => {
  test("one edited leaf yields 'edited' and the edited value", () => {
    const outcome = resolveReview(requestFor(draft), {
      status: "submitted",
      decisions: { ...acceptAll, rValue: { status: "edited", value: 30 } },
    });

    if (outcome.status !== "edited") throw new Error("unreachable");
    expect(outcome.fields.rValue).toBe(30);
    expect(outcome.editedFields).toEqual(["rValue"]);
  });

  test("a nested leaf can be corrected while its siblings are accepted", () => {
    const outcome = resolveReview(requestFor(draft), {
      status: "submitted",
      decisions: { ...acceptAll, "healthSafety.gasLeak": { status: "edited", value: "failed" } },
    });

    if (outcome.status !== "edited") throw new Error("unreachable");
    expect(outcome.fields.healthSafety).toEqual({ ambientCo: "passed", gasLeak: "failed" });
    expect(outcome.editedFields).toEqual(["healthSafety.gasLeak"]);
  });

  test("reports which leaves the human touched, by dotted path", () => {
    const outcome = resolveReview(requestFor(draft), {
      status: "submitted",
      decisions: {
        ...acceptAll,
        notes: { status: "edited", value: "hatch is uninsulated" },
        "healthSafety.gasLeak": { status: "rejected" },
      },
    });

    if (outcome.status !== "edited") throw new Error("unreachable");
    expect(outcome.editedFields).toEqual(["notes"]);
    expect(outcome.rejectedFields).toEqual(["healthSafety.gasLeak"]);
  });

  test("a rejected leaf is omitted from the resolved fields entirely", () => {
    const outcome = resolveReview(requestFor(draft), {
      status: "submitted",
      decisions: { ...acceptAll, notes: { status: "rejected" } },
    });

    if (outcome.status !== "edited") throw new Error("unreachable");
    expect("notes" in outcome.fields).toBe(false);
    expect(outcome.fields).toEqual({
      rValue: 19,
      healthSafety: { ambientCo: "passed", gasLeak: null },
    });
  });

  test("editing a leaf to null is NOT the same as rejecting it", () => {
    const outcome = resolveReview(requestFor(draft), {
      status: "submitted",
      decisions: { ...acceptAll, notes: { status: "edited", value: null } },
    });

    if (outcome.status !== "edited") throw new Error("unreachable");
    expect(outcome.fields.notes).toBeNull();
    expect("notes" in outcome.fields).toBe(true);
    expect(outcome.editedFields).toEqual(["notes"]);
  });

  test("rejecting every leaf of a group leaves the group itself absent", () => {
    const outcome = resolveReview(requestFor(draft), {
      status: "submitted",
      decisions: {
        ...acceptAll,
        "healthSafety.ambientCo": { status: "rejected" },
        "healthSafety.gasLeak": { status: "rejected" },
      },
    });

    if (outcome.status !== "edited") throw new Error("unreachable");
    // A patch's absent key means "leave this alone" — an empty `{}` would be a
    // present key, which is a different instruction.
    expect("healthSafety" in outcome.fields).toBe(false);
  });

  test("rejecting every leaf still yields 'edited', not 'discarded'", () => {
    const outcome = resolveReview(requestFor(draft), {
      status: "submitted",
      decisions: decisionsFor(LEAF_PATHS, "rejected"),
    });

    expect(outcome.status).toBe("edited");
    if (outcome.status !== "edited") throw new Error("unreachable");
    expect(outcome.fields).toEqual({});
    expect(outcome.rejectedFields).toEqual(LEAF_PATHS);
  });

  test("an edit that restores the extracted value still counts as touched", () => {
    const outcome = resolveReview(requestFor(draft), {
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

describe("resolveReview — validation at submit", () => {
  test("an edited value its leaf schema rejects fails the submission, naming the path", () => {
    const submit = () =>
      resolveReview(requestFor(draft), {
        status: "submitted",
        decisions: { ...acceptAll, rValue: { status: "edited", value: "thirty" } },
      });

    // Nothing is returned, so there is nothing to persist and nothing advances the
    // item to `writing` — "does not persist" is structural, not a convention.
    expect(submit).toThrow(ReviewValidationError);
    expect(submit).toThrow(/rValue/);

    try {
      submit();
      throw new Error("unreachable");
    } catch (error) {
      if (!(error instanceof ReviewValidationError)) throw error;
      expect(error.issues.map((issue) => issue.path)).toEqual(["rValue"]);
    }
  });

  test("a nested leaf's bad value is reported at its dotted path", () => {
    try {
      resolveReview(requestFor(draft), {
        status: "submitted",
        decisions: { ...acceptAll, "healthSafety.ambientCo": { status: "edited", value: "clean" } },
      });
      throw new Error("unreachable");
    } catch (error) {
      if (!(error instanceof ReviewValidationError)) throw error;
      expect(error.issues.map((issue) => issue.path)).toEqual(["healthSafety.ambientCo"]);
    }
  });

  test("every bad leaf is reported at once, not one per round trip", () => {
    try {
      resolveReview(requestFor(draft), {
        status: "submitted",
        decisions: {
          ...acceptAll,
          rValue: { status: "edited", value: "thirty" },
          notes: { status: "edited", value: 42 },
        },
      });
      throw new Error("unreachable");
    } catch (error) {
      if (!(error instanceof ReviewValidationError)) throw error;
      expect(error.issues.map((issue) => issue.path)).toEqual(["rValue", "notes"]);
    }
  });

  test("an edited leaf carrying `undefined` is refused, not written as an absent key", () => {
    // `value` is `unknown`, so this is type-legal, and it is exactly what a React
    // editor whose state is `undefined` submits. Every patch leaf is `.optional()`, so
    // the leaf schema ACCEPTS it — and the key would then vanish on serialisation,
    // reading back as "leave this field alone" while `editedFields` still named it as
    // touched. The absent-vs-null distinction the patch model rests on, lost silently.
    try {
      resolveReview(requestFor(draft), {
        status: "submitted",
        decisions: { ...acceptAll, rValue: { status: "edited", value: undefined } },
      });
      throw new Error("unreachable");
    } catch (error) {
      if (!(error instanceof ReviewValidationError)) throw error;
      expect(error.issues).toEqual([
        {
          path: "rValue",
          message:
            "an edited leaf must carry a value or null, not undefined — reject it instead " +
            "to leave the field untouched",
        },
      ]);
    }
  });

  test("`undefined` really does pass the leaf schema — the guard is not redundant", () => {
    // Why the check above cannot be left to zod: this is what zod alone would allow.
    expect(leaf(requestFor(draft), "rValue").schema.safeParse(undefined).success).toBe(true);
  });

  test("an unrecognised decision status is refused, not read as 'accepted'", () => {
    // Not type-legal, which is the point: a hand-built literal or a decision that
    // crossed a serialisation boundary can carry a typo, and falling through to the
    // accept path would write the model's value with `editedFields` empty — a silent
    // write recorded as though a human had endorsed it.
    const typo = { status: "reject" } as unknown as FieldDecision;

    try {
      resolveReview(requestFor(draft), {
        status: "submitted",
        decisions: { ...acceptAll, notes: typo },
      });
      throw new Error("unreachable");
    } catch (error) {
      if (!(error instanceof ReviewValidationError)) throw error;
      expect(error.issues).toEqual([
        {
          path: "notes",
          message:
            'unrecognised decision status "reject" — expected "accepted", "edited" or "rejected"',
        },
      ]);
    }
  });

  test("an accepted value that fails names the escape the auditor actually has", () => {
    // Design §2.1 makes a patch leaf nullable only where a null is meaningful, so
    // `.optional()` alone is a legal declaration — but `enveloped()` still derives
    // `value: X.nullable()`, and an omitted leaf is presented with the null sentinel.
    // Accepting it fails, and "expected string, received null" on its own leaves the
    // auditor stuck with no idea that rejecting is the way out.
    const nonNullable = z.object({ serial: z.string().optional() });

    try {
      resolveReview(buildReviewRequest({}, transcript, nonNullable), {
        status: "submitted",
        decisions: { serial: { status: "accepted" } },
      });
      throw new Error("unreachable");
    } catch (error) {
      if (!(error instanceof ReviewValidationError)) throw error;
      expect(error.issues[0]?.path).toBe("serial");
      expect(error.issues[0]?.message).toMatch(/reject the leaf to leave the field untouched/);
    }
  });

  test("an accepted value is validated too — the model is not trusted either", () => {
    // A value that never passed an extraction-schema parse: an item read back from an
    // storage row written by an older, looser build would look exactly like this.
    const bad = { ...draft, rValue: { value: "R-19", confidence: 1, sourceSpan: null } };

    expect(() =>
      resolveReview(requestFor(bad), { status: "submitted", decisions: acceptAll }),
    ).toThrow(ReviewValidationError);
  });
});

describe("resolveReview — completeness at runtime", () => {
  test("a missing decision is refused, not read as 'accepted'", () => {
    try {
      resolveReview(requestFor(draft), {
        status: "submitted",
        decisions: acceptAllExcept("rValue"),
      });
      throw new Error("unreachable");
    } catch (error) {
      if (!(error instanceof ReviewValidationError)) throw error;
      expect(error.issues).toEqual([
        { path: "rValue", message: "no decision was submitted for this field" },
      ]);
    }
  });

  test("a decision key present but set to `undefined` counts as no decision", () => {
    // A UI that has not collected a verdict yet writes exactly this. It must read as
    // "the reviewer never decided" — not as a malformed decision, and certainly not as
    // "accepted", which is the case `FieldDecisions`-was-not-`Partial` existed to refuse.
    try {
      resolveReview(requestFor(draft), {
        status: "submitted",
        decisions: { ...acceptAll, rValue: undefined as unknown as FieldDecision },
      });
      throw new Error("unreachable");
    } catch (error) {
      if (!(error instanceof ReviewValidationError)) throw error;
      expect(error.issues).toEqual([
        { path: "rValue", message: "no decision was submitted for this field" },
      ]);
    }
  });

  test("a path inherited from the prototype is not a decision", () => {
    // `hasDecision` is own-keys-only so it agrees with the `Object.keys` half: a
    // prototype-aware read would count `toString` as decided while `Object.keys` never
    // lists it, and the two halves would disagree about the same object.
    const proto = z.object({ toString: z.string().nullable().optional() });

    try {
      resolveReview(buildReviewRequest({}, transcript, proto), {
        status: "submitted",
        decisions: {},
      });
      throw new Error("unreachable");
    } catch (error) {
      if (!(error instanceof ReviewValidationError)) throw error;
      expect(error.issues).toEqual([
        { path: "toString", message: "no decision was submitted for this field" },
      ]);
    }
  });

  test("an unexpected path is refused — the UI and the schema must agree", () => {
    try {
      resolveReview(requestFor(draft), {
        status: "submitted",
        decisions: { ...acceptAll, atticArea: { status: "accepted" } },
      });
      throw new Error("unreachable");
    } catch (error) {
      if (!(error instanceof ReviewValidationError)) throw error;
      expect(error.issues).toEqual([
        { path: "atticArea", message: "not a field of this review request" },
      ]);
    }
  });

  test("a group's own name is not a substitute for its leaves' paths", () => {
    expect(() =>
      resolveReview(requestFor(draft), {
        status: "submitted",
        decisions: {
          ...acceptAllExcept("healthSafety.ambientCo"),
          healthSafety: { status: "accepted" },
        },
      }),
    ).toThrow(ReviewValidationError);
  });

  test("an empty submission is refused, which the type can no longer do", () => {
    try {
      resolveReview(requestFor(draft), { status: "submitted", decisions: {} });
      throw new Error("unreachable");
    } catch (error) {
      if (!(error instanceof ReviewValidationError)) throw error;
      expect(error.issues.map((issue) => issue.path)).toEqual(LEAF_PATHS);
    }
  });
});

describe("resolveReview — discarded", () => {
  test("a discarded submission yields a discarded outcome, with no fields", () => {
    const outcome = resolveReview(requestFor(draft), { status: "discarded" });

    expect(outcome).toEqual({ status: "discarded" });
    expect("fields" in outcome).toBe(false);
  });

  test("a discard reason is carried through", () => {
    const outcome = resolveReview(requestFor(draft), {
      status: "discarded",
      reason: "wrong job — recorded against the neighbour's attic",
    });

    expect(outcome).toEqual({
      status: "discarded",
      reason: "wrong job — recorded against the neighbour's attic",
    });
  });

  test("a discard is not checked for completeness — there are no decisions to check", () => {
    expect(() => resolveReview(requestFor(draft), { status: "discarded" })).not.toThrow();
  });
});

describe("field names that would break the dotted-path model", () => {
  test("a field name containing '.' is refused when the schema is walked", () => {
    const collides = z.object({ "healthSafety.ambientCo": z.string().nullable().optional() });

    expect(() => buildReviewRequest({}, transcript, collides)).toThrow(/contains "\."/);
  });

  test("a nested field name containing '.' is refused, naming its parent", () => {
    const collides = z.object({
      healthSafety: z.object({ "ambient.co": z.string().nullable().optional() }),
    });

    expect(() => buildReviewRequest({}, transcript, collides)).toThrow(/under "healthSafety"/);
  });

  test("an integer-like field name is refused — it would silently reorder the card", () => {
    const reordering = z.object({
      rValue: z.number().nullable().optional(),
      "2024": z.number().nullable().optional(),
    });

    expect(() => buildReviewRequest({}, transcript, reordering)).toThrow(/integer-like/);
  });

  test("a name that merely contains digits is fine", () => {
    const fine = z.object({ blowerDoorCfm50: z.number().nullable().optional() });

    expect(Object.keys(buildReviewRequest({}, transcript, fine).fields)).toEqual([
      "blowerDoorCfm50",
    ]);
  });
});

describe("the persisted outcome needs no migration for nested values or dotted paths", () => {
  // Design §4 claims R1.5 needs no storage document version bump: `fields` is
  // `z.record(z.string(), z.unknown())`, which accepts a nested object, and the
  // touched-field lists are `z.array(z.string())`, which accept dotted paths. This is
  // that claim, checked against real `resolveReview` output. (`queue/storage-memory.test.ts`
  // checks the round trip through real storage and the RxDB document schema.)
  test("reviewOutcomeSchema accepts what resolveReview now produces, all three branches", () => {
    const accepted = resolveReview(requestFor(draft), {
      status: "submitted",
      decisions: acceptAll,
    });
    expect(reviewOutcomeSchema.parse(accepted)).toEqual(accepted);

    const edited = resolveReview(requestFor(draft), {
      status: "submitted",
      decisions: {
        ...acceptAll,
        "healthSafety.ambientCo": { status: "edited", value: "failed" },
        "healthSafety.gasLeak": { status: "rejected" },
      },
    });
    expect(reviewOutcomeSchema.parse(edited)).toEqual(edited);
    if (edited.status !== "edited") throw new Error("unreachable");
    expect(edited.fields.healthSafety).toEqual({ ambientCo: "failed" });
    expect(edited.editedFields).toEqual(["healthSafety.ambientCo"]);
    expect(edited.rejectedFields).toEqual(["healthSafety.gasLeak"]);

    const discarded = { status: "discarded", reason: "misspoke" };
    expect(reviewOutcomeSchema.parse(discarded)).toEqual(discarded);
    expect(reviewOutcomeSchema.parse({ status: "discarded" })).toEqual({ status: "discarded" });
  });

  test("reviewOutcomeSchema rejects an edited outcome missing its touched-field lists", () => {
    // `editedFields`/`rejectedFields` are what name the human's work. An `edited`
    // outcome without them is indistinguishable from `accepted` and must not parse.
    const result = reviewOutcomeSchema.safeParse({ status: "edited", fields: {} });

    expect(result.success).toBe(false);
  });
});

// --- Type-level tests -------------------------------------------------------
//
// Enforced by `tsc` (`pnpm --filter @azx/ribo-core typecheck`), not by the
// Vitest run above — esbuild strips types without checking them. Each
// `@ts-expect-error` is itself the assertion: if the error stops happening, tsc
// fails with "Unused '@ts-expect-error' directive".
//
// Two assertions that USED to live here are gone on purpose, and neither was
// dropped — both became a runtime test above:
//
//   - "an edited value must have the field's type" — `FieldDecision.value` is now
//     `unknown`, because one `Record` cannot carry 34 differently-typed leaves. The
//     check moved to `ReviewField.schema`, applied by `resolveReview`; see
//     "validation at submit".
//   - "a submission must decide every field" — `Record<FieldPath, …>` accepts `{}`,
//     so no type can express it. It moved to `resolveReview`'s completeness check;
//     see "completeness at runtime".

test("the outcome is a discriminated union, not `T | null`", () => {
  // Returned from a function so control-flow analysis cannot narrow the union
  // away at the declaration site — the point is what an unnarrowed outcome is.
  const anyOutcome = (): ReviewOutcome => ({ status: "discarded" });
  const outcome = anyOutcome();

  // @ts-expect-error - `fields` only exists once the union is narrowed; this is
  // exactly what `T | null` could not express. The index itself is the assertion,
  // asked at the type level — `keyof` a union is only its members' common keys, so
  // `fields` fails to index the unnarrowed outcome.
  const unnarrowed: ReviewOutcome["fields"] = { "rValue.value": { value: 1 } };

  expect(unnarrowed).toBeDefined();
  expect(outcome.status).toBe("discarded");
});

test("ReviewOutcome no longer takes a type parameter", () => {
  const outcome: ReviewOutcome = { status: "discarded" };
  expect(outcome.status).toBe("discarded");

  // @ts-expect-error - not generic. `fields` is the reassembled nested object, and
  // `ToolAdapter.schema.parse` at the write step is what turns it into `V`. The
  // instantiation is the whole assertion — if ReviewOutcome ever became generic
  // again, the directive would go unused and tsc would fail this file. It is held
  // in a type alias rather than a value annotation: annotating a value with a
  // failed instantiation marks that value error-typed for the whole file.
  type _WithTypeArgs = ReviewOutcome<{ rValue: number }>;
});

test("an edited decision must actually carry a value", () => {
  const decisions: FieldDecisions = {
    // @ts-expect-error - "edited" without a value is meaningless: it would be
    // indistinguishable from "accepted", which is a different verdict.
    rValue: { status: "edited" },
  };

  expect(decisions.rValue?.status).toBe("edited");
});

test("a leaf is marked required only when its group declares it", () => {
  const plain = buildReviewRequest({}, transcript, atticSchema);
  for (const field of Object.values(plain.fields)) expect(field.required).toBe(false);

  const marked = buildReviewRequest({}, transcript, atticSchema, {
    requiredOnCreate: { rValue: ["rValue"] },
  });
  expect(marked.fields.rValue?.required).toBe(true);
  // Every OTHER leaf stays false — a required declaration must not leak across leaves.
  for (const [path, field] of Object.entries(marked.fields)) {
    if (path !== "rValue") expect(field.required).toBe(false);
  }
});

test("a nested leaf can be required when its group declares it", () => {
  const marked = buildReviewRequest({}, transcript, atticSchema, {
    requiredOnCreate: { healthSafety: ["ambientCo"] },
  });
  expect(marked.fields["healthSafety.ambientCo"]?.required).toBe(true);
  expect(marked.fields.rValue?.required).toBe(false);
});

test("provenance keys are constrained to top-level schema keys at compile time", () => {
  const badOptions = { provenance: { roof: "row" as const } };
  // @ts-expect-error "roof" is not a top-level group of atticSchema
  const _invalid = () => buildReviewRequest({}, transcript, atticSchema, badOptions);
  expect(_invalid).toBeDefined();
});

test("provenance with an unknown group key throws at runtime", () => {
  expect(() =>
    buildReviewRequest({}, transcript, atticSchema, {
      provenance: { roof: "row" } as Record<string, "row" | "leaf" | "none">,
    }),
  ).toThrow('provenance names group "roof", which is not a top-level property');
});

/* R1.6 Task 6 — review enumerates instances from data, leaves from schema.
 *
 * The invariant, restated: the data determines how many instances exist; the schema
 * determines every leaf within each instance. A leaf the model omitted from a present
 * instance still appears with the sentinel envelope, so no leaf of a reviewed instance
 * can silently vanish. Empty collections have no leaves, so they are recorded separately
 * on the group's state in {@link ReviewRequest.tree}.
 */

const hvacElementSchema = z.object({
  hvacSystemEquipmentType: z.string().nullable().optional(),
  hvacHeatingEnergySource: z.string().nullable().optional(),
  hvacUpgradeAction: z.string().nullable().optional(),
});

const dhwElementSchema = z.object({
  dhwType2: z.string().nullable().optional(),
});

const withCollectionsSchema = z.object({
  hvac: z.array(hvacElementSchema).optional(),
  dhw: z.array(dhwElementSchema).optional(),
});

const collectionRequestFor = (
  extracted: Record<string, unknown>,
  existingRecords?: Record<string, readonly ExistingRecord[]>,
  statedEmptyGroups?: Readonly<Record<string, string>>,
  skippedItems?: readonly SkippedItem[],
): ReviewRequest =>
  buildReviewRequest(extracted, transcript, withCollectionsSchema, {
    existingRecords,
    statedEmptyGroups,
    skippedItems,
  });

describe("buildReviewRequest — collections: data counts instances, schema counts leaves", () => {
  test("two HVAC instances produce two full sets of HVAC leaf paths, each addressing a distinct key", () => {
    const request = collectionRequestFor({
      hvac: [
        {
          hvacSystemEquipmentType: { value: "Boiler", confidence: 1, sourceSpan: "boiler" },
          hvacHeatingEnergySource: { value: "Fuel Oil", confidence: 1, sourceSpan: "oil" },
          hvacUpgradeAction: { value: "Keep", confidence: 1, sourceSpan: "keep" },
        },
        {
          hvacSystemEquipmentType: { value: "Furnace", confidence: 1, sourceSpan: "furnace" },
          hvacHeatingEnergySource: { value: "Natural Gas", confidence: 1, sourceSpan: "gas" },
          hvacUpgradeAction: { value: "Replace", confidence: 1, sourceSpan: "replace" },
        },
      ],
    });

    expect(Object.keys(request.fields)).toEqual([
      "hvac[k1].hvacSystemEquipmentType",
      "hvac[k1].hvacHeatingEnergySource",
      "hvac[k1].hvacUpgradeAction",
      "hvac[k2].hvacSystemEquipmentType",
      "hvac[k2].hvacHeatingEnergySource",
      "hvac[k2].hvacUpgradeAction",
    ]);
    expect(request.fields["hvac[k1].hvacSystemEquipmentType"]?.extracted.value).toBe("Boiler");
    expect(request.fields["hvac[k2].hvacSystemEquipmentType"]?.extracted.value).toBe("Furnace");
  });

  test("every leaf of every present instance appears, including leaves the model left null", () => {
    const request = collectionRequestFor({
      hvac: [
        {
          hvacSystemEquipmentType: { value: "Boiler", confidence: 1, sourceSpan: "boiler" },
          // `hvacHeatingEnergySource` and `hvacUpgradeAction` are omitted.
        },
      ],
    });

    expect(Object.keys(request.fields)).toEqual([
      "hvac[k1].hvacSystemEquipmentType",
      "hvac[k1].hvacHeatingEnergySource",
      "hvac[k1].hvacUpgradeAction",
    ]);
    expect(request.fields["hvac[k1].hvacHeatingEnergySource"]?.extracted).toEqual({
      value: null,
      confidence: 0,
      sourceSpan: null,
    });
  });

  test("an empty collection produces no leaf paths and is recorded as present-but-empty", () => {
    const request = collectionRequestFor({
      hvac: [],
      dhw: [{ dhwType2: { value: "Tank Water Heater", confidence: 1, sourceSpan: "tank" } }],
    });

    expect(Object.keys(request.fields)).toEqual(["dhw[k1].dhwType2"]);
    const hvac = groupNamed(request, "hvac");
    expect(hvac?.kind === "collection" && hvac.state).toBe("empty");
  });

  test("a group absent from the extraction output is not recorded as present-but-empty", () => {
    const request = collectionRequestFor({});

    expect(Object.keys(request.fields)).toHaveLength(0);
    for (const node of request.tree) {
      expect(node.kind === "collection" && node.state).toBe("absent");
    }
  });

  test("instance order in the request follows the emitted array order", () => {
    const request = collectionRequestFor({
      hvac: [
        {
          hvacSystemEquipmentType: { value: "First", confidence: 1, sourceSpan: "first" },
          hvacHeatingEnergySource: { value: "Electricity", confidence: 1, sourceSpan: "elec" },
          hvacUpgradeAction: { value: "Keep", confidence: 1, sourceSpan: "keep" },
        },
        {
          hvacSystemEquipmentType: { value: "Second", confidence: 1, sourceSpan: "second" },
          hvacHeatingEnergySource: { value: "Natural Gas", confidence: 1, sourceSpan: "gas" },
          hvacUpgradeAction: { value: "Replace", confidence: 1, sourceSpan: "replace" },
        },
      ],
    });

    const keys = Object.keys(request.fields);
    expect(keys.indexOf("hvac[k1].hvacSystemEquipmentType")).toBeLessThan(
      keys.indexOf("hvac[k2].hvacSystemEquipmentType"),
    );
    expect(request.fields["hvac[k1].hvacSystemEquipmentType"]?.extracted.value).toBe("First");
    expect(request.fields["hvac[k2].hvacSystemEquipmentType"]?.extracted.value).toBe("Second");
  });

  test("requiredOnCreate per group marks every required leaf on every instance of a collection", () => {
    const extracted = {
      hvac: [
        {
          hvacSystemEquipmentType: { value: "Boiler", confidence: 1, sourceSpan: "boiler" },
          hvacHeatingEnergySource: { value: "Fuel Oil", confidence: 1, sourceSpan: "oil" },
          hvacUpgradeAction: { value: "Keep", confidence: 1, sourceSpan: "keep" },
        },
        {
          hvacSystemEquipmentType: { value: "Furnace", confidence: 1, sourceSpan: "furnace" },
          hvacHeatingEnergySource: { value: "Natural Gas", confidence: 1, sourceSpan: "gas" },
          hvacUpgradeAction: { value: "Replace", confidence: 1, sourceSpan: "replace" },
        },
      ],
    };

    const request = buildReviewRequest(extracted, transcript, withCollectionsSchema, {
      requiredOnCreate: { hvac: ["hvacSystemEquipmentType", "hvacUpgradeAction"] },
    });

    expect(request.fields["hvac[k1].hvacSystemEquipmentType"]?.required).toBe(true);
    expect(request.fields["hvac[k1].hvacUpgradeAction"]?.required).toBe(true);
    expect(request.fields["hvac[k2].hvacSystemEquipmentType"]?.required).toBe(true);
    expect(request.fields["hvac[k2].hvacUpgradeAction"]?.required).toBe(true);
    // A non-required leaf in the same group stays false, and a leaf from another group is untouched.
    expect(request.fields["hvac[k1].hvacHeatingEnergySource"]?.required).toBe(false);
  });

  test("requiredOnCreate per group leaves singleton group leaves unmarked unless declared", () => {
    // `withCollectionsSchema` has no singleton groups; `atticSchema` does. Reusing the same
    // per-group logic for a non-collection group proves singletons are unaffected.
    const request = buildReviewRequest({}, transcript, atticSchema, {
      requiredOnCreate: { healthSafety: ["ambientCo"] },
    });

    expect(request.fields["healthSafety.ambientCo"]?.required).toBe(true);
    expect(request.fields.rValue?.required).toBe(false);
    expect(request.fields.notes?.required).toBe(false);
  });
});

describe("buildReviewRequest — statedEmptyGroups: a grounded 'stated empty' group state", () => {
  test("a group with an empty array and a statedEmptyGroups entry gets state statedEmpty with the quote", () => {
    const request = collectionRequestFor(
      { hvac: [], dhw: [{ dhwType2: { value: "Tank", confidence: 1, sourceSpan: "tank" } }] },
      undefined,
      { hvac: "there's no HVAC in this unit" },
    );

    const hvac = groupNamed(request, "hvac");
    expect(hvac?.kind).toBe("collection");
    expect(hvac?.kind === "collection" && hvac.state).toBe("statedEmpty");
    expect(hvac?.kind === "collection" && hvac.emptyQuote).toBe("there's no HVAC in this unit");
  });

  test("the same empty array with no statedEmptyGroups entry stays state empty with null quote", () => {
    const request = collectionRequestFor({ hvac: [] });

    const hvac = groupNamed(request, "hvac");
    expect(hvac?.kind === "collection" && hvac.state).toBe("empty");
    expect(hvac?.kind === "collection" && hvac.emptyQuote).toBeNull();
  });

  test("a group absent from the extraction stays absent even with a statedEmptyGroups entry", () => {
    const request = collectionRequestFor(
      { dhw: [{ dhwType2: { value: "Tank", confidence: 1, sourceSpan: "tank" } }] },
      undefined,
      { hvac: "there's no HVAC" },
    );

    const hvac = groupNamed(request, "hvac");
    expect(hvac?.kind === "collection" && hvac.state).toBe("absent");
    expect(hvac?.kind === "collection" && hvac.emptyQuote).toBeNull();
  });

  test("a malformed present-but-non-array value stays absent even with a statedEmptyGroups entry", () => {
    const request = collectionRequestFor(
      { hvac: null, dhw: [{ dhwType2: { value: "Tank", confidence: 1, sourceSpan: "tank" } }] },
      undefined,
      { hvac: "there's no HVAC" },
    );

    const hvac = groupNamed(request, "hvac");
    expect(hvac?.kind === "collection" && hvac.state).toBe("absent");
    expect(hvac?.kind === "collection" && hvac.emptyQuote).toBeNull();
  });

  test("a populated group is unaffected regardless of statedEmptyGroups", () => {
    const request = collectionRequestFor(
      {
        hvac: [
          {
            hvacSystemEquipmentType: { value: "Boiler", confidence: 1, sourceSpan: "boiler" },
            hvacHeatingEnergySource: { value: "Oil", confidence: 1, sourceSpan: "oil" },
            hvacUpgradeAction: { value: "Keep", confidence: 1, sourceSpan: "keep" },
          },
        ],
      },
      undefined,
      { hvac: "there's no HVAC" },
    );

    const hvac = groupNamed(request, "hvac");
    expect(hvac?.kind === "collection" && hvac.state).toBe("populated");
    expect(hvac?.kind === "collection" && hvac.emptyQuote).toBeNull();
  });
});

describe("buildReviewRequest — skippedItems: the 'we asked and could not get an answer' flag", () => {
  test("a skipped fill item marks its group and the instance it addressed, not the others", () => {
    // One of two HVAC fills gave up: the group flag says "something here may
    // be an abstention", the instance flag says which one — ADR 0026's
    // item-level truth, carried onto the tree.
    const request = collectionRequestFor(
      {
        hvac: [
          {
            hvacSystemEquipmentType: { value: "Boiler", confidence: 1, sourceSpan: "boiler" },
            hvacHeatingEnergySource: { value: "Oil", confidence: 1, sourceSpan: "oil" },
            hvacUpgradeAction: { value: "Keep", confidence: 1, sourceSpan: "keep" },
          },
          {
            hvacSystemEquipmentType: { value: null, confidence: 0, sourceSpan: null },
            hvacHeatingEnergySource: { value: null, confidence: 0, sourceSpan: null },
            hvacUpgradeAction: { value: null, confidence: 0, sourceSpan: null },
          },
        ],
        dhw: [{ dhwType2: { value: "Tank", confidence: 1, sourceSpan: "tank" } }],
      },
      undefined,
      undefined,
      [{ phaseId: "fill", key: "hvac", instance: 2, instances: 2, part: 1, parts: 1 }],
    );

    const hvac = groupNamed(request, "hvac");
    const dhw = groupNamed(request, "dhw");
    expect(hvac?.kind === "collection" && hvac.skipped).toBe(true);
    expect(dhw?.kind === "collection" && dhw.skipped).toBe(false);
    const hvacInstances = hvac?.kind === "collection" ? hvac.instances : [];
    expect(hvacInstances.map((i) => i.skipped)).toEqual([false, true]);
    // The state is untouched by the flag — the group is still populated.
    expect(hvac?.kind === "collection" && hvac.state).toBe("populated");
  });

  test("a skipped group-level item (a span or presence ask) marks the group but no instance", () => {
    const request = collectionRequestFor({ hvac: [], dhw: [] }, undefined, undefined, [
      { phaseId: "span", key: "hvac" },
    ]);

    const hvac = groupNamed(request, "hvac");
    const dhw = groupNamed(request, "dhw");
    expect(hvac?.kind === "collection" && hvac.skipped).toBe(true);
    expect(dhw?.kind === "collection" && dhw.skipped).toBe(false);
    const hvacInstances = hvac?.kind === "collection" ? hvac.instances : [];
    expect(hvacInstances).toHaveLength(0);
  });

  test("no report — every flag false, and the state family keeps its own answers", () => {
    // An absent report renders as no flag anywhere: honest for a run that
    // could not have skipped silently. The absent-vs-[] question lives on the
    // session field, not the tree.
    const request = collectionRequestFor(
      {
        hvac: [
          {
            hvacSystemEquipmentType: { value: "Boiler", confidence: 1, sourceSpan: "boiler" },
            hvacHeatingEnergySource: { value: "Oil", confidence: 1, sourceSpan: "oil" },
            hvacUpgradeAction: { value: "Keep", confidence: 1, sourceSpan: "keep" },
          },
        ],
      },
      undefined,
      undefined,
      undefined,
    );

    const hvac = groupNamed(request, "hvac");
    expect(hvac?.kind === "collection" && hvac.skipped).toBe(false);
    const hvacInstances = hvac?.kind === "collection" ? hvac.instances : [];
    expect(hvacInstances.map((i) => i.skipped)).toEqual([false]);
  });

  test("an empty report is also all-false — reported, nothing skipped", () => {
    const request = collectionRequestFor({ hvac: [] }, undefined, undefined, []);

    const hvac = groupNamed(request, "hvac");
    expect(hvac?.kind === "collection" && hvac.skipped).toBe(false);
  });

  test("a skipped item naming an unknown or flat key marks nothing", () => {
    // The flat fallback and gap-fill phases name key "" — attributable to no
    // group in the schema — and a stale key names no group at all.
    const request = collectionRequestFor({ hvac: [], dhw: [] }, undefined, undefined, [
      { phaseId: "gap-fill", key: "" },
      { phaseId: "fill", key: "ghost", instance: 1 },
    ]);

    for (const node of request.tree) {
      if (node.kind === "leaf" || node.kind === "section") continue;
      expect(node.skipped).toBe(false);
    }
  });
});

describe("resolveReview — a statedEmpty group resolves to an empty array, same as empty", () => {
  test("a statedEmpty group writes an empty array, not 'touch nothing'", () => {
    const request = collectionRequestFor(
      {
        hvac: [],
        dhw: [{ dhwType2: { value: "Tank Water Heater", confidence: 1, sourceSpan: "tank" } }],
      },
      undefined,
      { hvac: "there's no HVAC" },
    );
    const paths = Object.keys(request.fields);

    const outcome = resolveReview(request, {
      status: "submitted",
      decisions: decisionsFor(paths),
    });

    if (outcome.status !== "accepted") throw new Error("unreachable");
    expect(outcome.fields.hvac).toEqual([]);
    expect(outcome.fields.dhw).toEqual([{ dhwType2: "Tank Water Heater" }]);
  });
});

describe("resolveReview — keyed instance paths reassemble into positional arrays", () => {
  test("a keyed path rebuilds as an array, not an object whose key is the literal bracket text", () => {
    const request = collectionRequestFor({
      hvac: [
        {
          hvacSystemEquipmentType: { value: "Boiler", confidence: 1, sourceSpan: "boiler" },
          hvacHeatingEnergySource: { value: "Fuel Oil", confidence: 1, sourceSpan: "oil" },
          hvacUpgradeAction: { value: "Keep", confidence: 1, sourceSpan: "keep" },
        },
      ],
    });
    const paths = Object.keys(request.fields);

    const outcome = resolveReview(request, {
      status: "submitted",
      decisions: decisionsFor(paths),
    });

    if (outcome.status !== "accepted") throw new Error("unreachable");
    expect(outcome.fields.hvac).toEqual([
      {
        hvacSystemEquipmentType: "Boiler",
        hvacHeatingEnergySource: "Fuel Oil",
        hvacUpgradeAction: "Keep",
      },
    ]);
    expect("hvac[k1]" in outcome.fields).toBe(false);
    expect(Array.isArray(outcome.fields.hvac)).toBe(true);
    expect(outcome.linkTargets).toEqual({ hvac: [null] });
    expect(outcome.instanceKeys).toEqual({ hvac: ["k1"] });
  });

  test("an instance whose every leaf was rejected is absent from the patch, not an empty record", () => {
    const request = collectionRequestFor({
      hvac: [
        {
          hvacSystemEquipmentType: { value: "Boiler", confidence: 1, sourceSpan: "boiler" },
          hvacHeatingEnergySource: { value: "Fuel Oil", confidence: 1, sourceSpan: "oil" },
          hvacUpgradeAction: { value: "Keep", confidence: 1, sourceSpan: "keep" },
        },
        {
          hvacSystemEquipmentType: { value: "Furnace", confidence: 1, sourceSpan: "furnace" },
          hvacHeatingEnergySource: { value: "Natural Gas", confidence: 1, sourceSpan: "gas" },
          hvacUpgradeAction: { value: "Replace", confidence: 1, sourceSpan: "replace" },
        },
      ],
    });
    const paths = Object.keys(request.fields);
    const decisions: FieldDecisions = Object.fromEntries(
      paths.map((path): [string, FieldDecision] => {
        if (path.startsWith("hvac[k1].")) {
          return [path, { status: "rejected" as const }];
        }
        return [path, { status: "accepted" as const }];
      }),
    );

    const outcome = resolveReview(request, { status: "submitted", decisions });

    if (outcome.status !== "edited") throw new Error("unreachable");
    expect(outcome.rejectedFields).toHaveLength(3);
    const firstSurvivor = outcome.fields.hvac as Record<string, unknown>[];
    expect(firstSurvivor).toHaveLength(1);
    expect(firstSurvivor[0]).toEqual({
      hvacSystemEquipmentType: "Furnace",
      hvacHeatingEnergySource: "Natural Gas",
      hvacUpgradeAction: "Replace",
    });
  });

  test("instanceKeys and fields stay in lockstep when one instance of several is fully rejected", () => {
    const request = collectionRequestFor({
      hvac: [
        {
          hvacSystemEquipmentType: { value: "Boiler", confidence: 1, sourceSpan: "boiler" },
          hvacHeatingEnergySource: { value: "Fuel Oil", confidence: 1, sourceSpan: "oil" },
          hvacUpgradeAction: { value: "Keep", confidence: 1, sourceSpan: "keep" },
        },
        {
          hvacSystemEquipmentType: { value: "Furnace", confidence: 1, sourceSpan: "furnace" },
          hvacHeatingEnergySource: { value: "Natural Gas", confidence: 1, sourceSpan: "gas" },
          hvacUpgradeAction: { value: "Replace", confidence: 1, sourceSpan: "replace" },
        },
      ],
    });
    const paths = Object.keys(request.fields);
    const decisions: FieldDecisions = Object.fromEntries(
      paths.map((path): [string, FieldDecision] => {
        if (path.startsWith("hvac[k1].")) {
          return [path, { status: "rejected" as const }];
        }
        return [path, { status: "accepted" as const }];
      }),
    );

    const outcome = resolveReview(request, { status: "submitted", decisions });

    if (outcome.status !== "edited") throw new Error("unreachable");
    expect(outcome.instanceKeys).toEqual({ hvac: ["k2"] });
  });

  test("instanceKeys keeps a partially-rejected instance's key and place alongside a fully-accepted one", () => {
    const request = collectionRequestFor({
      hvac: [
        {
          hvacSystemEquipmentType: { value: "Boiler", confidence: 1, sourceSpan: "boiler" },
          hvacHeatingEnergySource: { value: "Fuel Oil", confidence: 1, sourceSpan: "oil" },
          hvacUpgradeAction: { value: "Keep", confidence: 1, sourceSpan: "keep" },
        },
        {
          hvacSystemEquipmentType: { value: "Furnace", confidence: 1, sourceSpan: "furnace" },
          hvacHeatingEnergySource: { value: "Natural Gas", confidence: 1, sourceSpan: "gas" },
          hvacUpgradeAction: { value: "Replace", confidence: 1, sourceSpan: "replace" },
        },
      ],
    });
    const paths = Object.keys(request.fields);
    const decisions: FieldDecisions = Object.fromEntries(
      paths.map((path): [string, FieldDecision] => {
        if (path === "hvac[k1].hvacHeatingEnergySource") {
          return [path, { status: "rejected" as const }];
        }
        return [path, { status: "accepted" as const }];
      }),
    );

    const outcome = resolveReview(request, { status: "submitted", decisions });

    if (outcome.status !== "edited") throw new Error("unreachable");
    expect(outcome.instanceKeys).toEqual({ hvac: ["k1", "k2"] });
  });

  test("a present-but-empty collection resolves to an empty array", () => {
    const request = collectionRequestFor({
      hvac: [],
      dhw: [{ dhwType2: { value: "Tank Water Heater", confidence: 1, sourceSpan: "tank" } }],
    });
    const paths = Object.keys(request.fields);

    const outcome = resolveReview(request, {
      status: "submitted",
      decisions: decisionsFor(paths),
    });

    if (outcome.status !== "accepted") throw new Error("unreachable");
    expect(outcome.fields.hvac).toEqual([]);
    expect(outcome.fields.dhw).toEqual([{ dhwType2: "Tank Water Heater" }]);
    expect(outcome.linkTargets).toEqual({ dhw: [null] });
    expect(outcome.instanceKeys).toEqual({ dhw: ["k1"] });
    expect("hvac" in (outcome.instanceKeys ?? {})).toBe(false);
  });

  test("a group absent from extraction yields no key, distinct from present-but-empty []", () => {
    const request = collectionRequestFor({
      dhw: [{ dhwType2: { value: "Tank Water Heater", confidence: 1, sourceSpan: "tank" } }],
    });

    const hvac = groupNamed(request, "hvac");
    expect(hvac?.kind === "collection" && hvac.state).toBe("absent");

    const paths = Object.keys(request.fields);
    const outcome = resolveReview(request, {
      status: "submitted",
      decisions: decisionsFor(paths),
    });

    if (outcome.status !== "accepted") throw new Error("unreachable");
    expect("hvac" in outcome.fields).toBe(false);
    expect(outcome.fields.dhw).toEqual([{ dhwType2: "Tank Water Heater" }]);
    expect(outcome.linkTargets).toEqual({ dhw: [null] });
  });

  test("removing the first instance does not reattach the remaining decisions to shifted positions", () => {
    const request = collectionRequestFor({
      hvac: [
        {
          hvacSystemEquipmentType: { value: "First", confidence: 1, sourceSpan: "first" },
          hvacHeatingEnergySource: { value: "Electricity", confidence: 1, sourceSpan: "elec1" },
          hvacUpgradeAction: { value: "Keep", confidence: 1, sourceSpan: "keep1" },
        },
        {
          hvacSystemEquipmentType: { value: "Second", confidence: 1, sourceSpan: "second" },
          hvacHeatingEnergySource: { value: "Natural Gas", confidence: 1, sourceSpan: "gas2" },
          hvacUpgradeAction: { value: "Replace", confidence: 1, sourceSpan: "replace2" },
        },
        {
          hvacSystemEquipmentType: { value: "Third", confidence: 1, sourceSpan: "third" },
          hvacHeatingEnergySource: { value: "Fuel Oil", confidence: 1, sourceSpan: "oil3" },
          hvacUpgradeAction: { value: "Remove", confidence: 1, sourceSpan: "remove3" },
        },
      ],
    });
    const paths = Object.keys(request.fields);
    const decisions: FieldDecisions = Object.fromEntries(
      paths.map((path): [string, FieldDecision] => {
        if (path.startsWith("hvac[k1].")) {
          return [path, { status: "rejected" as const }];
        }
        return [path, { status: "accepted" as const }];
      }),
    );

    const outcome = resolveReview(request, { status: "submitted", decisions });

    if (outcome.status !== "edited") throw new Error("unreachable");
    const afterRemoval = outcome.fields.hvac as Record<string, unknown>[];
    expect(afterRemoval).toHaveLength(2);
    // First-mention order among the surviving keys is k2, then k3.
    expect(afterRemoval[0]).toEqual({
      hvacSystemEquipmentType: "Second",
      hvacHeatingEnergySource: "Natural Gas",
      hvacUpgradeAction: "Replace",
    });
    expect(afterRemoval[1]).toEqual({
      hvacSystemEquipmentType: "Third",
      hvacHeatingEnergySource: "Fuel Oil",
      hvacUpgradeAction: "Remove",
    });
    expect(outcome.linkTargets).toEqual({ hvac: [null, null] });
    expect(outcome.instanceKeys).toEqual({ hvac: ["k2", "k3"] });
  });

  test("two instances resolve to array positions in first-mention order", () => {
    const request = collectionRequestFor({
      hvac: [
        {
          hvacSystemEquipmentType: { value: "First", confidence: 1, sourceSpan: "first" },
          hvacHeatingEnergySource: { value: "Electricity", confidence: 1, sourceSpan: "elec" },
          hvacUpgradeAction: { value: "Keep", confidence: 1, sourceSpan: "keep" },
        },
        {
          hvacSystemEquipmentType: { value: "Second", confidence: 1, sourceSpan: "second" },
          hvacHeatingEnergySource: { value: "Natural Gas", confidence: 1, sourceSpan: "gas" },
          hvacUpgradeAction: { value: "Replace", confidence: 1, sourceSpan: "replace" },
        },
      ],
    });
    const paths = Object.keys(request.fields);

    const outcome = resolveReview(request, {
      status: "submitted",
      decisions: decisionsFor(paths),
    });

    if (outcome.status !== "accepted") throw new Error("unreachable");
    const orderedHvac = outcome.fields.hvac as Record<string, unknown>[];
    expect(orderedHvac[0]).toEqual({
      hvacSystemEquipmentType: "First",
      hvacHeatingEnergySource: "Electricity",
      hvacUpgradeAction: "Keep",
    });
    expect(orderedHvac[1]).toEqual({
      hvacSystemEquipmentType: "Second",
      hvacHeatingEnergySource: "Natural Gas",
      hvacUpgradeAction: "Replace",
    });
    expect(outcome.linkTargets).toEqual({ hvac: [null, null] });
    expect(outcome.instanceKeys).toEqual({ hvac: ["k1", "k2"] });
  });

  test("rejecting every leaf of every instance leaves the group key absent", () => {
    const request = collectionRequestFor({
      hvac: [
        {
          hvacSystemEquipmentType: { value: "Boiler", confidence: 1, sourceSpan: "boiler" },
          hvacHeatingEnergySource: { value: "Fuel Oil", confidence: 1, sourceSpan: "oil" },
          hvacUpgradeAction: { value: "Keep", confidence: 1, sourceSpan: "keep" },
        },
      ],
    });

    const outcome = resolveReview(request, {
      status: "submitted",
      decisions: decisionsFor(Object.keys(request.fields), "rejected"),
    });

    if (outcome.status !== "edited") throw new Error("unreachable");
    expect("hvac" in outcome.fields).toBe(false);
    expect(outcome.fields).toEqual({});
  });
});

describe("resolveReview — instance identity: link only when the human decides", () => {
  const oneExistingRecord: readonly ExistingRecord[] = [
    { uuid: "hvac-existing-1", fields: { hvacSystemEquipmentType: "Boiler" } },
  ];

  test("exactly one existing record and a perfect match still creates without a link decision", () => {
    // This is the anti-regression test for the rejected auto-link draft: even when every
    // captured identifying field matches, the absence of a human decision means create.
    const request = collectionRequestFor(
      {
        hvac: [
          {
            hvacSystemEquipmentType: { value: "Boiler", confidence: 1, sourceSpan: "boiler" },
            hvacHeatingEnergySource: { value: "Fuel Oil", confidence: 1, sourceSpan: "oil" },
            hvacUpgradeAction: { value: "Keep", confidence: 1, sourceSpan: "keep" },
          },
        ],
      },
      { hvac: oneExistingRecord },
    );
    const paths = Object.keys(request.fields);
    const outcome = resolveReview(request, {
      status: "submitted",
      decisions: decisionsFor(paths),
    });

    if (outcome.status !== "accepted") throw new Error("unreachable");
    expect(outcome.linkTargets).toEqual({ hvac: [null] });
  });

  test("a link decision survives resolveReview and reaches the patch as an update target", () => {
    const request = collectionRequestFor(
      {
        hvac: [
          {
            hvacSystemEquipmentType: { value: "Boiler", confidence: 1, sourceSpan: "boiler" },
            hvacHeatingEnergySource: { value: "Fuel Oil", confidence: 1, sourceSpan: "oil" },
            hvacUpgradeAction: { value: "Keep", confidence: 1, sourceSpan: "keep" },
          },
        ],
      },
      { hvac: oneExistingRecord },
    );
    const paths = Object.keys(request.fields);
    const outcome = resolveReview(request, {
      status: "submitted",
      decisions: decisionsFor(paths),
      instanceLinks: { "hvac[k1]": { kind: "link", uuid: "hvac-existing-1" } },
    });

    if (outcome.status !== "accepted") throw new Error("unreachable");
    expect(outcome.linkTargets).toEqual({ hvac: ["hvac-existing-1"] });
    expect(outcome.instanceKeys).toEqual({ hvac: ["k1"] });
    expect(outcome.fields.hvac).toEqual([
      {
        hvacSystemEquipmentType: "Boiler",
        hvacHeatingEnergySource: "Fuel Oil",
        hvacUpgradeAction: "Keep",
      },
    ]);
  });

  test("a link decision for an unknown instance path is rejected", () => {
    const request = collectionRequestFor({
      hvac: [
        {
          hvacSystemEquipmentType: { value: "Boiler", confidence: 1, sourceSpan: "boiler" },
          hvacHeatingEnergySource: { value: "Fuel Oil", confidence: 1, sourceSpan: "oil" },
          hvacUpgradeAction: { value: "Keep", confidence: 1, sourceSpan: "keep" },
        },
      ],
    });
    const paths = Object.keys(request.fields);

    expect(() =>
      resolveReview(request, {
        status: "submitted",
        decisions: decisionsFor(paths),
        instanceLinks: { "hvac[k9]": { kind: "link", uuid: "does-not-matter" } },
      }),
    ).toThrow(ReviewValidationError);
  });

  test("rejecting every leaf of a linked instance removes the link target", () => {
    // A link decision on an instance that is removed from the patch must not leave a
    // dangling update target, or the write step would target a record with no fields.
    const request = collectionRequestFor(
      {
        hvac: [
          {
            hvacSystemEquipmentType: { value: "Boiler", confidence: 1, sourceSpan: "boiler" },
            hvacHeatingEnergySource: { value: "Fuel Oil", confidence: 1, sourceSpan: "oil" },
            hvacUpgradeAction: { value: "Keep", confidence: 1, sourceSpan: "keep" },
          },
        ],
      },
      { hvac: oneExistingRecord },
    );
    const paths = Object.keys(request.fields);
    const outcome = resolveReview(request, {
      status: "submitted",
      decisions: decisionsFor(paths, "rejected"),
      instanceLinks: { "hvac[k1]": { kind: "link", uuid: "hvac-existing-1" } },
    });

    if (outcome.status !== "edited") throw new Error("unreachable");
    expect("hvac" in outcome.fields).toBe(false);
    expect(outcome.linkTargets).toBeUndefined();
  });
});

describe("reviewOutcomeSchema — instanceKeys length must match fields", () => {
  test("a mismatch between fields array length and instanceKeys is rejected", () => {
    const mismatched = {
      status: "accepted" as const,
      fields: { hvac: [{}, {}] },
      instanceKeys: { hvac: ["k1"] },
    };
    expect(reviewOutcomeSchema.safeParse(mismatched).success).toBe(false);

    const matching = {
      status: "accepted" as const,
      fields: { hvac: [{}, {}] },
      instanceKeys: { hvac: ["k1", "k2"] },
    };
    expect(reviewOutcomeSchema.safeParse(matching).success).toBe(true);
  });
});

// --- Type-level tests continue below ---------------------------------------

test("the Extractor seam has no structural parameter for existing records", () => {
  // Existing records enter at review, never at extraction. The public Extractor<F> contract
  // takes the annotated transcript and an options bag carrying cross-cutting run controls —
  // nothing field-shaped. A caller can still smuggle records in a closure, but they cannot do
  // it by changing the signature. The residual is honest: a closure can capture anything.
  //
  // Both directions matter. Dropping the second is how this guard would quietly stop guarding:
  // `[AnnotatedTranscript, ExtractOptions?] extends Params` alone still holds if `extract`
  // grows a third parameter, which is exactly the leak being watched for.
  type Params = Parameters<Extractor<unknown>["extract"]>;
  type ExactlyTranscriptAndOptions = [
    AnnotatedTranscript,
    (ExtractOptions | undefined)?,
  ] extends Params
    ? Params extends [AnnotatedTranscript, (ExtractOptions | undefined)?]
      ? true
      : false
    : false;
  const _assert: ExactlyTranscriptAndOptions = true;
  void _assert;
});

/* The review tree — the structure the schema walk already had.
 *
 * `fields` is flat, with the group/instance structure encoded in the path text, so every
 * host rebuilt it with `parseFieldPath`. The tree returns what `collectFields` saw. Group
 * state folds in `presentButEmpty`: absent, empty and populated are three states a host
 * previously derived by cross-referencing two collections, which is a bug each host got
 * to write independently.
 */

const treeSchema = z.object({
  rValue: z.number().nullable().optional(),
  healthSafety: z
    .object({
      ambientCo: z.enum(["passed", "failed"]).nullable().optional(),
      gasLeak: z.enum(["passed", "failed"]).nullable().optional(),
    })
    .optional(),
  hvac: z.array(hvacElementSchema).optional(),
});

const treeRequestFor = (extracted: Record<string, unknown>): ReviewRequest =>
  buildReviewRequest(extracted, transcript, treeSchema);

/** Every leaf path the tree reaches, in the order the tree presents them. */
const treeLeafPaths = (nodes: readonly ReviewNode[]): string[] =>
  nodes.flatMap((node) => {
    if (node.kind === "leaf") return [node.path];
    if (node.kind === "object") return treeLeafPaths(node.children);
    if (node.kind === "section") return treeLeafPaths(node.children);
    return node.instances.flatMap((instance) => treeLeafPaths(instance.children));
  });

/** Every section node among `nodes`, in the order the tree presents them. */
const sectionsOf = (nodes: readonly ReviewNode[]): readonly ReviewSectionNode[] =>
  nodes.filter((node): node is ReviewSectionNode => node.kind === "section");

const groupNamed = (request: ReviewRequest, key: string): ReviewNode | undefined =>
  request.tree.find((node) => node.kind !== "section" && node.key === key);

describe("buildReviewRequest — the tree carries the shape the walk already knew", () => {
  test("a collection absent from the extraction reports state absent", () => {
    const group = groupNamed(treeRequestFor({}), "hvac");

    expect(group?.kind).toBe("collection");
    expect(group?.kind === "collection" && group.state).toBe("absent");
    expect(group?.kind === "collection" && group.instances).toEqual([]);
  });

  test("a collection present as an empty array reports state empty", () => {
    const group = groupNamed(treeRequestFor({ hvac: [] }), "hvac");

    expect(group?.kind === "collection" && group.state).toBe("empty");
    expect(group?.kind === "collection" && group.instances).toEqual([]);
  });

  test("a populated collection reports its instances, keyed and ordered as the array was", () => {
    const request = treeRequestFor({
      hvac: [
        { hvacSystemEquipmentType: { value: "First", confidence: 1, sourceSpan: "first" } },
        { hvacSystemEquipmentType: { value: "Second", confidence: 1, sourceSpan: "second" } },
      ],
    });
    const group = groupNamed(request, "hvac");

    expect(group?.kind === "collection" && group.state).toBe("populated");
    expect(group?.kind === "collection" && group.instances.map((i) => i.key)).toEqual(["k1", "k2"]);
    expect(group?.kind === "collection" && group.instances.map((i) => i.path)).toEqual([
      "hvac[k1]",
      "hvac[k2]",
    ]);
  });

  test("the tree's leaves are exactly the flat map's keys — one source, two views", () => {
    const request = treeRequestFor({
      rValue: { value: 30, confidence: 1, sourceSpan: "R30" },
      hvac: [{ hvacSystemEquipmentType: { value: "Boiler", confidence: 1, sourceSpan: "boiler" } }],
    });

    expect(new Set(treeLeafPaths(request.tree))).toEqual(new Set(Object.keys(request.fields)));
  });

  test("the tree presents leaves in the same order as the flat map, nested group in place", () => {
    const request = treeRequestFor({
      rValue: { value: 30, confidence: 1, sourceSpan: "R30" },
      hvac: [{ hvacSystemEquipmentType: { value: "Boiler", confidence: 1, sourceSpan: "boiler" } }],
    });

    expect(treeLeafPaths(request.tree)).toEqual(Object.keys(request.fields));
  });

  test("a leaf node carries the same ReviewField object the flat map does, not a copy", () => {
    const request = treeRequestFor({ rValue: { value: 30, confidence: 1, sourceSpan: "R30" } });
    const node = groupNamed(request, "rValue");

    expect(node?.kind).toBe("leaf");
    expect(node?.kind === "leaf" && node.field).toBe(request.fields["rValue"]);
  });

  test("a nested object group exposes its leaves as children rather than as dotted paths", () => {
    const request = treeRequestFor({
      healthSafety: { ambientCo: { value: "passed", confidence: 1, sourceSpan: "co" } },
    });
    const group = groupNamed(request, "healthSafety");

    expect(group?.kind).toBe("object");
    expect(group?.kind === "object" && treeLeafPaths(group.children)).toEqual([
      "healthSafety.ambientCo",
      "healthSafety.gasLeak",
    ]);
  });

  test("presentButEmpty is gone — the state it encoded lives on the group", () => {
    expect("presentButEmpty" in treeRequestFor({ hvac: [] })).toBe(false);
  });

  test("a skipped item naming a singleton (object) group marks that node, not its neighbours", () => {
    const request = buildReviewRequest(
      { healthSafety: { ambientCo: { value: "passed", confidence: 1, sourceSpan: "co" } } },
      transcript,
      treeSchema,
      { skippedItems: [{ phaseId: "fill", key: "healthSafety", instance: 1, instances: 1 }] },
    );

    const group = groupNamed(request, "healthSafety");
    expect(group?.kind === "object" && group.skipped).toBe(true);
    const hvac = groupNamed(request, "hvac");
    expect(hvac?.kind === "collection" && hvac.skipped).toBe(false);
  });

  test("a skipped item names a top-level group only — a nested collection sharing its key is not marked", () => {
    const nestedSchema = z.object({
      hvac: z.array(hvacElementSchema).optional(),
      attic: z.object({ hvac: z.array(hvacElementSchema).optional() }).optional(),
    });
    const system = {
      hvacSystemEquipmentType: { value: "Boiler", confidence: 1, sourceSpan: "boiler" },
    };
    const request = buildReviewRequest(
      { hvac: [system], attic: { hvac: [system] } },
      transcript,
      nestedSchema,
      { skippedItems: [{ phaseId: "fill", key: "hvac", instance: 1, instances: 1 }] },
    );

    const attic = groupNamed(request, "attic");
    const nested =
      attic?.kind === "object"
        ? attic.children.find((n) => n.kind !== "section" && n.key === "hvac")
        : undefined;
    expect(nested?.kind).toBe("collection");
    expect(nested?.kind === "collection" && nested.skipped).toBe(false);
    expect(nested?.kind === "collection" && nested.instances.map((i) => i.skipped)).toEqual([
      false,
    ]);
    const top = groupNamed(request, "hvac");
    expect(top?.kind === "collection" && top.instances.map((i) => i.skipped)).toEqual([true]);
  });
});

/* The review tree laid out by a plan — `BuildReviewRequestOptions.reviewPlan`.
 *
 * A plan is plain data: the `mapping` and `partitions` off a `DerivedExtractionShape`.
 * The primary fixture derives one with the real derivation — a partition of `hvac`
 * into "cooling" and "heating" — so the pins read against the plan data a host
 * actually holds; the stale and order-rule fixtures hand-write records, which is
 * what a stale plan IS: plan data whose schema is not the walked one.
 */

const hvacInstance = (equipmentType: string, energySource: string, upgradeAction: string) => ({
  hvacSystemEquipmentType: { value: equipmentType, confidence: 1, sourceSpan: equipmentType },
  hvacHeatingEnergySource: { value: energySource, confidence: 1, sourceSpan: energySource },
  hvacUpgradeAction: { value: upgradeAction, confidence: 1, sourceSpan: upgradeAction },
});

const hvacPartitionPlan = deriveExtractionShape(treeSchema, {
  operations: [
    {
      op: "partition",
      group: "hvac",
      parts: { cooling: ["hvacSystemEquipmentType"], heating: ["hvacHeatingEnergySource"] },
    },
  ],
});

const plannedRequestFor = (
  extracted: Record<string, unknown>,
  reviewPlan: ReviewPlan,
): ReviewRequest => buildReviewRequest(extracted, transcript, treeSchema, { reviewPlan });

const firstInstanceOf = (request: ReviewRequest, key: string) => {
  const group = groupNamed(request, key);
  if (group?.kind !== "collection") throw new Error(`no collection group "${key}" in the tree`);
  const instance = group.instances[0];
  if (instance === undefined) throw new Error(`no instances in collection "${key}"`);
  return instance;
};

describe("buildReviewRequest — a reviewPlan lays the tree out by its partitions", () => {
  test("a partitioned collection's instance presents one labelled section per part, 'Other' last", () => {
    const request = plannedRequestFor(
      { hvac: [hvacInstance("Boiler", "Gas", "Keep")] },
      hvacPartitionPlan,
    );
    const sections = sectionsOf(firstInstanceOf(request, "hvac").children);

    expect(sections.map((section) => section.label)).toEqual(["cooling", "heating", "Other"]);
    expect(sections.map((section) => treeLeafPaths(section.children))).toEqual([
      ["hvac[k1].hvacSystemEquipmentType"],
      ["hvac[k1].hvacHeatingEnergySource"],
      ["hvac[k1].hvacUpgradeAction"],
    ]);
  });

  test("fields within a section follow that part's field-list order, not schema order", () => {
    // The part lists the equipment type second; the schema declares it first.
    // Plan order wins inside the section — the whole point of the option — and
    // the leaf no part names falls to "Other", last.
    const plan: ReviewPlan = {
      ...hvacPartitionPlan,
      partitions: { hvac: { heating: ["hvacHeatingEnergySource", "hvacSystemEquipmentType"] } },
    };
    const request = plannedRequestFor({ hvac: [hvacInstance("Boiler", "Gas", "Keep")] }, plan);

    expect(treeLeafPaths(firstInstanceOf(request, "hvac").children)).toEqual([
      "hvac[k1].hvacHeatingEnergySource",
      "hvac[k1].hvacSystemEquipmentType",
      "hvac[k1].hvacUpgradeAction",
    ]);
  });

  test("every instance of a collection gets the same sections, each holding its own leaves", () => {
    const request = plannedRequestFor(
      {
        hvac: [hvacInstance("Boiler", "Gas", "Keep"), hvacInstance("Furnace", "Oil", "Replace")],
      },
      hvacPartitionPlan,
    );
    const hvac = groupNamed(request, "hvac");
    const instances = hvac?.kind === "collection" ? hvac.instances : [];

    expect(instances.map((i) => sectionsOf(i.children).map((s) => s.label))).toEqual([
      ["cooling", "heating", "Other"],
      ["cooling", "heating", "Other"],
    ]);
    expect(instances.map((i) => treeLeafPaths(i.children))).toEqual([
      [
        "hvac[k1].hvacSystemEquipmentType",
        "hvac[k1].hvacHeatingEnergySource",
        "hvac[k1].hvacUpgradeAction",
      ],
      [
        "hvac[k2].hvacSystemEquipmentType",
        "hvac[k2].hvacHeatingEnergySource",
        "hvac[k2].hvacUpgradeAction",
      ],
    ]);
  });

  test("a partition on a singleton object group sections the group's own children", () => {
    const singletonSchema = z.object({
      attic: z.object({
        rValue: z.number().nullable().optional(),
        notes: z.string().nullable().optional(),
      }),
    });
    const plan = deriveExtractionShape(singletonSchema, {
      operations: [{ op: "partition", group: "attic", parts: { measured: ["rValue"] } }],
    });
    const request = buildReviewRequest(
      {
        attic: {
          rValue: { value: 19, confidence: 1, sourceSpan: "R-19" },
          notes: { value: "tight", confidence: 1, sourceSpan: "tight" },
        },
      },
      transcript,
      singletonSchema,
      { reviewPlan: plan },
    );

    const attic = groupNamed(request, "attic");
    expect(attic?.kind).toBe("object");
    const sections = attic?.kind === "object" ? sectionsOf(attic.children) : [];
    expect(sections.map((s) => s.label)).toEqual(["measured", "Other"]);
    expect(sections.map((s) => treeLeafPaths(s.children))).toEqual([
      ["attic.rValue"],
      ["attic.notes"],
    ]);
  });

  test("a retype is a no-op: the layout is identical with and without one", () => {
    // The closed set retypes a string patch leaf to a number; the layout never
    // reads it — the reviewer edits the real value through the patch schema's
    // type, so a retyped leaf keeps its patch path and its position rules.
    const withRetype = deriveExtractionShape(treeSchema, {
      operations: [
        { op: "retype", path: "hvac.hvacUpgradeAction", to: "number" },
        {
          op: "partition",
          group: "hvac",
          parts: { cooling: ["hvacSystemEquipmentType"], heating: ["hvacHeatingEnergySource"] },
        },
      ],
    });
    const extracted = { hvac: [hvacInstance("Boiler", "Gas", "Keep")] };

    expect(plannedRequestFor(extracted, withRetype).tree).toEqual(
      plannedRequestFor(extracted, hvacPartitionPlan).tree,
    );
  });

  test("a leaf the plan leaves without a mapping entry collects in 'Other' after the remainder's entries", () => {
    // The mapping is empty, so every leaf is unmapped: the cooling part can
    // place nothing and renders none; the remainder's entries lead "Other" in
    // the remainder list's order, the unplaced leaf follows in schema-declaration
    // order — the only order left for a leaf no plan entry speaks about.
    const plan: ReviewPlan = {
      mapping: { leaves: {}, provenance: {} },
      partitions: {
        hvac: {
          cooling: ["hvacSystemEquipmentType"],
          remainder: ["hvacHeatingEnergySource", "hvacUpgradeAction"],
        },
      },
    };
    const request = plannedRequestFor({ hvac: [hvacInstance("Boiler", "Gas", "Keep")] }, plan);
    const sections = sectionsOf(firstInstanceOf(request, "hvac").children);

    expect(sections).toHaveLength(1);
    expect(sections[0]!.label).toBe("Other");
    expect(treeLeafPaths(sections[0]!.children)).toEqual([
      "hvac[k1].hvacHeatingEnergySource",
      "hvac[k1].hvacUpgradeAction",
      "hvac[k1].hvacSystemEquipmentType",
    ]);
  });

  test("a non-leaf child of a partitioned group is placed in 'Other' as a whole subtree", () => {
    const nestedSchema = z.object({
      hvac: z
        .array(
          z.object({
            hvacSystemEquipmentType: z.string().nullable().optional(),
            system: z.object({ fuel: z.string().nullable().optional() }).optional(),
          }),
        )
        .optional(),
    });
    const plan = deriveExtractionShape(nestedSchema, {
      operations: [
        { op: "partition", group: "hvac", parts: { cooling: ["hvacSystemEquipmentType"] } },
      ],
    });
    const request = buildReviewRequest(
      {
        hvac: [
          {
            hvacSystemEquipmentType: { value: "Boiler", confidence: 1, sourceSpan: "boiler" },
            system: { fuel: { value: "Gas", confidence: 1, sourceSpan: "gas" } },
          },
        ],
      },
      transcript,
      nestedSchema,
      { reviewPlan: plan },
    );

    const sections = sectionsOf(firstInstanceOf(request, "hvac").children);
    expect(sections.map((s) => s.label)).toEqual(["cooling", "Other"]);
    const other = sections[1]!;
    // The subtree is the walk's own object node — patch structure intact.
    expect(other.children.map((child) => child.kind)).toEqual(["object"]);
    expect(other.children.map((child) => treeLeafPaths([child]))).toEqual([
      ["hvac[k1].system.fuel"],
    ]);
  });

  test("an 'Other' section is omitted when nothing falls to it", () => {
    const plan: ReviewPlan = {
      ...hvacPartitionPlan,
      partitions: {
        hvac: {
          cooling: ["hvacSystemEquipmentType"],
          heating: ["hvacHeatingEnergySource", "hvacUpgradeAction"],
        },
      },
    };
    const request = plannedRequestFor({ hvac: [hvacInstance("Boiler", "Gas", "Keep")] }, plan);

    expect(sectionsOf(firstInstanceOf(request, "hvac").children).map((s) => s.label)).toEqual([
      "cooling",
      "heating",
    ]);
  });

  test("a part whose fields are all absent from the walked schema renders nothing", () => {
    // "ghost" names no field of the walked group: the entry is ignored and the
    // cooling section renders none. The mapped-but-unlisted leaves sweep into
    // "Other" after the remainder's entry, in schema-declaration order.
    const plan: ReviewPlan = {
      ...hvacPartitionPlan,
      partitions: { hvac: { cooling: ["ghost"], remainder: ["hvacUpgradeAction"] } },
    };
    const request = plannedRequestFor({ hvac: [hvacInstance("Boiler", "Gas", "Keep")] }, plan);
    const sections = sectionsOf(firstInstanceOf(request, "hvac").children);

    expect(sections).toHaveLength(1);
    expect(sections[0]!.label).toBe("Other");
    expect(treeLeafPaths(sections[0]!.children)).toEqual([
      "hvac[k1].hvacUpgradeAction",
      "hvac[k1].hvacSystemEquipmentType",
      "hvac[k1].hvacHeatingEnergySource",
    ]);
  });

  test("an integer-like partition label enumerates first, ascending — the record's enumeration order", () => {
    // Specified ECMAScript property order hoists integer-like keys ahead of the
    // record's insertion order; the layout reads that order as the section order
    // rather than repairing it.
    const plan: ReviewPlan = {
      ...hvacPartitionPlan,
      partitions: {
        hvac: {
          cooling: ["hvacSystemEquipmentType"],
          "7": ["hvacUpgradeAction"],
          heating: ["hvacHeatingEnergySource"],
        },
      },
    };
    const request = plannedRequestFor({ hvac: [hvacInstance("Boiler", "Gas", "Keep")] }, plan);

    expect(sectionsOf(firstInstanceOf(request, "hvac").children).map((s) => s.label)).toEqual([
      "7",
      "cooling",
      "heating",
    ]);
  });

  test("a stale plan entry naming an unknown group is ignored, the rest of the plan still applying", () => {
    const plan: ReviewPlan = {
      ...hvacPartitionPlan,
      partitions: { ...hvacPartitionPlan.partitions, dhw: { everywhere: ["dhwType2"] } },
    };
    const request = plannedRequestFor({ hvac: [hvacInstance("Boiler", "Gas", "Keep")] }, plan);

    expect(sectionsOf(firstInstanceOf(request, "hvac").children).map((s) => s.label)).toEqual([
      "cooling",
      "heating",
      "Other",
    ]);
    const leafPaths = treeLeafPaths(request.tree);
    expect(new Set(leafPaths)).toEqual(new Set(Object.keys(request.fields)));
    expect(new Set(leafPaths).size).toBe(leafPaths.length);
  });

  test("a plan naming only unknown groups degrades to today's layout", () => {
    const plan: ReviewPlan = {
      mapping: { leaves: {}, provenance: {} },
      partitions: { dhw: { everywhere: ["dhwType2"] } },
    };
    const extracted = { rValue: { value: 30, confidence: 1, sourceSpan: "R30" } };

    expect(plannedRequestFor(extracted, plan).tree).toEqual(treeRequestFor(extracted).tree);
  });

  test("a stale plan entry naming an unknown field is ignored, every leaf still appearing exactly once", () => {
    const plan: ReviewPlan = {
      ...hvacPartitionPlan,
      partitions: {
        hvac: {
          cooling: ["hvacSystemEquipmentType", "ghost"],
          heating: ["hvacHeatingEnergySource"],
          remainder: ["hvacUpgradeAction"],
        },
      },
    };
    const request = plannedRequestFor({ hvac: [hvacInstance("Boiler", "Gas", "Keep")] }, plan);

    expect(
      sectionsOf(firstInstanceOf(request, "hvac").children).map((s) => treeLeafPaths(s.children)),
    ).toEqual([
      ["hvac[k1].hvacSystemEquipmentType"],
      ["hvac[k1].hvacHeatingEnergySource"],
      ["hvac[k1].hvacUpgradeAction"],
    ]);
    const leafPaths = treeLeafPaths(request.tree);
    expect(new Set(leafPaths)).toEqual(new Set(Object.keys(request.fields)));
    expect(new Set(leafPaths).size).toBe(leafPaths.length);
  });

  test("a leaf inside a section is the same object fields holds, at its unchanged patch path", () => {
    const request = plannedRequestFor(
      { hvac: [hvacInstance("Boiler", "Gas", "Keep")] },
      hvacPartitionPlan,
    );
    const sections = sectionsOf(firstInstanceOf(request, "hvac").children);
    expect(sections.map((s) => s.label)).toEqual(["cooling", "heating", "Other"]);
    const node = sections[0]!.children[0]!;

    expect(node.kind).toBe("leaf");
    expect(node.kind === "leaf" && node.path).toBe("hvac[k1].hvacSystemEquipmentType");
    expect(node.kind === "leaf" && node.field).toBe(
      request.fields["hvac[k1].hvacSystemEquipmentType"],
    );
  });

  test("with a plan, everything but the tree is identical to the no-plan request", () => {
    const extracted = {
      rValue: { value: 30, confidence: 1, sourceSpan: "R30" },
      hvac: [hvacInstance("Boiler", "Gas", "Keep")],
    };
    const withoutPlan = treeRequestFor(extracted);
    const withPlan = plannedRequestFor(extracted, hvacPartitionPlan);

    expect(withPlan.transcript).toBe(withoutPlan.transcript);
    expect(withPlan.existingRecords).toEqual(withoutPlan.existingRecords);
    expect(Object.keys(withPlan.fields)).toEqual(Object.keys(withoutPlan.fields));
    for (const path of Object.keys(withoutPlan.fields)) {
      expect(leaf(withPlan, path)).toEqual(leaf(withoutPlan, path));
    }
  });

  test("resolveReview over a laid-out request classifies identically to the no-plan request", () => {
    const extracted = {
      rValue: { value: 30, confidence: 1, sourceSpan: "R30" },
      hvac: [hvacInstance("Boiler", "Gas", "Keep")],
    };
    const withoutPlan = treeRequestFor(extracted);
    const withPlan = plannedRequestFor(extracted, hvacPartitionPlan);
    const submission = {
      status: "submitted" as const,
      decisions: {
        ...decisionsFor(Object.keys(withoutPlan.fields)),
        rValue: { status: "edited" as const, value: 31 },
        "hvac[k1].hvacUpgradeAction": { status: "rejected" as const },
      },
    };

    expect(resolveReview(withPlan, submission)).toEqual(resolveReview(withoutPlan, submission));
  });

  test("a collection nested under a partitioned group survives in 'Other' and still writes an empty array on resolve", () => {
    const withVentsSchema = z.object({
      hvac: z
        .array(
          z.object({
            hvacSystemEquipmentType: z.string().nullable().optional(),
            vents: z.array(z.object({ size: z.string().nullable().optional() })).optional(),
          }),
        )
        .optional(),
    });
    const plan = deriveExtractionShape(withVentsSchema, {
      operations: [
        { op: "partition", group: "hvac", parts: { cooling: ["hvacSystemEquipmentType"] } },
      ],
    });
    const extracted = {
      hvac: [
        {
          hvacSystemEquipmentType: { value: "Boiler", confidence: 1, sourceSpan: "boiler" },
          vents: [],
        },
      ],
    };
    const withoutPlan = buildReviewRequest(extracted, transcript, withVentsSchema);
    const withPlan = buildReviewRequest(extracted, transcript, withVentsSchema, {
      reviewPlan: plan,
    });

    const sections = sectionsOf(firstInstanceOf(withPlan, "hvac").children);
    expect(sections.map((s) => s.label)).toEqual(["cooling", "Other"]);
    const other = sections[1]!;
    expect(other.children.map((child) => child.kind)).toEqual(["collection"]);
    const ventsNoPlan = firstInstanceOf(withoutPlan, "hvac").children.find(
      (n) => n.kind !== "section" && n.key === "vents",
    );
    expect(other.children[0]).toEqual(ventsNoPlan);

    const submission = {
      status: "submitted" as const,
      decisions: decisionsFor(Object.keys(withoutPlan.fields)),
    };
    const noPlanOutcome = resolveReview(withoutPlan, submission);
    // The nested empty write fires on the plain tree — `emptyCollectionPaths` recurses
    // through an instance's children, and `resolveReview` records the collection at its
    // own path — and the laid-out tree matches it exactly, which is what pins the walk's
    // descent through "Other".
    if (noPlanOutcome.status !== "accepted") throw new Error("unreachable");
    expect(noPlanOutcome.fields).toEqual({
      hvac: [{ hvacSystemEquipmentType: "Boiler" }],
      "hvac[k1].vents": [],
    });
    expect(resolveReview(withPlan, submission)).toEqual(noPlanOutcome);
  });

  test("building the same request twice with the same plan lays out identically", () => {
    const extracted = { hvac: [hvacInstance("Boiler", "Gas", "Keep")] };

    expect(plannedRequestFor(extracted, hvacPartitionPlan).tree).toEqual(
      plannedRequestFor(extracted, hvacPartitionPlan).tree,
    );
  });

  test("a whole DerivedExtractionShape is accepted where the plan is expected", () => {
    // The whole shape, not a narrowed pick — the schemas and declarations ride
    // along structurally. And the layout reads ONLY the plan's two records:
    // built from the whole shape or from a pick of just `mapping` and
    // `partitions`, the laid-out tree is the same tree, so nothing else about
    // the shape reaches the layout.
    const wholeShape: ReviewPlan = hvacPartitionPlan;
    const narrowedPick: ReviewPlan = {
      mapping: hvacPartitionPlan.mapping,
      partitions: hvacPartitionPlan.partitions,
    };
    const extracted = { hvac: [hvacInstance("Boiler", "Gas", "Keep")] };

    expect(wholeShape.partitions.hvac).toBeDefined();
    expect(plannedRequestFor(extracted, wholeShape).tree).toEqual(
      plannedRequestFor(extracted, narrowedPick).tree,
    );
  });

  test("two parts naming one leaf place it exactly once, in the first part in enumeration order", () => {
    // No derivation produces overlapping parts; a stale or hand-built plan can
    // carry them. The degrade is exactly-once: the first part in enumeration
    // order holds the leaf, the second's entry places nothing, and nothing is
    // duplicated or dropped.
    const plan: ReviewPlan = {
      ...hvacPartitionPlan,
      partitions: {
        hvac: {
          cooling: ["hvacSystemEquipmentType"],
          heating: ["hvacSystemEquipmentType", "hvacHeatingEnergySource"],
        },
      },
    };
    const request = plannedRequestFor({ hvac: [hvacInstance("Boiler", "Gas", "Keep")] }, plan);
    const sections = sectionsOf(firstInstanceOf(request, "hvac").children);

    expect(sections.map((s) => treeLeafPaths(s.children))).toEqual([
      ["hvac[k1].hvacSystemEquipmentType"],
      ["hvac[k1].hvacHeatingEnergySource"],
      ["hvac[k1].hvacUpgradeAction"],
    ]);
    const leafPaths = treeLeafPaths(request.tree);
    expect(new Set(leafPaths)).toEqual(new Set(Object.keys(request.fields)));
    expect(new Set(leafPaths).size).toBe(leafPaths.length);
  });

  test("a part naming a non-leaf child places nothing — the subtree falls to 'Other'", () => {
    // A partition's parts name direct leaves only, so this is plan data no
    // derivation can produce — a stale or foreign plan's shape. The mapping's
    // second source names the non-leaf child itself, isolating the layout's
    // leaf-kind rule from the mapping-membership one: without it, the object
    // child would pass every other guard and be placed into the section. The
    // degrade: the cooling section renders nothing and is omitted, and the
    // named object child sweeps into "Other" as a whole subtree, patch
    // structure intact.
    const nestedSchema = z.object({
      hvac: z
        .array(
          z.object({
            hvacSystemEquipmentType: z.string().nullable().optional(),
            system: z.object({ fuel: z.string().nullable().optional() }).optional(),
          }),
        )
        .optional(),
    });
    const plan: ReviewPlan = {
      mapping: {
        leaves: {
          "hvac.hvacSystemEquipmentType": { source: "hvac.hvacSystemEquipmentType" },
          "hvac.system": { source: "hvac.system" },
        },
        provenance: {},
      },
      partitions: { hvac: { cooling: ["system"] } },
    };
    const request = buildReviewRequest(
      {
        hvac: [
          {
            hvacSystemEquipmentType: { value: "Boiler", confidence: 1, sourceSpan: "boiler" },
            system: { fuel: { value: "Gas", confidence: 1, sourceSpan: "gas" } },
          },
        ],
      },
      transcript,
      nestedSchema,
      { reviewPlan: plan },
    );

    const sections = sectionsOf(firstInstanceOf(request, "hvac").children);
    expect(sections.map((s) => s.label)).toEqual(["Other"]);
    expect(sections[0]!.children.map((child) => child.kind)).toEqual(["leaf", "object"]);
    expect(sections[0]!.children.map((child) => treeLeafPaths([child]))).toEqual([
      ["hvac[k1].hvacSystemEquipmentType"],
      ["hvac[k1].system.fuel"],
    ]);
  });

  test("a partitioned collection with no instances survives verbatim, its empty write intact", () => {
    // No instances, so no sections — and the collection node the layout spreads
    // must be indistinguishable from the walk's: state, emptyQuote, skip flag.
    // The resolve over it still records "there are none of these".
    const extracted = { hvac: [] };
    const statedEmpty = { hvac: "there's no HVAC in this unit" };
    const withoutPlan = buildReviewRequest(extracted, transcript, treeSchema, {
      statedEmptyGroups: statedEmpty,
    });
    const withPlan = buildReviewRequest(extracted, transcript, treeSchema, {
      reviewPlan: hvacPartitionPlan,
      statedEmptyGroups: statedEmpty,
    });

    expect(groupNamed(withPlan, "hvac")).toEqual(groupNamed(withoutPlan, "hvac"));
    const submission = {
      status: "submitted" as const,
      decisions: decisionsFor(Object.keys(withPlan.fields)),
    };
    const noPlanOutcome = resolveReview(withoutPlan, submission);
    // The empty write fires over the laid-out tree — the walk's collection node
    // survived the layout's spread — and the outcome matches the plain walk's exactly.
    if (noPlanOutcome.status !== "accepted") throw new Error("unreachable");
    expect(noPlanOutcome.fields).toEqual({
      rValue: null,
      healthSafety: { ambientCo: null, gasLeak: null },
      hvac: [],
    });
    expect(resolveReview(withPlan, submission)).toEqual(noPlanOutcome);
  });

  test("groups the plan does not partition pass through untouched among sectioned ones", () => {
    const extracted = {
      rValue: { value: 30, confidence: 1, sourceSpan: "R30" },
      healthSafety: { ambientCo: { value: "passed", confidence: 1, sourceSpan: "co" } },
      hvac: [hvacInstance("Boiler", "Gas", "Keep")],
    };
    const withoutPlan = treeRequestFor(extracted);
    const withPlan = plannedRequestFor(extracted, hvacPartitionPlan);

    expect(groupNamed(withPlan, "rValue")).toEqual(groupNamed(withoutPlan, "rValue"));
    expect(groupNamed(withPlan, "healthSafety")).toEqual(groupNamed(withoutPlan, "healthSafety"));
  });

  test("a partition naming a nested group is ignored — only top-level groups are examined", () => {
    // `system` exists in the walked schema but under `attic`, not at the top
    // level, and a partition names a top-level group: the entry is stale, and
    // nothing recurses into the nested group's children.
    const nestedSchema = z.object({
      attic: z.object({
        system: z.object({ fuel: z.string().nullable().optional() }).optional(),
      }),
    });
    const plan: ReviewPlan = {
      mapping: { leaves: { "attic.system.fuel": { source: "attic.system.fuel" } }, provenance: {} },
      partitions: { system: { fuel: ["fuel"] } },
    };
    const extracted = {
      attic: { system: { fuel: { value: "Gas", confidence: 1, sourceSpan: "gas" } } },
    };
    const withoutPlan = buildReviewRequest(extracted, transcript, nestedSchema);
    const withPlan = buildReviewRequest(extracted, transcript, nestedSchema, {
      reviewPlan: plan,
    });

    expect(withPlan.tree).toEqual(withoutPlan.tree);
  });

  test("a partitioned collection's skip flags and state survive the layout", () => {
    // The layout re-parents instances' children and spreads the collection
    // node; everything it does not own — state, emptyQuote, the group's and
    // each instance's skip flag — must come through the spread untouched.
    const extracted = { hvac: [hvacInstance("Boiler", "Gas", "Keep")] };
    const skippedItems = [{ phaseId: "fill", key: "hvac", instance: 1, instances: 1 }];
    const withoutPlan = buildReviewRequest(extracted, transcript, treeSchema, { skippedItems });
    const withPlan = buildReviewRequest(extracted, transcript, treeSchema, {
      reviewPlan: hvacPartitionPlan,
      skippedItems,
    });

    const noPlanGroup = groupNamed(withoutPlan, "hvac");
    const laidOutGroup = groupNamed(withPlan, "hvac");
    if (noPlanGroup?.kind !== "collection" || laidOutGroup?.kind !== "collection") {
      throw new Error("unreachable");
    }
    expect(laidOutGroup.skipped).toBe(noPlanGroup.skipped);
    expect(laidOutGroup.state).toBe(noPlanGroup.state);
    expect(laidOutGroup.emptyQuote).toBe(noPlanGroup.emptyQuote);
    expect(laidOutGroup.instances.map((instance) => instance.skipped)).toEqual(
      noPlanGroup.instances.map((instance) => instance.skipped),
    );
    // And the sections are there — the flags survived a layout that happened.
    expect(sectionsOf(firstInstanceOf(withPlan, "hvac").children).map((s) => s.label)).toEqual([
      "cooling",
      "heating",
      "Other",
    ]);
  });

  test("a derived plan whose part is labeled 'Other' still lays out sections with distinct labels", () => {
    // "remainder" is a reserved part label at derivation, but "Other" is not —
    // and the proposer invites short, model-chosen labels, so a part genuinely
    // named "Other" is plan data a host can hold from the derivation itself.
    // The catch-all's label is the same fixed literal, so a part labeled
    // "Other" folds into the catch-all — the plan asserted no topic for those
    // fields, which is what the catch-all holds — rather than emitting a second
    // section no host could tell apart from it.
    const otherPartPlan = deriveExtractionShape(treeSchema, {
      operations: [
        {
          op: "partition",
          group: "hvac",
          parts: { Other: ["hvacSystemEquipmentType"], cooling: ["hvacHeatingEnergySource"] },
        },
      ],
    });
    const request = plannedRequestFor(
      { hvac: [hvacInstance("Boiler", "Gas", "Keep")] },
      otherPartPlan,
    );
    const sections = sectionsOf(firstInstanceOf(request, "hvac").children);
    const labels = sections.map((s) => s.label);

    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toEqual(["cooling", "Other"]);
    expect(sections.map((s) => treeLeafPaths(s.children))).toEqual([
      ["hvac[k1].hvacHeatingEnergySource"],
      ["hvac[k1].hvacSystemEquipmentType", "hvac[k1].hvacUpgradeAction"],
    ]);
  });

  test("a partition entry naming a top-level leaf is ignored — no throw, the leaf untouched", () => {
    // A derivation refuses a partition on a top-level leaf, so this is stale
    // plan data. The quiet-degrade contract covers it: the leaf node passes
    // through unsectioned and every leaf still appears exactly once. It is the
    // one top-level node kind no other plan test hands a partition entry to.
    const plan: ReviewPlan = {
      ...hvacPartitionPlan,
      partitions: { ...hvacPartitionPlan.partitions, rValue: { everywhere: ["rValue"] } },
    };
    const extracted = {
      rValue: { value: 30, confidence: 1, sourceSpan: "R30" },
      hvac: [hvacInstance("Boiler", "Gas", "Keep")],
    };
    const request = plannedRequestFor(extracted, plan);

    expect(groupNamed(request, "rValue")?.kind).toBe("leaf");
    const leafPaths = treeLeafPaths(request.tree);
    expect(new Set(leafPaths)).toEqual(new Set(Object.keys(request.fields)));
    expect(new Set(leafPaths).size).toBe(leafPaths.length);
  });

  test("a no-topic part's stale entries — one duplicating a placed leaf, one unknown — keep every leaf exactly once", () => {
    // Neither entry is plan data a derivation produces: the remainder holds the
    // fields no part named, so it cannot repeat one, and its entries name real
    // fields. The degrade is exactly-once: the duplicate entry places nothing,
    // the unknown field's entry is ignored, and every leaf appears once.
    const plan: ReviewPlan = {
      ...hvacPartitionPlan,
      partitions: {
        hvac: {
          cooling: ["hvacSystemEquipmentType"],
          heating: ["hvacHeatingEnergySource"],
          remainder: ["hvacSystemEquipmentType", "ghost", "hvacUpgradeAction"],
        },
      },
    };
    const request = plannedRequestFor({ hvac: [hvacInstance("Boiler", "Gas", "Keep")] }, plan);

    expect(
      sectionsOf(firstInstanceOf(request, "hvac").children).map((s) => treeLeafPaths(s.children)),
    ).toEqual([
      ["hvac[k1].hvacSystemEquipmentType"],
      ["hvac[k1].hvacHeatingEnergySource"],
      ["hvac[k1].hvacUpgradeAction"],
    ]);
    const leafPaths = treeLeafPaths(request.tree);
    expect(new Set(leafPaths)).toEqual(new Set(Object.keys(request.fields)));
    expect(new Set(leafPaths).size).toBe(leafPaths.length);
  });

  test("a normal part and an 'Other' part naming one leaf — the normal part claims it, exactly once", () => {
    // Overlapping parts are plan data no derivation produces (it refuses a field
    // named twice), so this is stale-plan shape. Two readings exist: the first
    // part in enumeration order claims the leaf (the two-normal-parts rule), or
    // the normal parts claim first and the no-topic parts yield to what is
    // already placed — what the fold's code does, since the catch-all is built
    // after the part loop. The pin is the observable resolution: the leaf sits
    // in the normal part's section, nothing is duplicated or dropped.
    const plan: ReviewPlan = {
      ...hvacPartitionPlan,
      partitions: {
        hvac: {
          Other: ["hvacSystemEquipmentType"],
          cooling: ["hvacSystemEquipmentType"],
        },
      },
    };
    const request = plannedRequestFor({ hvac: [hvacInstance("Boiler", "Gas", "Keep")] }, plan);

    expect(sectionsOf(firstInstanceOf(request, "hvac").children).map((s) => s.label)).toEqual([
      "cooling",
      "Other",
    ]);
    expect(
      sectionsOf(firstInstanceOf(request, "hvac").children).map((s) => treeLeafPaths(s.children)),
    ).toEqual([
      ["hvac[k1].hvacSystemEquipmentType"],
      ["hvac[k1].hvacHeatingEnergySource", "hvac[k1].hvacUpgradeAction"],
    ]);
    const leafPaths = treeLeafPaths(request.tree);
    expect(new Set(leafPaths)).toEqual(new Set(Object.keys(request.fields)));
    expect(new Set(leafPaths).size).toBe(leafPaths.length);
  });
});

/* Regroup and nest — the mapping half of the layout.
 *
 * A derived fixture is the primary idiom (the pins read against plan data a host
 * actually holds); the order-rule and degrade fixtures hand-write mapping
 * records — what an out-of-patch-order declaration or a stale entry IS. For a
 * derived plan the mapping enumerates in patch-leaf order, so the
 * enumeration-order pins need hand-written records to be pins at all.
 */

const jobRegroupSchema = z.object({
  job: z.object({
    city: z.string().nullable().optional(),
    zip: z.string().nullable().optional(),
  }),
});

const jobExtracted = {
  job: {
    city: { value: "Seattle", confidence: 1, sourceSpan: "in Seattle" },
    zip: { value: "98101", confidence: 1, sourceSpan: "98101" },
  },
};

const jobRegroupPlan = deriveExtractionShape(jobRegroupSchema, {
  operations: [{ op: "regroup", group: "job", moves: { city: "location.city" } }],
});

const nestSchema = z.object({
  poolSize: z.number().nullable().optional(),
  rValue: z.number().nullable().optional(),
});

const nestExtracted = {
  poolSize: { value: 12, confidence: 1, sourceSpan: "twelve" },
  rValue: { value: 30, confidence: 1, sourceSpan: "R30" },
};

const nestPlan = deriveExtractionShape(nestSchema, {
  operations: [{ op: "nest", group: "pool", moves: { poolSize: "size" } }],
});

describe("buildReviewRequest — a reviewPlan lays regrouped and nested fields out by its mapping", () => {
  test("a regroup's extraction-only intermediate renders as a labelled section after the surviving patch children", () => {
    const request = buildReviewRequest(jobExtracted, transcript, jobRegroupSchema, {
      reviewPlan: jobRegroupPlan,
    });
    const job = groupNamed(request, "job");
    const children = job?.kind === "object" ? job.children : [];

    // The untouched leaf keeps its patch position; the moved leaf's section
    // comes after it — and the leaf inside keeps its patch path and is the
    // very field object `fields` holds.
    expect(treeLeafPaths(children)).toEqual(["job.zip", "job.city"]);
    const sections = sectionsOf(children);
    expect(sections.map((s) => s.label)).toEqual(["location"]);
    const moved = sections[0]!.children[0]!;
    expect(moved.kind === "leaf" && moved.path).toBe("job.city");
    expect(moved.kind === "leaf" && moved.field).toBe(request.fields["job.city"]);
    const leafPaths = treeLeafPaths(request.tree);
    expect(new Set(leafPaths)).toEqual(new Set(Object.keys(request.fields)));
    expect(new Set(leafPaths).size).toBe(leafPaths.length);
  });

  test("deeper intermediates nest sections", () => {
    const deepPlan = deriveExtractionShape(jobRegroupSchema, {
      operations: [{ op: "regroup", group: "job", moves: { city: "a.b.city" } }],
    });
    const request = buildReviewRequest(jobExtracted, transcript, jobRegroupSchema, {
      reviewPlan: deepPlan,
    });
    const job = groupNamed(request, "job");
    const sections = job?.kind === "object" ? sectionsOf(job.children) : [];

    expect(sections.map((s) => s.label)).toEqual(["a"]);
    const inner = sectionsOf(sections[0]!.children);
    expect(inner.map((s) => s.label)).toEqual(["b"]);
    expect(treeLeafPaths(inner[0]!.children)).toEqual(["job.city"]);
  });

  test("a leaf regrouped into a position the patch declares as an object joins it — no section", () => {
    const joinSchema = z.object({
      job: z.object({
        city: z.string().nullable().optional(),
        location: z.object({ region: z.string().nullable().optional() }).optional(),
      }),
    });
    const joinPlan = deriveExtractionShape(joinSchema, {
      operations: [{ op: "regroup", group: "job", moves: { city: "location.city" } }],
    });
    const extracted = {
      job: {
        city: { value: "Seattle", confidence: 1, sourceSpan: "in Seattle" },
        location: { region: { value: "PNW", confidence: 1, sourceSpan: "PNW" } },
      },
    };
    const request = buildReviewRequest(extracted, transcript, joinSchema, {
      reviewPlan: joinPlan,
    });
    const job = groupNamed(request, "job");
    const children = job?.kind === "object" ? job.children : [];

    // No section anywhere: the moved leaf joined the patch's own object node,
    // appended after the child that kept its patch position.
    expect(sectionsOf(children)).toEqual([]);
    expect(children.map((c) => c.kind)).toEqual(["object"]);
    expect(treeLeafPaths(children)).toEqual(["job.location.region", "job.city"]);
    const joined = children[0]!;
    const moved = joined.kind === "object" ? joined.children[1]! : undefined;
    expect(moved?.kind === "leaf" && moved.path).toBe("job.city");
    expect(moved?.kind === "leaf" && moved.field).toBe(request.fields["job.city"]);
  });

  test("a leaf regrouped out to the group's own level appears after the surviving patch children", () => {
    const flattenSchema = z.object({
      job: z.object({
        keep: z.string().nullable().optional(),
        location: z
          .object({
            city: z.string().nullable().optional(),
            region: z.string().nullable().optional(),
          })
          .optional(),
      }),
    });
    const flattenPlan = deriveExtractionShape(flattenSchema, {
      operations: [{ op: "regroup", group: "job", moves: { "location.city": "city" } }],
    });
    const extracted = {
      job: {
        keep: { value: "kept", confidence: 1, sourceSpan: "kept" },
        location: {
          city: { value: "Seattle", confidence: 1, sourceSpan: "in Seattle" },
          region: { value: "PNW", confidence: 1, sourceSpan: "PNW" },
        },
      },
    };
    const request = buildReviewRequest(extracted, transcript, flattenSchema, {
      reviewPlan: flattenPlan,
    });
    const job = groupNamed(request, "job");
    const children = job?.kind === "object" ? job.children : [];

    // The moved leaf does not return to its old position inside `location` —
    // it appends after everything that kept its patch position, the object it
    // left (still at ITS patch position) included.
    expect(children.map((c) => c.kind)).toEqual(["leaf", "object", "leaf"]);
    expect(treeLeafPaths(children)).toEqual([
      "job.keep",
      "job.location.region",
      "job.location.city",
    ]);
  });

  test("within a regroup section, fields follow the mapping's enumeration order", () => {
    // A derived plan enumerates in patch-leaf order, so the pin needs a
    // hand-written mapping: zip's entry is declared first, the schema declares
    // city first — the section shows zip, then city.
    const plan: ReviewPlan = {
      mapping: {
        leaves: {
          "job.location.zip": { source: "job.zip" },
          "job.location.city": { source: "job.city" },
        },
        provenance: {},
      },
      partitions: {},
    };
    const request = buildReviewRequest(jobExtracted, transcript, jobRegroupSchema, {
      reviewPlan: plan,
    });
    const job = groupNamed(request, "job");
    const sections = job?.kind === "object" ? sectionsOf(job.children) : [];

    expect(sections.map((s) => s.label)).toEqual(["location"]);
    expect(treeLeafPaths(sections[0]!.children)).toEqual(["job.zip", "job.city"]);
  });

  test("a nest's new top-level group renders as a top-level section after the patch's own groups", () => {
    const request = buildReviewRequest(nestExtracted, transcript, nestSchema, {
      reviewPlan: nestPlan,
    });

    expect(treeLeafPaths(request.tree)).toEqual(["rValue", "poolSize"]);
    const sections = sectionsOf(request.tree);
    expect(sections.map((s) => s.label)).toEqual(["pool"]);
    const moved = sections[0]!.children[0]!;
    expect(moved.kind === "leaf" && moved.path).toBe("poolSize");
    expect(moved.kind === "leaf" && moved.field).toBe(request.fields["poolSize"]);
    // The moved leaf left the patch's own top level — it appears in the
    // section, exactly once.
    expect(groupNamed(request, "poolSize")).toBeUndefined();
    const leafPaths = treeLeafPaths(request.tree);
    expect(new Set(leafPaths)).toEqual(new Set(Object.keys(request.fields)));
    expect(new Set(leafPaths).size).toBe(leafPaths.length);
  });

  test("a nest group named after the leaf it moves away holds that leaf inside the section", () => {
    // The derivation frees the name: the patch's own top-level leaf `pool` is
    // the very leaf the nest moves, so the extraction-space group `pool` and
    // the patch leaf `pool` coexist only as section label and leaf path.
    const anchorSchema = z.object({
      pool: z.string().nullable().optional(),
      other: z.string().nullable().optional(),
    });
    const anchorPlan = deriveExtractionShape(anchorSchema, {
      operations: [{ op: "nest", group: "pool", moves: { pool: "size" } }],
    });
    const extracted = {
      pool: { value: "yes", confidence: 1, sourceSpan: "a pool" },
      other: { value: "x", confidence: 1, sourceSpan: "x" },
    };
    const request = buildReviewRequest(extracted, transcript, anchorSchema, {
      reviewPlan: anchorPlan,
    });

    expect(treeLeafPaths(request.tree)).toEqual(["other", "pool"]);
    const sections = sectionsOf(request.tree);
    expect(sections.map((s) => s.label)).toEqual(["pool"]);
    const moved = sections[0]!.children[0]!;
    expect(moved.kind === "leaf" && moved.path).toBe("pool");
  });

  test("several nest sections follow the mapping's enumeration order", () => {
    // Enumeration order puts spa first; neither the alphabet (pool) nor the
    // patch's declaration order (poolSize first) does.
    const plan: ReviewPlan = {
      mapping: {
        leaves: {
          "spa.temp": { source: "spaTemp" },
          "pool.size": { source: "poolSize" },
        },
        provenance: {},
      },
      partitions: {},
    };
    const extracted = { ...nestExtracted, spaTemp: { value: 38, confidence: 1, sourceSpan: "38" } };
    const schema = z.object({
      poolSize: z.number().nullable().optional(),
      spaTemp: z.number().nullable().optional(),
      rValue: z.number().nullable().optional(),
    });
    const request = buildReviewRequest(extracted, transcript, schema, { reviewPlan: plan });

    expect(sectionsOf(request.tree).map((s) => s.label)).toEqual(["spa", "pool"]);
    expect(treeLeafPaths(request.tree)).toEqual(["rValue", "spaTemp", "poolSize"]);
  });

  test("a nest destination's deeper intermediates nest sections under the top-level one", () => {
    const deepNestPlan = deriveExtractionShape(nestSchema, {
      operations: [{ op: "nest", group: "pool", moves: { poolSize: "a.size" } }],
    });
    const request = buildReviewRequest(nestExtracted, transcript, nestSchema, {
      reviewPlan: deepNestPlan,
    });

    const sections = sectionsOf(request.tree);
    expect(sections.map((s) => s.label)).toEqual(["pool"]);
    const inner = sectionsOf(sections[0]!.children);
    expect(inner.map((s) => s.label)).toEqual(["a"]);
    expect(treeLeafPaths(inner[0]!.children)).toEqual(["poolSize"]);
  });

  test("a collection under a regrouped group keeps its patch position, verbatim, and still writes empty", () => {
    const ventsSchema = z.object({
      job: z.object({
        city: z.string().nullable().optional(),
        vents: z.array(z.object({ size: z.string().nullable().optional() })).optional(),
      }),
    });
    const ventsPlan = deriveExtractionShape(ventsSchema, {
      operations: [{ op: "regroup", group: "job", moves: { city: "location.city" } }],
    });
    const extracted = {
      job: {
        city: { value: "Seattle", confidence: 1, sourceSpan: "in Seattle" },
        vents: [],
      },
    };
    const withoutPlan = buildReviewRequest(extracted, transcript, ventsSchema);
    const withPlan = buildReviewRequest(extracted, transcript, ventsSchema, {
      reviewPlan: ventsPlan,
    });

    const job = groupNamed(withPlan, "job");
    const children = job?.kind === "object" ? job.children : [];
    expect(children.map((c) => c.kind)).toEqual(["collection", "section"]);
    // The collection node the layout re-parented is the walk's own — state,
    // skip flag, instances, everything.
    const noPlanJob = groupNamed(withoutPlan, "job");
    const noPlanVents =
      noPlanJob?.kind === "object"
        ? noPlanJob.children.find((n) => n.kind !== "section" && n.key === "vents")
        : undefined;
    expect(children[0]).toEqual(noPlanVents);

    // And the laid-out tree still writes the empty collection on resolve —
    // identical to the no-plan outcome.
    const submission = {
      status: "submitted" as const,
      decisions: decisionsFor(Object.keys(withoutPlan.fields)),
    };
    expect(resolveReview(withPlan, submission)).toEqual(resolveReview(withoutPlan, submission));
  });

  test("a moved entry whose source names nothing is ignored — no throw, no section, no move", () => {
    const plan: ReviewPlan = {
      mapping: { leaves: { "job.location.city": { source: "ghost.city" } }, provenance: {} },
      partitions: {},
    };
    const withoutPlan = buildReviewRequest(jobExtracted, transcript, jobRegroupSchema);
    const withPlan = buildReviewRequest(jobExtracted, transcript, jobRegroupSchema, {
      reviewPlan: plan,
    });

    expect(withPlan.tree).toEqual(withoutPlan.tree);
  });

  test("a nest entry whose source names nothing is ignored the same way", () => {
    const plan: ReviewPlan = {
      mapping: { leaves: { "pool.size": { source: "ghost" } }, provenance: {} },
      partitions: {},
    };
    const withoutPlan = buildReviewRequest(nestExtracted, transcript, nestSchema);
    const withPlan = buildReviewRequest(nestExtracted, transcript, nestSchema, {
      reviewPlan: plan,
    });

    expect(withPlan.tree).toEqual(withoutPlan.tree);
  });

  test("an entry rooted at a collection is ignored — regroup sections arise only in singleton groups", () => {
    // The mapping's array-depth check refuses an entry whose two sides sit at
    // different depths under an array, so a derived plan can move an element
    // leaf only by same-depth rename — and collections are opaque either way:
    // such an entry's leaves keep their per-instance patch positions. The
    // derived form of this case is pinned two tests down.
    const plan: ReviewPlan = {
      mapping: {
        leaves: {
          "hvac.location.hvacSystemEquipmentType": { source: "hvac.hvacSystemEquipmentType" },
        },
        provenance: {},
      },
      partitions: {},
    };
    const extracted = { hvac: [hvacInstance("Boiler", "Gas", "Keep")] };
    const withoutPlan = treeRequestFor(extracted);
    const withPlan = plannedRequestFor(extracted, plan);

    expect(withPlan.tree).toEqual(withoutPlan.tree);
  });

  test("a derived element-level rename regroup is a moved entry rooted at a collection — ignored, leaves at their per-instance positions", () => {
    // The hand-written stale plan two tests up is not the only way a
    // collection-rooted moved entry arises: a same-depth rename WITHIN the
    // element keeps the entry's array-depth pattern, so the derivation APPLIES
    // it and the plan carries a genuinely moved entry whose source is
    // element-relative. Collections are opaque to the layout, so the entry
    // places nothing — the leaves keep their per-instance patch positions and
    // the tree is the no-plan tree. (An extraction-only intermediate under an
    // array, the case that WOULD demand a section, is refused by the depth
    // check — hence "sections arise only in singleton groups".)
    const collectionSchema = z.object({ hvac: z.array(hvacElementSchema).optional() });
    const renamePlan = deriveExtractionShape(collectionSchema, {
      operations: [{ op: "regroup", group: "hvac", moves: { hvacUpgradeAction: "upgradeAction" } }],
    });

    // The derivation's own acceptance is the point: the entry's two sides
    // disagree, so the layout runs its three-step pass over a moved entry
    // rooted at a collection, not just over hand-written stale data.
    const movedEntries = Object.entries(renamePlan.mapping.leaves).filter(
      ([path, entry]) => path !== entry.source,
    );
    expect(movedEntries).toEqual([["hvac.upgradeAction", { source: "hvac.hvacUpgradeAction" }]]);

    const extracted = { hvac: [hvacInstance("Boiler", "Gas", "Keep")] };
    const withoutPlan = buildReviewRequest(extracted, transcript, collectionSchema);
    const withPlan = buildReviewRequest(extracted, transcript, collectionSchema, {
      reviewPlan: renamePlan,
    });

    expect(withPlan.tree).toEqual(withoutPlan.tree);
    const leafPaths = treeLeafPaths(withPlan.tree);
    expect(new Set(leafPaths)).toEqual(new Set(Object.keys(withPlan.fields)));
    expect(new Set(leafPaths).size).toBe(leafPaths.length);
  });

  test("two moved entries naming one patch leaf place it exactly once, first in enumeration order", () => {
    // A broken bijection — plan data no derivation produces (criterion 18's own
    // example). The observable resolution: the first entry in enumeration order
    // claims the leaf, the second places nothing, nothing is duplicated.
    const plan: ReviewPlan = {
      mapping: {
        leaves: {
          "job.location.city": { source: "job.city" },
          "job.where.city": { source: "job.city" },
        },
        provenance: {},
      },
      partitions: {},
    };
    const request = buildReviewRequest(jobExtracted, transcript, jobRegroupSchema, {
      reviewPlan: plan,
    });

    expect(treeLeafPaths(request.tree)).toEqual(["job.zip", "job.city"]);
    const job = groupNamed(request, "job");
    const sections = job?.kind === "object" ? sectionsOf(job.children) : [];
    expect(sections.map((s) => s.label)).toEqual(["location"]);
    const leafPaths = treeLeafPaths(request.tree);
    expect(new Set(leafPaths)).toEqual(new Set(Object.keys(request.fields)));
    expect(new Set(leafPaths).size).toBe(leafPaths.length);
  });

  test("the same plan object laid out twice yields identical trees — the mapping half is pure across repeat calls", () => {
    // Criterion 4's purity pin covers the partition-only path (a plan with no
    // moved entries); the three-step mapping half was never pinned. Repeat
    // invocation with the SAME plan object is the production path — a host
    // holds the plan still and rebuilds the request per render — so any state
    // the placement pass leaked across calls would show here.
    const first = buildReviewRequest(jobExtracted, transcript, jobRegroupSchema, {
      reviewPlan: jobRegroupPlan,
    });
    const second = buildReviewRequest(jobExtracted, transcript, jobRegroupSchema, {
      reviewPlan: jobRegroupPlan,
    });

    expect(second.tree).toEqual(first.tree);
    expect(second.fields).toEqual(first.fields);
  });

  test("partition, regroup and nest compose in one plan, every invariant holding", () => {
    const mixedSchema = z.object({
      rValue: z.number().nullable().optional(),
      job: z.object({
        city: z.string().nullable().optional(),
        zip: z.string().nullable().optional(),
      }),
      hvac: z.array(hvacElementSchema).optional(),
    });
    const mixedPlan = deriveExtractionShape(mixedSchema, {
      operations: [
        { op: "retype", path: "hvac.hvacUpgradeAction", to: "number" },
        { op: "regroup", group: "job", moves: { city: "location.city" } },
        {
          op: "partition",
          group: "hvac",
          parts: { cooling: ["hvacSystemEquipmentType"], heating: ["hvacHeatingEnergySource"] },
        },
        { op: "nest", group: "site", moves: { rValue: "r" } },
      ],
    });
    const extracted = {
      rValue: { value: 30, confidence: 1, sourceSpan: "R30" },
      job: {
        city: { value: "Seattle", confidence: 1, sourceSpan: "in Seattle" },
        zip: { value: "98101", confidence: 1, sourceSpan: "98101" },
      },
      hvac: [hvacInstance("Boiler", "Gas", "Keep")],
    };
    const withoutPlan = buildReviewRequest(extracted, transcript, mixedSchema);
    const withPlan = buildReviewRequest(extracted, transcript, mixedSchema, {
      reviewPlan: mixedPlan,
    });

    // Each operation owns its container: the regroup section inside `job`, the
    // partition sections inside every instance, the nest section last — after
    // the patch's own top-level groups.
    expect(sectionsOf(withPlan.tree).map((s) => s.label)).toEqual(["site"]);
    const job = groupNamed(withPlan, "job");
    expect(job?.kind === "object" ? sectionsOf(job.children).map((s) => s.label) : []).toEqual([
      "location",
    ]);
    expect(sectionsOf(firstInstanceOf(withPlan, "hvac").children).map((s) => s.label)).toEqual([
      "cooling",
      "heating",
      "Other",
    ]);
    expect(treeLeafPaths(withPlan.tree)).toEqual([
      "job.zip",
      "job.city",
      "hvac[k1].hvacSystemEquipmentType",
      "hvac[k1].hvacHeatingEnergySource",
      "hvac[k1].hvacUpgradeAction",
      "rValue",
    ]);
    const leafPaths = treeLeafPaths(withPlan.tree);
    expect(new Set(leafPaths)).toEqual(new Set(Object.keys(withPlan.fields)));
    expect(new Set(leafPaths).size).toBe(leafPaths.length);

    // `fields` is identical with and without the plan, order included.
    expect(Object.keys(withPlan.fields)).toEqual(Object.keys(withoutPlan.fields));
    for (const path of Object.keys(withoutPlan.fields)) {
      expect(leaf(withPlan, path)).toEqual(leaf(withoutPlan, path));
    }

    // resolveReview over the laid-out tree classifies identically — edits
    // touching the sections' leaves, not just accepts.
    const submission = {
      status: "submitted" as const,
      decisions: {
        ...decisionsFor(Object.keys(withoutPlan.fields)),
        "job.city": { status: "edited" as const, value: "Tacoma" },
        "hvac[k1].hvacUpgradeAction": { status: "edited" as const, value: "Replace" },
      },
    };
    expect(resolveReview(withPlan, submission)).toEqual(resolveReview(withoutPlan, submission));
  });

  test("a chain that joins the patch's own object and then enters extraction-only space nests the section under the joined object", () => {
    // `location` is real patch structure, `sub` is not: the first segment joins
    // the object node, the second gets a section draft inside it — appended
    // after the surviving patch child, and materialized at depth.
    const plan: ReviewPlan = {
      mapping: { leaves: { "job.location.sub.city": { source: "job.city" } }, provenance: {} },
      partitions: {},
    };
    const joinSchema = z.object({
      job: z.object({
        city: z.string().nullable().optional(),
        location: z.object({ region: z.string().nullable().optional() }).optional(),
      }),
    });
    const extracted = {
      job: {
        city: { value: "Seattle", confidence: 1, sourceSpan: "in Seattle" },
        location: { region: { value: "PNW", confidence: 1, sourceSpan: "PNW" } },
      },
    };
    const request = buildReviewRequest(extracted, transcript, joinSchema, { reviewPlan: plan });
    const job = groupNamed(request, "job");
    const location = job?.kind === "object" ? job.children[0] : undefined;

    expect(location?.kind).toBe("object");
    expect(location?.kind === "object" && location.children.map((c) => c.kind)).toEqual([
      "leaf",
      "section",
    ]);
    const sections = location?.kind === "object" ? sectionsOf(location.children) : [];
    expect(sections.map((s) => s.label)).toEqual(["sub"]);
    expect(treeLeafPaths(request.tree)).toEqual(["job.location.region", "job.city"]);
    expect(sectionsOf(request.tree)).toEqual([]);
    const moved = sections[0]!.children[0]!;
    expect(moved.kind === "leaf" && moved.field).toBe(request.fields["job.city"]);
  });

  test("a section draft and a directly placed leaf share one appended list, in the mapping's enumeration order", () => {
    // Both entries append into `job`: the first creates the `where` section,
    // the second places its leaf directly at job's level. The section precedes
    // the leaf only because the mapping declared it first — the shared list
    // takes enumeration order across kinds, not sections-before-leaves.
    const plan: ReviewPlan = {
      mapping: {
        leaves: {
          "job.where.city": { source: "job.city" },
          "job.flat": { source: "job.zip" },
        },
        provenance: {},
      },
      partitions: {},
    };
    const request = buildReviewRequest(jobExtracted, transcript, jobRegroupSchema, {
      reviewPlan: plan,
    });
    const job = groupNamed(request, "job");
    const children = job?.kind === "object" ? job.children : [];

    expect(children.map((c) => c.kind)).toEqual(["section", "leaf"]);
    expect(treeLeafPaths(children)).toEqual(["job.city", "job.zip"]);
    const leafPaths = treeLeafPaths(request.tree);
    expect(new Set(leafPaths)).toEqual(new Set(Object.keys(request.fields)));
    expect(new Set(leafPaths).size).toBe(leafPaths.length);
  });

  test("a placement chain naming a collection does not join it — it bounces to a top-level section", () => {
    // The placement joins OBJECT nodes only: a collection is opaque, so a chain
    // segment naming one creates a section of that name instead of entering.
    const plan: ReviewPlan = {
      mapping: { leaves: { "hvac.city": { source: "job.city" } }, provenance: {} },
      partitions: {},
    };
    const schema = z.object({
      job: z.object({
        city: z.string().nullable().optional(),
        zip: z.string().nullable().optional(),
      }),
      hvac: z.array(z.object({ size: z.string().nullable().optional() })).optional(),
    });
    const extracted = {
      job: {
        city: { value: "Seattle", confidence: 1, sourceSpan: "in Seattle" },
        zip: { value: "98101", confidence: 1, sourceSpan: "98101" },
      },
      hvac: [{ size: { value: "8in", confidence: 1, sourceSpan: "8in" } }],
    };
    const withoutPlan = buildReviewRequest(extracted, transcript, schema);
    const withPlan = buildReviewRequest(extracted, transcript, schema, { reviewPlan: plan });

    expect(sectionsOf(withPlan.tree).map((s) => s.label)).toEqual(["hvac"]);
    expect(treeLeafPaths(withPlan.tree)).toEqual(["job.zip", "hvac[k1].size", "job.city"]);
    const hvac = groupNamed(withPlan, "hvac");
    expect(hvac).toEqual(groupNamed(withoutPlan, "hvac"));
    const leafPaths = treeLeafPaths(withPlan.tree);
    expect(new Set(leafPaths)).toEqual(new Set(Object.keys(withPlan.fields)));
    expect(new Set(leafPaths).size).toBe(leafPaths.length);
  });

  test("a placement intermediate colliding with a surviving leaf names a section, leaving the leaf where it is", () => {
    // The derivation refuses a nest group shadowing a key that stays; a stale
    // plan violating that degrades deterministically: the surviving leaf keeps
    // its patch position and the placement gets a section of the same name.
    const plan: ReviewPlan = {
      mapping: { leaves: { "rValue.size": { source: "poolSize" } }, provenance: {} },
      partitions: {},
    };
    const request = buildReviewRequest(nestExtracted, transcript, nestSchema, { reviewPlan: plan });

    expect(treeLeafPaths(request.tree)).toEqual(["rValue", "poolSize"]);
    const sections = sectionsOf(request.tree);
    expect(sections.map((s) => s.label)).toEqual(["rValue"]);
    const moved = sections[0]!.children[0]!;
    expect(moved.kind === "leaf" && moved.field).toBe(request.fields["poolSize"]);
    const leafPaths = treeLeafPaths(request.tree);
    expect(new Set(leafPaths)).toEqual(new Set(Object.keys(request.fields)));
    expect(new Set(leafPaths).size).toBe(leafPaths.length);
  });

  test("two regroups naming the same intermediate give each group its own section", () => {
    // Sections are per container: a shared label in two groups is two sections,
    // each holding only its own group's moved leaf.
    const schema = z.object({
      job: z.object({
        city: z.string().nullable().optional(),
        zip: z.string().nullable().optional(),
      }),
      attic: z.object({
        region: z.string().nullable().optional(),
        note: z.string().nullable().optional(),
      }),
    });
    const plan = deriveExtractionShape(schema, {
      operations: [
        { op: "regroup", group: "job", moves: { city: "location.city" } },
        { op: "regroup", group: "attic", moves: { region: "location.region" } },
      ],
    });
    const extracted = {
      job: {
        city: { value: "Seattle", confidence: 1, sourceSpan: "in Seattle" },
        zip: { value: "98101", confidence: 1, sourceSpan: "98101" },
      },
      attic: {
        region: { value: "PNW", confidence: 1, sourceSpan: "PNW" },
        note: { value: "n", confidence: 1, sourceSpan: "n" },
      },
    };
    const request = buildReviewRequest(extracted, transcript, schema, { reviewPlan: plan });

    const job = groupNamed(request, "job");
    const attic = groupNamed(request, "attic");
    const jobSections = job?.kind === "object" ? sectionsOf(job.children) : [];
    const atticSections = attic?.kind === "object" ? sectionsOf(attic.children) : [];
    expect(jobSections.map((s) => s.label)).toEqual(["location"]);
    expect(atticSections.map((s) => s.label)).toEqual(["location"]);
    expect(treeLeafPaths(jobSections[0]!.children)).toEqual(["job.city"]);
    expect(treeLeafPaths(atticSections[0]!.children)).toEqual(["attic.region"]);
    const leafPaths = treeLeafPaths(request.tree);
    expect(new Set(leafPaths)).toEqual(new Set(Object.keys(request.fields)));
    expect(new Set(leafPaths).size).toBe(leafPaths.length);
  });

  test("an extraction path with a single segment places its leaf directly at the top level", () => {
    // placementChain's empty-chain boundary: one segment total wraps no
    // intermediate, so the moved leaf appends after the patch's own top-level
    // nodes — the same position a nest section follows, without the section.
    const plan: ReviewPlan = {
      mapping: { leaves: { flat: { source: "job.city" } }, provenance: {} },
      partitions: {},
    };
    const request = buildReviewRequest(jobExtracted, transcript, jobRegroupSchema, {
      reviewPlan: plan,
    });

    expect(sectionsOf(request.tree)).toEqual([]);
    expect(treeLeafPaths(request.tree)).toEqual(["job.zip", "job.city"]);
    const moved = request.tree[1]!;
    expect(moved.kind === "leaf" && moved.path).toBe("job.city");
    expect(moved.kind === "leaf" && moved.field).toBe(request.fields["job.city"]);
    const leafPaths = treeLeafPaths(request.tree);
    expect(new Set(leafPaths)).toEqual(new Set(Object.keys(request.fields)));
    expect(new Set(leafPaths).size).toBe(leafPaths.length);
  });

  test("a hand-written plan can empty a patch object; the emptied object survives at its patch position", () => {
    // The derivation refuses to empty an object ("no fields left" — it makes the
    // host drop the parent key instead), so no derived plan reaches the prune's
    // empty-rebuild boundary. A hand-written plan can: both paths here are
    // well-formed schema-time data, so nothing throws, and the moved leaf leaves
    // `location` holding nothing. The object child kept its patch position
    // (criterion 12's letter, object children included); the exactly-once and
    // field-identity invariants hold across the emptied node.
    const emptySchema = z.object({
      job: z.object({
        location: z.object({ city: z.string().nullable().optional() }).optional(),
      }),
    });
    const plan: ReviewPlan = {
      mapping: { leaves: { "job.city": { source: "job.location.city" } }, provenance: {} },
      partitions: {},
    };
    const extracted = {
      job: { location: { city: { value: "Seattle", confidence: 1, sourceSpan: "in Seattle" } } },
    };
    const request = buildReviewRequest(extracted, transcript, emptySchema, { reviewPlan: plan });

    const job = groupNamed(request, "job");
    const children = job?.kind === "object" ? job.children : [];
    expect(children.map((c) => c.kind)).toEqual(["object", "leaf"]);
    const location = children[0]!;
    expect(location.kind === "object" && location.path).toBe("job.location");
    expect(location.kind === "object" && location.children).toEqual([]);
    // The moved leaf keeps its patch path wherever it is placed — at job's own
    // level here, its unchanged path intact.
    expect(treeLeafPaths(children)).toEqual(["job.location.city"]);
    const moved = children[1]!;
    expect(moved.kind === "leaf" && moved.field).toBe(request.fields["job.location.city"]);
    const leafPaths = treeLeafPaths(request.tree);
    expect(new Set(leafPaths)).toEqual(new Set(Object.keys(request.fields)));
    expect(new Set(leafPaths).size).toBe(leafPaths.length);
  });

  test("a mapping key the path grammar refuses fails loudly — the grammar's own error", () => {
    // Neither shape is plan data the derivation can produce (it refuses both at
    // construction); a hand-written plan meets the grammar only at layout time,
    // so the grammar's error is the failure they deserve — not a quiet degrade.
    for (const key of ["job..city", "job.location["]) {
      const plan: ReviewPlan = {
        mapping: { leaves: { [key]: { source: "job.city" } }, provenance: {} },
        partitions: {},
      };
      expect(() =>
        buildReviewRequest(jobExtracted, transcript, jobRegroupSchema, { reviewPlan: plan }),
      ).toThrow();
    }
  });

  test("a bracketed mapping key fails loudly — a schema-time path has no instance segment", () => {
    const plan: ReviewPlan = {
      mapping: { leaves: { "job[k1].city": { source: "job.city" } }, provenance: {} },
      partitions: {},
    };
    expect(() =>
      buildReviewRequest(jobExtracted, transcript, jobRegroupSchema, { reviewPlan: plan }),
    ).toThrow();
  });

  test("an empty mapping key fails loudly", () => {
    const plan: ReviewPlan = {
      mapping: { leaves: { "": { source: "job.city" } }, provenance: {} },
      partitions: {},
    };
    expect(() =>
      buildReviewRequest(jobExtracted, transcript, jobRegroupSchema, { reviewPlan: plan }),
    ).toThrow();
  });

  test("a malformed destination with a stale source still fails loudly — the grammar's error is unconditional", () => {
    // Both degrade rules reach for this entry: the source names nothing (the
    // stale rule — ignored, no throw) and the destination key is malformed
    // (the grammar rule — the loud failure that input deserves). The grammar
    // rule governs the key's SHAPE and is unconditional: a malformed key is
    // not plan data the derivation can produce, whatever its source resolves
    // to — assertObjectKeyPath refuses the shape before any source is read.
    // The loud failure must therefore win over the quiet skip, which it only
    // does if the grammar runs before the stale-source short-circuit.
    const plan: ReviewPlan = {
      mapping: { leaves: { "job..city": { source: "ghost.city" } }, provenance: {} },
      partitions: {},
    };
    expect(() =>
      buildReviewRequest(jobExtracted, transcript, jobRegroupSchema, { reviewPlan: plan }),
    ).toThrow();
  });

  test("a source that is not a schema-time path fails loudly — both sides of an entry are asserted", () => {
    // The derivation asserts the shape of both sides of every entry, and the
    // layout's assertion covers the source with the key: a data-time path in a
    // plan's source is the same not-producible input a bracketed key is — it
    // resolves to nothing, so without the assertion it would ride the stale
    // rule's quiet degrade and a corrupt plan would pass as a mismatch.
    for (const source of ["job[k1].city", ""]) {
      const plan: ReviewPlan = {
        mapping: { leaves: { "job.location.city": { source } }, provenance: {} },
        partitions: {},
      };
      expect(() =>
        buildReviewRequest(jobExtracted, transcript, jobRegroupSchema, { reviewPlan: plan }),
      ).toThrow();
    }
  });

  test("a malformed path fails loudly even where no entry moves — the assertion precedes the fast path", () => {
    // Key equals source, so the entry moves nothing and the mapping half's
    // three steps never run; the shape assertion sits ahead of that early
    // return, because "the plan's paths are schema-time" is a fact about the
    // record, not about the entries the layout happens to walk.
    const plan: ReviewPlan = {
      mapping: { leaves: { "": { source: "" } }, provenance: {} },
      partitions: {},
    };
    expect(() =>
      buildReviewRequest(jobExtracted, transcript, jobRegroupSchema, { reviewPlan: plan }),
    ).toThrow();
  });
});
