/**
 * The runnable example behind docs/api/review.html.
 *
 * Every export is a zero-argument function ending in `node:assert/strict`
 * assertions on exactly what the page prose claims. The runner
 * (`run-examples.test.ts`) executes each export in the Vitest `unit` project,
 * so a source change that breaks what the page says breaks the `test` stage.
 * Runs with no credentials and no network: review is a pure function over the
 * values schema, the extracted draft and the transcript.
 */

import assert from "node:assert/strict";
import { z } from "zod";
import {
  buildReviewRequest,
  contradictionMatcher,
  resolveReview,
  ReviewValidationError,
  reviewOutcomeSchema,
} from "@azx/ribo-core";
import type { FieldDecision, ReviewOutcome, ReviewRequest, ReviewSubmission } from "@azx/ribo-core";

// A patch shaped like a real adapter's: every leaf `.nullable().optional()`, one
// nested object group declared in the middle, and one collection group.
const valuesSchema = z.object({
  rValue: z.number().nullable().optional(),
  healthSafety: z
    .object({
      ambientCo: z.enum(["passed", "failed"]).nullable().optional(),
      gasLeak: z.enum(["passed", "failed"]).nullable().optional(),
    })
    .optional(),
  notes: z.string().nullable().optional(),
  hvac: z.array(z.object({ fuel: z.enum(["Oil", "Gas"]).nullable().optional() })).optional(),
});

const transcript = {
  recordingId: "rec-1",
  text: "The attic is R-19 and ambient CO came back clean. There are no HVAC systems.",
  engine: "fake",
};

const draft = {
  rValue: { value: 19, confidence: 1, sourceSpan: "The attic is R-19" },
  healthSafety: {
    ambientCo: { value: "passed", confidence: 1, sourceSpan: "ambient CO came back clean" },
    gasLeak: { value: null, confidence: 1, sourceSpan: null },
  },
  notes: { value: "hatch needs air sealing", confidence: 1, sourceSpan: "never said" },
  hvac: [],
};

const LEAF_PATHS = ["rValue", "healthSafety.ambientCo", "healthSafety.gasLeak", "notes"] as const;

/** Every leaf accepted, as a fresh mutable record — the baseline each case varies. */
const acceptAll = (): Record<string, FieldDecision> =>
  Object.fromEntries(
    LEAF_PATHS.map((path): [string, FieldDecision] => [path, { status: "accepted" }]),
  );

export function theSchemaEnumeratesTheLeavesNotTheData(): void {
  // #region usage
  const request: ReviewRequest = buildReviewRequest(draft, transcript, valuesSchema, {
    statedEmptyGroups: { hvac: "There are no HVAC systems." },
  });
  const field = request.fields["healthSafety.ambientCo"];
  // #endregion usage

  // One entry per schema leaf — a leaf the model omitted is still presented.
  assert.deepEqual(Object.keys(request.fields), [...LEAF_PATHS]);
  assert.equal(field?.extracted.value, "passed");
  // Groundedness is precomputed: a verbatim quote is grounded; "never said" is not.
  assert.equal(request.fields["rValue"]?.isGrounded, true);
  assert.equal(request.fields["notes"]?.isGrounded, false);
  // The collection group's stated-empty claim is on the tree, quote and all.
  const collection = request.tree.find((node) => node.kind === "collection");
  assert.equal(collection?.state, "statedEmpty");
  assert.equal(collection?.emptyQuote, "There are no HVAC systems.");
}

export function resolveReviewClassifiesWhatTheHumanDid(): void {
  const request = buildReviewRequest(draft, transcript, valuesSchema);

  const accepted = resolveReview(request, {
    status: "submitted",
    decisions: acceptAll(),
  });
  assert.equal(accepted.status, "accepted");

  // Accept the CO result while correcting the notes and dropping the leaf that
  // was never said — the field-by-field outcome top-level review cannot express.
  const decisions = acceptAll();
  decisions["notes"] = { status: "edited", value: "R-19 across the attic" };
  decisions["healthSafety.gasLeak"] = { status: "rejected" };
  const edited = resolveReview(request, { status: "submitted", decisions });
  assert.equal(edited.status, "edited");
  assert.deepEqual(edited.editedFields, ["notes"]);
  assert.deepEqual(edited.rejectedFields, ["healthSafety.gasLeak"]);
  // The outcome is the nested shape the adapter's patch schema describes.
  assert.equal(edited.fields.rValue, 19);
  const healthSafety = edited.fields.healthSafety as Record<string, unknown>;
  assert.equal(healthSafety?.ambientCo, "passed");
  // A rejected leaf is absent from the fields, not null — the patch model's
  // "leave this field alone".
  assert.ok(!("gasLeak" in healthSafety));
}

