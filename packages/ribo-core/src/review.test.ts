import { describe, expect, test } from "vitest";
import { z } from "zod";

import type { enveloped } from "./enveloped.js";
import {
  buildReviewRequest,
  resolveReview,
  ReviewValidationError,
  reviewOutcomeSchema,
} from "./review.js";
import type { Extracted } from "./provenance.js";
import type {
  ExtractedFields,
  FieldDecision,
  FieldDecisions,
  ReviewField,
  ReviewOutcome,
  ReviewRequest,
} from "./review.js";
import type { Transcript } from "./transcript.js";

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
    // outbox row written by an older, looser build would look exactly like this.
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
  // Design §4 claims R1.5 needs no outbox document version bump: `fields` is
  // `z.record(z.string(), z.unknown())`, which accepts a nested object, and the
  // touched-field lists are `z.array(z.string())`, which accept dotted paths. This is
  // that claim, checked against real `resolveReview` output. (`queue/outbox-memory.test.ts`
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
  // exactly what `T | null` could not express.
  const _fields = outcome.fields;

  expect(outcome.status).toBe("discarded");
});

test("ReviewOutcome no longer takes a type parameter", () => {
  // @ts-expect-error - not generic. `fields` is the reassembled nested object, and
  // `ToolAdapter.schema.parse` at the write step is what turns it into `V`.
  const outcome: ReviewOutcome<{ rValue: number }> = { status: "discarded" };

  expect(outcome.status).toBe("discarded");
});

test("ExtractedFields<F> still lines up with Extracted<T>", () => {
  // `ExtractedFields<F>` has no consumer in the workspace since review moved to leaf
  // paths — `Enveloped<V>` is its nested-aware successor — but it is still exported,
  // and an exported type with neither a consumer nor a test is the worst of the three
  // states. This keeps it honest until Task 6 decides whether to delete it. It is
  // correct as written: the `F` it maps is already envelope-shaped with no optional
  // keys, which is why it needs no `-?`. See `enveloped.ts`.
  const flat: ExtractedFields<{ rValue: number }> = {
    rValue: { value: 19, confidence: 1, sourceSpan: "R-19" },
  };
  const rValue: Extracted<number> = flat.rValue;

  // @ts-expect-error - the mapping is readonly: a field map is a snapshot of what the
  // model said, not a mutable draft.
  flat.rValue = rValue;

  expect(rValue.value).toBe(19);
});

test("an edited decision must actually carry a value", () => {
  const decisions: FieldDecisions = {
    // @ts-expect-error - "edited" without a value is meaningless: it would be
    // indistinguishable from "accepted", which is a different verdict.
    rValue: { status: "edited" },
  };

  expect(decisions.rValue?.status).toBe("edited");
});
