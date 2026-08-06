import { z } from "zod";

import { isSpanGrounded } from "./provenance.js";
import type { Extracted } from "./provenance.js";
import type { Transcript } from "./transcript.js";

/**
 * @file Human review of an extraction draft, one field at a time.
 *
 * `F` throughout is the host tool's field set — the same `F` as
 * `ToolAdapter<F, C>`.
 *
 * ## Why this is not `present(draft: T): Promise<T | null>`
 *
 * That signature was rejected in review as too thin. It is single-shot and
 * all-or-nothing: the auditor either takes the whole draft or throws it away,
 * and the caller learns nothing about what happened in between. The product UX
 * is the opposite — the auditor works field by field, reading the transcript
 * quote that justifies each value, and accepts, corrects or drops each one on
 * its own. `T | null` cannot express "accepted, but I fixed the R-value", which
 * is the single most common outcome and the only one that tells us anything
 * about extraction quality in the field.
 *
 * So the contract is in three parts:
 *
 *   1. {@link ReviewRequest} — what the presenter is *shown*: every field's
 *      provenance envelope plus a computed {@link ReviewField.isGrounded} flag.
 *   2. {@link ReviewSubmission} — what the presenter *returns*: an explicit
 *      {@link FieldDecision} per field, or a discard.
 *   3. {@link ReviewOutcome} — what the caller *acts on*: a discriminated union
 *      distinguishing accepted-as-is from accepted-with-edits from discarded,
 *      computed from the submission by {@link resolveReview}.
 *
 * Splitting 2 from 3 is deliberate. A UI can only be trusted to report what the
 * human did; deciding what that *means* — was this draft touched at all, which
 * fields were touched — is classification logic that must be identical for every
 * presenter, so it lives here as a pure function rather than in each UI.
 *
 * ## Flagging is span-groundedness, never confidence
 *
 * {@link ReviewField.isGrounded} is the flag a presenter should surface. It is
 * {@link isSpanGrounded} evaluated against the transcript: did the model quote
 * something the auditor actually said? `confidence` is carried through in the
 * envelope but must not drive flagging — the extraction spike returned ~1.0 on
 * all 168 slots, so a threshold against it flags nothing while reading like an
 * all-clear. See the warning in `provenance.ts`.
 *
 * ## Presentation-agnostic
 *
 * Nothing here knows about React, the DOM, or rendering at all. `ribo-ui-react`
 * implements {@link ReviewPresenter} in Phase 5; a CLI, a test double or an
 * auto-accept policy implement the same interface just as well.
 */

/** One extraction draft: every field of `F`, each in its provenance envelope. */
export type ExtractedFields<F> = { readonly [K in keyof F]: Extracted<F[K]> };

/**
 * One field as the presenter sees it: the model's answer, its justification,
 * and whether that justification checks out.
 */
export interface ReviewField<T> {
  /** The full envelope — `value`, `confidence` and the `sourceSpan` to display. */
  readonly extracted: Extracted<T>;
  /**
   * Is `extracted.sourceSpan` a verbatim quote from the transcript?
   *
   * Precomputed rather than left to the presenter so that every UI flags the
   * same thing the same way, and so a presenter never needs to re-implement
   * {@link isSpanGrounded}. `false` means the quote was never said: show it as
   * unverified. This is the *only* automatic flag in the contract.
   */
  readonly isGrounded: boolean;
}

/** Every field of `F`, prepared for review. */
export type ReviewFields<F> = { readonly [K in keyof F]: ReviewField<F[K]> };

/** What a {@link ReviewPresenter} is shown. */
export interface ReviewRequest<F> {
  /** The transcript the draft came from — the auditor's own words, for context. */
  readonly transcript: Transcript;
  /** Every field, with its provenance and grounded flag. */
  readonly fields: ReviewFields<F>;
}

/**
 * What the human did to one field.
 *
 * `rejected` and `edited` with `value: null` are different things and both are
 * needed: rejecting drops the field from the result entirely (do not write it),
 * while editing to `null` is a positive assertion that there is nothing to
 * record here — the same distinction the extraction envelope draws between an
 * absent key and an explicit `null`.
 */
export type FieldDecision<T> =
  | { readonly status: "accepted" }
  | { readonly status: "edited"; readonly value: T | null }
  | { readonly status: "rejected" };

/**
 * A verdict for every field. Not `Partial` on purpose: a field with no decision
 * is indistinguishable from a field the reviewer never saw, and "I did not look
 * at it" must not silently mean "accepted".
 */
export type FieldDecisions<F> = { readonly [K in keyof F]: FieldDecision<F[K]> };

/** What a {@link ReviewPresenter} returns. */
export type ReviewSubmission<F> =
  | { readonly status: "submitted"; readonly decisions: FieldDecisions<F> }
  | { readonly status: "discarded"; readonly reason?: string };

/**
 * Shows an extraction draft to a human and reports back what they decided.
 *
 * `present` is a function *property*, not a method: TypeScript checks method
 * parameters bivariantly, which would let a `ReviewPresenter<Richer>` stand in
 * where a `ReviewPresenter<Fields>` is expected and read a field off a request
 * that has none. The property form gets strict contravariance.
 * `review.test.ts` pins this down with `@ts-expect-error`.
 */
export interface ReviewPresenter<F> {
  present: (request: ReviewRequest<F>) => Promise<ReviewSubmission<F>>;
}