export function aSubmissionThatSkipsALeafIsRefusedWithEveryProblemNamed(): void {
  const request = buildReviewRequest(draft, transcript, valuesSchema);

  const decisions = acceptAll();
  delete decisions["notes"];
  // An unexpected path is refused just as loudly — a UI and its schema cannot
  // silently disagree about what the field set is.
  decisions["healhtSafety.ambientCo"] = { status: "accepted" };

  try {
    resolveReview(request, { status: "submitted", decisions });
    assert.fail("expected ReviewValidationError");
  } catch (error) {
    assert.ok(error instanceof ReviewValidationError);
    const paths = error.issues.map((issue) => issue.path);
    assert.ok(paths.includes("notes"), "the missed leaf is named");
    assert.ok(paths.includes("healhtSafety.ambientCo"), "the unexpected path is named");
  }
}

export function anEditedValueMustParseAgainstItsOwnLeafSchema(): void {
  const request = buildReviewRequest(draft, transcript, valuesSchema);

  const decisions = acceptAll();
  // "thirty" is not a number: the leaf's own schema refuses it at review time,
  // while the reviewer is still looking, not later at a dead queue row.
  decisions["rValue"] = { status: "edited", value: "thirty" };
  try {
    resolveReview(request, { status: "submitted", decisions });
    assert.fail("expected ReviewValidationError");
  } catch (error) {
    assert.ok(error instanceof ReviewValidationError);
    assert.match(error.issues[0]?.message ?? "", /not valid for this field/);
  }

  // Editing to null is the positive assertion that there is nothing to record
  // — distinct from rejecting, which leaves the field untouched.
  const nulled = acceptAll();
  nulled["notes"] = { status: "edited", value: null };
  const outcome: ReviewOutcome = resolveReview(request, { status: "submitted", decisions: nulled });
  assert.ok(outcome.status === "edited");
  assert.equal(outcome.fields.notes, null);
}

export function theOutcomeIsValidatedAgainstThePersistedSchema(): void {
  const request = buildReviewRequest(draft, transcript, valuesSchema);
  const outcome = resolveReview(request, { status: "submitted", decisions: acceptAll() });

  // The same schema the storage layer parses the outcome through — the
  // round trip a session's `reviewOutcome` takes.
  assert.ok(outcome.status !== "discarded");
  const parsed = reviewOutcomeSchema.parse(outcome);
  assert.equal(parsed.status, "accepted");
}

export function contradictionMatcherVetoesAndNeverSaysSame(): void {
  // #region contradiction
  const matcher = contradictionMatcher({ hvac: ["fuel"] });
  const captured = {
    group: "hvac",
    leaves: { fuel: { value: "Gas", sourceSpan: "gas furnace" } },
  };
  const existing = {
    group: "hvac",
    leaves: { fuel: { value: "Oil", sourceSpan: null } },
  };
  const agreeing = {
    group: "hvac",
    leaves: { fuel: { value: "Gas", sourceSpan: null } },
  };
  const verdict = matcher(captured, existing);
  // #endregion contradiction

  // A contradiction on an identifying field is the one thing evidence can settle.
  assert.equal(verdict, "different");
  // Agreement is NEVER "same" — an upstairs and a downstairs Lennox of the same
  // model year agree on every field and are two records. Saying "same" needs
  // positive evidence core cannot possess, so it is always host judgement.
  assert.equal(matcher(captured, agreeing), "unknown");
  assert.equal(matcher(captured, { group: "site", leaves: {} }), "different");
}

export function aSubmissionCarryingInstanceLinksResolvesToLinkTargets(): void {
  // A collection group with one captured instance, and one existing record to
  // link it against.
  const populated = {
    ...draft,
    hvac: [{ fuel: { value: "Gas", confidence: 1, sourceSpan: "gas furnace" } }],
  };
  const request = buildReviewRequest(populated, transcript, valuesSchema, {
    existingRecords: { hvac: [{ uuid: "rec-existing", fields: { fuel: "Gas" } }] },
  });

  const decisions: Record<string, FieldDecision> = {
    ...acceptAll(),
    "hvac[k1].fuel": { status: "accepted" },
  };
  const submission: ReviewSubmission = {
    status: "submitted",
    decisions,
    instanceLinks: { "hvac[k1]": { kind: "link", uuid: "rec-existing" } },
  };
  const outcome = resolveReview(request, submission);

  assert.ok(outcome.status === "accepted");
  // One array per collection group, aligned by position: a string uuid where a
  // human linked, null where the safe default create applies.
  assert.deepEqual(outcome.linkTargets, { hvac: ["rec-existing"] });
}