/**
 * The values review settled on.
 *
 * Still nullable: a field can legitimately end up `null`. Narrowing that to a
 * non-null `F` is the adapter's job — `ToolAdapter.schema.parse` is the trust
 * boundary, and it is the thing that decides whether a null is acceptable.
 */
export type ReviewedValues<F> = { readonly [K in keyof F]: F[K] | null };

/**
 * The result of a review, as a discriminated union.
 *
 *   - `accepted` — every field taken as extracted. `fields` is complete, and
 *     the human changed nothing. This is the case worth counting: it is the
 *     extraction's hit rate under a real auditor.
 *   - `edited` — at least one field was corrected or dropped. `fields` is
 *     partial because rejected fields are omitted, and `editedFields` /
 *     `rejectedFields` name exactly what the human touched.
 *   - `discarded` — the draft is not going anywhere. No fields, by construction.
 */
export type ReviewOutcome<F> =
  | { readonly status: "accepted"; readonly fields: ReviewedValues<F> }
  | {
      readonly status: "edited";
      /** Accepted and edited values. Rejected fields are absent, not `null`. */
      readonly fields: Partial<ReviewedValues<F>>;
      /** Fields the human changed the value of, in field order. */
      readonly editedFields: readonly (keyof F)[];
      /** Fields the human dropped, in field order. */
      readonly rejectedFields: readonly (keyof F)[];
    }
  | { readonly status: "discarded"; readonly reason?: string };

/**
 * Prepares an extraction draft for review: attaches the transcript and computes
 * each field's grounded flag.
 *
 * Pure — no I/O. The grounded check runs against `transcript.text`, which is
 * exactly the text the extractor saw, so a span that fails here was invented.
 */
export const buildReviewRequest = <F extends Record<string, unknown>>(
  extracted: ExtractedFields<F>,
  transcript: Transcript,
): ReviewRequest<F> => {
  const fields: Record<string, ReviewField<unknown>> = {};

  for (const [name, envelope] of Object.entries(extracted) as [string, Extracted<unknown>][]) {
    fields[name] = {
      extracted: envelope,
      isGrounded: isSpanGrounded(envelope.sourceSpan, transcript.text),
    };
  }

  // The loop builds exactly one ReviewField per key of F; the assertion carries
  // that back into the type, which a per-key loop cannot express on its own.
  return { transcript, fields: fields as ReviewFields<F> };
};

/**
 * Turns a presenter's per-field decisions into a single {@link ReviewOutcome}.
 *
 * Pure, and the only place "was this draft edited?" is decided, so every
 * presenter classifies the same way.
 *
 * Two rules that are choices, not accidents:
 *
 *   - An edit whose value equals the extracted one still counts as `edited`.
 *     The signal we want is *what the human touched*, not whether the bytes
 *     changed; comparing values would silently under-report review effort (and
 *     over-report extraction accuracy) for exactly the fields someone stopped
 *     to check.
 *   - Rejecting every field yields `edited` with no fields, not `discarded`.
 *     Discarding is a statement about the recording; rejecting every field is a
 *     statement about the extraction. Collapsing them would lose that.
 *
 * Iteration follows the request's field order, so `editedFields` and
 * `rejectedFields` are stable. Decisions for keys not in the request are
 * ignored — the request defines the field set.
 */
export const resolveReview = <F extends Record<string, unknown>>(
  request: ReviewRequest<F>,
  submission: ReviewSubmission<F>,
): ReviewOutcome<F> => {
  if (submission.status === "discarded") return submission;

  const fields: Record<string, unknown> = {};
  const editedFields: (keyof F)[] = [];
  const rejectedFields: (keyof F)[] = [];

  for (const name of Object.keys(request.fields) as (keyof F & string)[]) {
    const decision = submission.decisions[name];
    switch (decision.status) {
      case "accepted":
        fields[name] = request.fields[name].extracted.value;
        break;
      case "edited":
        fields[name] = decision.value;
        editedFields.push(name);
        break;
      case "rejected":
        rejectedFields.push(name);
        break;
    }
  }

  if (editedFields.length === 0 && rejectedFields.length === 0) {
    return { status: "accepted", fields: fields as ReviewedValues<F> };
  }
  return {
    status: "edited",
    fields: fields as Partial<ReviewedValues<F>>,
    editedFields,
    rejectedFields,
  };
};

/**
 * The **persisted** mirror of {@link ReviewOutcome} — loose, because the outbox
 * document schema cannot be generic in `F`.
 *
 * Same reasoning as `extracted` in `queue/schema.ts`: one document schema
 * describes every host tool's field set, so the typed `ReviewOutcome<F>` lives at
 * the hook boundary and erases to this on the way to disk. `queue/schema.ts`
 * imports it from here rather than redeclaring it, so the concept has one owner.
 *
 * Strict objects on each branch: an `edited` outcome that lost `editedFields` is
 * indistinguishable from `accepted`, and silently under-reporting review effort is
 * exactly the failure `resolveReview`'s doc comment refuses.
 */
export const reviewOutcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("accepted"),
    fields: z.record(z.string(), z.unknown()),
  }),
  z.strictObject({
    status: z.literal("edited"),
    fields: z.record(z.string(), z.unknown()),
    editedFields: z.array(z.string()),
    rejectedFields: z.array(z.string()),
  }),
  z.strictObject({
    status: z.literal("discarded"),
    reason: z.string().optional(),
  }),
]);

/** The persisted, field-set-agnostic outcome. `ReviewOutcome<F>` is the typed form. */
export type PersistedReviewOutcome = z.infer<typeof reviewOutcomeSchema>;
