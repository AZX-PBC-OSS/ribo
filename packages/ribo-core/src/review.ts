import { z } from "zod";

import { childPath, stripOptionalNullable } from "./field-path.js";
import { isSpanGrounded } from "./provenance.js";
import type { Extracted } from "./provenance.js";
import type { Transcript } from "./transcript.js";

/**
 * @file Human review of an extraction draft, one **leaf** at a time.
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
 *   1. {@link ReviewRequest} — what the human is *shown*: every leaf's provenance
 *      envelope, a computed {@link ReviewField.isGrounded} flag, and that leaf's
 *      own value schema.
 *   2. {@link ReviewSubmission} — what the human *reports back*: an explicit
 *      {@link FieldDecision} per leaf path, or a discard.
 *   3. {@link ReviewOutcome} — what the caller *acts on*: a discriminated union
 *      distinguishing accepted-as-is from accepted-with-edits from discarded,
 *      computed from the submission by {@link resolveReview}.
 *
 * Splitting 2 from 3 is deliberate. A UI can only be trusted to report what the
 * human did; deciding what that *means* — was this draft touched at all, which
 * fields were touched — is classification logic that must be identical no
 * matter which UI produced the submission, so it lives here as a pure function
 * rather than in each UI.
 *
 * ## Review addresses flat dotted leaf paths, not top-level keys
 *
 * The same argument, one level down. An adapter's field set is not flat: Snugg Pro
 * declares 23 top-level fields **plus** a `healthSafety` matrix of 11 named tests.
 * Mapping review over top-level keys would give that matrix a single provenance
 * envelope and a single verdict for all 11 — so an auditor could not accept the
 * ambient-CO result while correcting the asbestos one, which is the entire point of
 * field-level review. So review addresses **leaves**, by dotted path
 * (`"healthSafety.ambientCo"`), and Snugg Pro presents 34 of them.
 *
 * Three consequences, each of which is a property this file establishes:
 *
 *   - **The schema enumerates the leaves, not the data.** {@link buildReviewRequest}
 *     walks the adapter's *values* schema and looks each leaf up in the extracted
 *     data — never the reverse. A leaf the model omitted entirely is still presented,
 *     carrying the sentinel envelope `{ value: null, confidence: 0, sourceSpan: null }`.
 *     Enumerating the data instead would make an omitted field vanish from the review
 *     card, which is indistinguishable to the auditor from a field that was extracted
 *     correctly and is exactly the silence the provenance envelope exists to forbid.
 *   - **Each leaf carries its own value schema** ({@link ReviewField.schema}), so a UI
 *     can render an editor and validate an edit knowing nothing about any adapter. A
 *     TypeScript type cannot tell a UI an enum's members at runtime; a zod schema can,
 *     which is why the schema — not the type — is the authority here and why the values
 *     in this file are `unknown`.
 *   - **Validation happens at submit** ({@link resolveReview}), not only at write. See
 *     that function's notes.
 *
 * ## Flagging is span-groundedness, never confidence
 *
 * {@link ReviewField.isGrounded} is the flag a UI should surface. It is
 * {@link isSpanGrounded} evaluated against the transcript: did the model quote
 * something the auditor actually said? `confidence` is carried through in the
 * envelope but must not drive flagging — the extraction spike returned ~1.0 on
 * all 168 slots, so a threshold against it flags nothing while reading like an
 * all-clear. See the warning in `provenance.ts`.
 *
 * ## Review is a queue state, not a callback
 *
 * The gate is a status, not a presenter. `queue/relay.ts` parks an extracted item
 * at `awaiting-review` — a status deliberately absent from
 * `ACTIVE_OUTBOX_STATUSES` — and stops seeing it; the relay drains the next
 * capture instead of blocking. A UI finds parked items with an ordinary query
 * (`outbox.watch({ status: "awaiting-review" })`), and `Outbox.submitReview`
 * records the outcome and moves the item to `writing`.
 *
 * An earlier design had the relay `await` a `ReviewPresenter.present(request)`
 * promise the UI resolved. It was removed rather than kept unused: the relay
 * processes strictly ascending `seq`, so a step blocked on a human stalls every
 * recording behind it, and a reload mid-await drops the promise with nothing left
 * to resolve. Persisting the decision is what makes review survive the tab dying,
 * which on iOS it does often.
 *
 * So what remains here is the *vocabulary*, not an invocation protocol:
 * {@link buildReviewRequest} prepares a draft, {@link resolveReview} classifies
 * what the human did, and {@link reviewOutcomeSchema} is how the answer is stored.
 * Nothing here knows about React, the DOM, or rendering.
 */

/** One extraction draft: every field of `F`, each in its provenance envelope. */
export type ExtractedFields<F> = { readonly [K in keyof F]: Extracted<F[K]> };

/**
 * A leaf's address inside an adapter's values schema: `"atticRValue"` for a
 * top-level leaf, `"healthSafety.ambientCo"` for a nested one.
 *
 * A bare `string` rather than a template-literal type computed from the schema.
 * Typed leaf paths would catch a typo at compile time, but they sit *on top of*
 * the runtime mechanism rather than replacing it — a UI still has to look the
 * path up in a `Record` at runtime, and completeness still has to be checked
 * there ({@link resolveReview}). Purely additive later.
 */
export type FieldPath = string;

/**
 * One leaf as the human sees it: the model's answer, its justification, whether
 * that justification checks out, and what a legal value for it looks like.
 */
export interface ReviewField {
  /** The full envelope — `value`, `confidence` and the `sourceSpan` to display. */
  readonly extracted: Extracted<unknown>;
  /**
   * Is `extracted.sourceSpan` a verbatim quote from the transcript?
   *
   * Precomputed rather than left to the UI so that every UI flags the
   * same thing the same way, and so a UI never needs to re-implement
   * {@link isSpanGrounded}. `false` means the quote was never said: show it as
   * unverified. This is the *only* automatic flag in the contract.
   */
  readonly isGrounded: boolean;
  /**
   * This leaf's VALUE schema, exactly as the adapter declared it — for rendering
   * an editor and for validating an edit.
   *
   * The patch's `.nullable().optional()` wrappers are kept rather than stripped,
   * and that is load-bearing twice over: `null` is a legal reviewed value (an
   * explicit "there is nothing to record here", distinct from rejecting the leaf),
   * and the sentinel envelope for an omitted leaf carries `value: null`, so
   * accepting an omitted leaf must parse.
   */
  readonly schema: z.ZodType<unknown>;
}

/**
 * Every leaf of the adapter's values schema, prepared for review, keyed by dotted path.
 *
 * **Insertion order is schema-declaration order, and is part of the contract.** The
 * walk visits the shape's keys in declaration order and recurses into a nested object
 * at the position of its own key, so `healthSafety`'s 11 tests appear together, where
 * the schema author put them. A UI that maps over `Object.keys(fields)` therefore
 * renders the same order on every mount, and {@link resolveReview}'s `editedFields` /
 * `rejectedFields` follow the same order. This is deliberately *not* sorted: sorting
 * would discard the grouping the adapter author chose, and 34 fields in an order nobody
 * picked is worse than 34 fields in theirs. `field-path.ts` refuses the one key shape
 * that would break the guarantee.
 */
export type ReviewFields = Readonly<Record<FieldPath, ReviewField>>;

/** What a human reviewer is shown. */
export interface ReviewRequest {
  /** The transcript the draft came from — the auditor's own words, for context. */
  readonly transcript: Transcript;
  /** Every leaf, by dotted path, with its provenance, grounded flag and schema. */
  readonly fields: ReviewFields;
}

/**
 * What the human did to one leaf.
 *
 * `rejected` and `edited` with `value: null` are different things and both are
 * needed: rejecting drops the leaf from the result entirely (do not write it),
 * while editing to `null` is a positive assertion that there is nothing to
 * record here — the same distinction the extraction envelope draws between an
 * absent key and an explicit `null`, and the same one the patch draws between an
 * absent key ("leave this field alone") and a written `null` ("write it empty").
 *
 * `value` is `unknown`, not a type parameter. The leaf's type is not knowable at
 * this boundary — a `Record<FieldPath, …>` has one value type for 34 differently
 * typed leaves — so the check that an edit is legal moved from the compiler to
 * {@link ReviewField.schema}, applied by {@link resolveReview}. That is a real
 * trade and it is why validation-at-submit exists rather than being optional.
 */
export type FieldDecision =
  | { readonly status: "accepted" }
  | { readonly status: "edited"; readonly value: unknown }
  | { readonly status: "rejected" };

/**
 * A verdict for every leaf, keyed by dotted path.
 *
 * This was a mapped type over `F`, and being non-`Partial` was the point: a field
 * with no decision is indistinguishable from a field the reviewer never saw, and
 * "I did not look at it" must not silently mean "accepted". A string-keyed record
 * cannot carry that — it accepts `{}` — so {@link resolveReview} enforces it at
 * runtime instead, by comparing this key set against the request's.
 */
export type FieldDecisions = Readonly<Record<FieldPath, FieldDecision>>;

/** What a human reviewer reports back. */
export type ReviewSubmission =
  | { readonly status: "submitted"; readonly decisions: FieldDecisions }
  | { readonly status: "discarded"; readonly reason?: string };

/**
 * The result of a review, as a discriminated union.
 *
 *   - `accepted` — every leaf taken as extracted. `fields` is complete, and
 *     the human changed nothing. This is the case worth counting: it is the
 *     extraction's hit rate under a real auditor.
 *   - `edited` — at least one leaf was corrected or dropped. `fields` is
 *     partial because rejected leaves are omitted, and `editedFields` /
 *     `rejectedFields` name exactly what the human touched, by dotted path.
 *   - `discarded` — the draft is not going anywhere. No fields, by construction.
 *
 * `fields` is the reassembled **nested** object — `{ healthSafety: { ambientCo } }`,
 * never `{ "healthSafety.ambientCo" }` — because that is the shape the adapter's
 * patch schema describes and the shape `write` sends. It is deliberately untyped
 * here: `ToolAdapter.schema.parse` at the write step is what turns it into `V`, and
 * that is the trust boundary. Carrying a `V` through review would mean either
 * trusting a UI's `unknown` edit as a `V[K]`, or a recursive mapped type whose
 * mismatch anywhere reports against the whole tree.
 */
export type ReviewOutcome =
  | { readonly status: "accepted"; readonly fields: Record<string, unknown> }
  | {
      readonly status: "edited";
      /** Accepted and edited values, nested. Rejected leaves are absent, not `null`. */
      readonly fields: Record<string, unknown>;
      /** Leaf paths the human changed the value of, in schema-declaration order. */
      readonly editedFields: readonly FieldPath[];
      /** Leaf paths the human dropped, in schema-declaration order. */
      readonly rejectedFields: readonly FieldPath[];
    }
  | { readonly status: "discarded"; readonly reason?: string };

/** One thing wrong with a submission, addressed to the leaf it is wrong at. */
export interface ReviewIssue {
  /** The leaf path this is about. */
  readonly path: FieldPath;
  /** What is wrong with it, in a form a UI can show beside that leaf's editor. */
  readonly message: string;
}

/**
 * A submission {@link resolveReview} refused: the wrong set of leaves, or a value
 * its leaf's schema rejects.
 *
 * **Thrown rather than returned as a fourth {@link ReviewOutcome} branch**, on
 * purpose. The three branches are the *outcomes of a review*, and each one is
 * persisted and acted on; "this submission is malformed" is not an outcome, it is a
 * refusal to produce one. Making it a branch would put it in `reviewOutcomeSchema`
 * and so in the outbox document, where a caller could persist it and advance an item
 * to `writing`. Throwing is what makes "does not persist" structural rather than a
 * convention every caller has to remember.
 *
 * {@link issues} is the actionable half: a UI shows each message beside the leaf its
 * `path` names, while the auditor is still looking at it. That is the whole reason
 * validation happens here instead of only at write time.
 */
export class ReviewValidationError extends Error {
  /** Every problem found, not just the first — a UI can flag them all at once. */
  readonly issues: readonly ReviewIssue[];

  constructor(issues: readonly ReviewIssue[]) {
    super(
      `review submission rejected: ${issues.map(({ path, message }) => `${path}: ${message}`).join("; ")}`,
    );
    this.name = "ReviewValidationError";
    this.issues = issues;
  }
}

/**
 * The envelope shape as read back from extracted data, kept separate from
 * `extractedSchema(inner)` because this side must not care what the leaf's type is:
 * `buildReviewRequest` presents whatever the model produced and lets the human judge
 * it, and it is {@link resolveReview} that parses a *submitted* value against the
 * leaf's real schema. Non-strict, so an envelope carrying an extra key still reads.
 */
const envelopeSchema = z.object({
  value: z.unknown(),
  confidence: z.number(),
  sourceSpan: z.string().nullable(),
});

/**
 * The envelope a leaf gets when the extracted data has nothing usable at its path.
 *
 * Fully specified rather than partial: `Extracted` requires a `confidence`, and `0` is
 * the honest number — nothing was extracted, so there is nothing to be confident about.
 * A fresh object each call because `Extracted<T>` is inferred from a zod schema and so
 * is mutable; one shared instance across 34 leaves would let a caller's mutation of one
 * card rewrite the rest.
 */
const omittedLeaf = (): Extracted<unknown> => ({ value: null, confidence: 0, sourceSpan: null });

/** The child at `key`, or `undefined` if there is no object there to read. */
const readChild = (node: unknown, key: string): unknown =>
  typeof node === "object" && node !== null ? (node as Record<string, unknown>)[key] : undefined;

/**
 * Read one leaf's envelope out of the extracted data, falling back to the sentinel.
 *
 * The fallback covers both "the model omitted this leaf" and "what is at this path is
 * not an envelope", deliberately as one case: the extraction schema is the boundary
 * that guarantees envelopes, so anything reaching here malformed already failed that
 * parse, and at this layer it is indistinguishable from absence. Presenting the leaf
 * with a sentinel keeps it on the review card either way, which is the property that
 * matters — the auditor sees the field and decides.
 */
const readEnvelope = (node: unknown): Extracted<unknown> => {
  const parsed = envelopeSchema.safeParse(node);
  if (!parsed.success) return omittedLeaf();
  return {
    // `z.unknown()` admits `undefined`; the envelope's own contract says a missing
    // answer is `null`, so normalize rather than leak a second kind of absence.
    value: parsed.data.value ?? null,
    confidence: parsed.data.confidence,
    sourceSpan: parsed.data.sourceSpan,
  };
};

/**
 * Walk one level of the values schema, appending a {@link ReviewField} per leaf.
 *
 * Recursion is on the schema and the data in lockstep, but only the schema decides
 * what exists — `readChild` may hand back `undefined` the whole way down and the
 * leaves still get presented.
 */
const collectFields = (
  values: z.ZodObject,
  prefix: string,
  node: unknown,
  transcript: Transcript,
  out: Record<FieldPath, ReviewField>,
): void => {
  for (const [key, declared] of Object.entries(values.shape) as [string, z.ZodType][]) {
    const path = childPath(prefix, key);
    const stripped = stripOptionalNullable(declared);

    if (stripped instanceof z.ZodObject) {
      collectFields(stripped, path, readChild(node, key), transcript, out);
      continue;
    }

    const extracted = readEnvelope(readChild(node, key));
    out[path] = {
      extracted,
      isGrounded: isSpanGrounded(extracted.sourceSpan, transcript.text),
      // The DECLARED schema, wrappers and all — see `ReviewField.schema`.
      schema: declared,
    };
  }
};

/**
 * Prepares an extraction draft for review: enumerates the leaves, attaches the
 * transcript, and computes each leaf's grounded flag.
 *
 * Pure — no I/O. The grounded check runs against `transcript.text`, which is
 * exactly the text the extractor saw, so a span that fails here was invented.
 *
 * `valuesSchema` is the adapter's **patch** schema (`ToolAdapter.schema`), not its
 * extraction schema, and it is what decides which leaves exist. `extracted` is the
 * model's output, looked up path by path. That direction is the point: a leaf the
 * model never emitted is still shown, with the sentinel envelope, rather than
 * silently missing from the card.
 */
export const buildReviewRequest = (
  extracted: Record<string, unknown>,
  transcript: Transcript,
  valuesSchema: z.ZodObject,
): ReviewRequest => {
  const fields: Record<FieldPath, ReviewField> = {};
  collectFields(valuesSchema, "", extracted, transcript, fields);
  return { transcript, fields };
};

/**
 * Did the submission actually decide `path`?
 *
 * `Object.hasOwn` rather than a bare `!== undefined` index read, so this reads the
 * submission the same way {@link completenessIssues} reports on it: the
 * unexpected-path half enumerates with `Object.keys`, which is own-keys-only, and a
 * prototype-aware read here would make the two halves disagree — a decisions object
 * with `Object.prototype` in its chain would count a leaf named `"toString"` as
 * decided while `Object.keys` never lists it.
 *
 * An own key explicitly set to `undefined` counts as *absent* rather than as a
 * malformed decision, because that is what it means: a UI that has not collected a
 * verdict yet. That is precisely the case `FieldDecisions`-was-not-`Partial` existed
 * to refuse, and "no decision was submitted" is the message that says so.
 */
const hasDecision = (decisions: FieldDecisions, path: FieldPath): boolean =>
  Object.hasOwn(decisions, path) && decisions[path] !== undefined;

/**
 * Every way the submission's leaf set can disagree with the request's.
 *
 * Missing paths are reported in request order and unexpected ones in submission
 * order, so the list reads down the review card. Both directions matter: a missing
 * decision is a leaf the reviewer may never have seen, and an unexpected one means
 * the UI and the schema disagree about what the field set *is* — reading `undefined`
 * and calling it "accepted" would turn either into a silent write.
 */
const completenessIssues = (
  paths: readonly FieldPath[],
  decisions: FieldDecisions,
): ReviewIssue[] =>
  paths
    .filter((path) => !hasDecision(decisions, path))
    .map((path) => ({ path, message: "no decision was submitted for this field" }))
    .concat(
      Object.keys(decisions)
        .filter((path) => !paths.includes(path))
        .map((path) => ({ path, message: "not a field of this review request" })),
    );

/**
 * The verdicts {@link FieldDecision} defines, as data so {@link resolveReview} can
 * refuse anything else at runtime — see the guard there for why the union is not enough.
 */
const DECISION_STATUSES: ReadonlySet<string> = new Set(["accepted", "edited", "rejected"]);

/**
 * Why a value failed its leaf's schema, phrased for the human looking at that leaf.
 *
 * The two cases need different advice, and the `accepted` one is what would otherwise
 * strand an auditor. Design §2.1 makes a patch leaf nullable only "where a null is
 * meaningful", so `.optional()` without `.nullable()` is a legal declaration — but
 * `enveloped()` still derives `value: X.nullable()`, and a leaf the model omitted is
 * presented with the `null` sentinel. Accepting that leaf then fails, and a bare
 * "expected string, received null" tells the auditor nothing about what to do next.
 * Naming the escape — reject it, which leaves the field untouched — is the difference
 * between an actionable error and a stuck submission.
 *
 * Chosen over refusing a non-nullable leaf when the schema is walked. The dot and
 * integer-like guards in `field-path.ts` exist because those failures are *silent*;
 * this one is already loud, just badly worded, and refusing at the walk would force
 * every leaf of every future adapter to accept `null` — making a value writable that
 * its author deliberately made unwritable. Fixing the message keeps the adapter's
 * expressiveness and gives the auditor the correct action, which is that a field with
 * nothing to record and no null to record it as should be rejected.
 */
const invalidValueMessage = (status: "accepted" | "edited", error: z.ZodError): string => {
  const reason = error.issues.map((issue) => issue.message).join("; ");
  return status === "edited"
    ? `edited value is not valid for this field: ${reason}`
    : `the extracted value is not valid for this field (${reason}) — it cannot be accepted ` +
        "as it stands; edit it, or reject the leaf to leave the field untouched";
};

/** Write `value` at a dotted path, creating the objects on the way down. */
const setAtPath = (target: Record<string, unknown>, path: FieldPath, value: unknown): void => {
  const segments = path.split(".");
  const leaf = segments.pop() as string;
  let node = target;
  for (const segment of segments) {
    // A nested group only materializes when one of its leaves survives review, so
    // rejecting all 11 health-safety tests leaves no `healthSafety` key at all —
    // which is what a patch means by "leave this alone".
    node[segment] ??= {};
    node = node[segment] as Record<string, unknown>;
  }
  node[leaf] = value;
};

/**
 * Turns a UI's per-leaf decisions into a single {@link ReviewOutcome}.
 *
 * Pure, and the only place "was this draft edited?" is decided, so every
 * UI classifies the same way.
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
 *     statement about the extraction. Collapsing them would lose that. (The relay
 *     refuses to write an empty field set, so that case stops at the relay guard.)
 *
 * Four things it refuses, each with a {@link ReviewValidationError} naming the leaf:
 *
 *   - **A submission whose leaf set is not the request's** — see
 *     {@link completenessIssues}. This is the guarantee `FieldDecisions` used to get
 *     from the type system for free.
 *   - **A value its leaf's schema rejects.** Without this the schema on
 *     {@link ReviewField} would be decoration: a UI submitting `"thirty"` for a
 *     number would persist, advance the item to `writing`, and only fail there — as
 *     a dead queue row, long after the human who could have fixed it moved on.
 *     `ToolAdapter.schema.parse` at write time stays as the outer boundary; two
 *     checks, deliberately, because the per-leaf one is the one that can say *which*
 *     field and be shown next to it.
 *   - **An `edited` decision carrying `undefined`.** It passes every patch leaf's
 *     schema and then disappears on serialisation, silently turning "the human edited
 *     this" into "leave this field alone". See the guard's own note.
 *   - **A decision whose `status` is none of the three.** The union cannot enforce
 *     that at runtime, and reading an unrecognised status as "accepted" is a silent
 *     write.
 *
 * Both refusals are checked over every leaf before either throws, so a UI gets the
 * whole list rather than one error per round trip.
 *
 * Iteration follows the request's leaf order, which is schema-declaration order
 * ({@link ReviewFields}), so `editedFields` and `rejectedFields` are stable.
 */
export const resolveReview = (
  request: ReviewRequest,
  submission: ReviewSubmission,
): ReviewOutcome => {
  if (submission.status === "discarded") return submission;

  const paths = Object.keys(request.fields);
  const structural = completenessIssues(paths, submission.decisions);
  if (structural.length > 0) throw new ReviewValidationError(structural);

  const fields: Record<string, unknown> = {};
  const editedFields: FieldPath[] = [];
  const rejectedFields: FieldPath[] = [];
  const invalid: ReviewIssue[] = [];

  for (const path of paths) {
    // Both indexes are checked above: `path` came from `request.fields`, and
    // `completenessIssues` proved a decision exists for it.
    const field = request.fields[path] as ReviewField;
    const decision = submission.decisions[path] as FieldDecision;

    // The union says this cannot happen; at runtime it can. A decision may be a
    // hand-built literal or may have crossed a serialisation boundary, and falling
    // through to the accept path would write the model's value with `editedFields`
    // empty — recorded as though a human had endorsed it. That is §2.6's silent write
    // in a second guise, so it is refused rather than interpreted.
    if (!DECISION_STATUSES.has(decision.status)) {
      invalid.push({
        path,
        message:
          `unrecognised decision status ${JSON.stringify(decision.status)} — ` +
          'expected "accepted", "edited" or "rejected"',
      });
      continue;
    }

    if (decision.status === "rejected") {
      rejectedFields.push(path);
      continue;
    }
    if (decision.status === "edited") editedFields.push(path);

    const value = decision.status === "edited" ? decision.value : field.extracted.value;
    const parsed = field.schema.safeParse(value);
    if (!parsed.success) {
      invalid.push({ path, message: invalidValueMessage(decision.status, parsed.error) });
      continue;
    }

    // `undefined` PASSES every patch leaf's schema — each is `.optional()` — and would
    // be written as a present-but-undefined key that vanishes the moment the outcome is
    // serialised. `z.record(z.string(), z.unknown())` keeps it, so the persistence
    // boundary does not catch it either: the leaf reads back ABSENT, which design §2.1
    // defines as "do not touch this field", while `editedFields` still names it as
    // touched. That is the absent-vs-null distinction the patch model rests on, lost
    // silently and indistinguishable downstream from a rejection.
    //
    // A React editor whose state is `undefined` submits exactly this, so it is a live
    // path rather than a theoretical one. Deliberately NOT normalised to `null`: that
    // would write an empty value the human never asked for, and would fail anyway on a
    // leaf that is `.optional()` but not `.nullable()`.
    //
    // Checked on the PARSED value rather than the input, so a schema carrying a
    // transform cannot smuggle one through. Only an `edited` decision can reach here
    // today — `readEnvelope` normalises an extracted value to `null` — hence the wording.
    if (parsed.data === undefined) {
      invalid.push({
        path,
        message:
          "an edited leaf must carry a value or null, not undefined — reject it instead " +
          "to leave the field untouched",
      });
      continue;
    }

    // The PARSED value, not the raw one: the leaf's schema is the authority on what
    // a legal value for it is, so what gets persisted is what it accepted.
    setAtPath(fields, path, parsed.data);
  }

  if (invalid.length > 0) throw new ReviewValidationError(invalid);

  if (editedFields.length === 0 && rejectedFields.length === 0) {
    return { status: "accepted", fields };
  }
  return { status: "edited", fields, editedFields, rejectedFields };
};

/**
 * The **persisted** mirror of {@link ReviewOutcome} — loose, because the outbox
 * document schema cannot be generic in an adapter's field set.
 *
 * Same reasoning as `extracted` in `queue/schema.ts`: one document schema
 * describes every host tool's field set, so the typed `ReviewOutcome` lives at
 * the hook boundary and erases to this on the way to disk. `queue/schema.ts`
 * imports it from here rather than redeclaring it, so the concept has one owner.
 *
 * Nested `fields` and dotted touched-field paths needed **no change here**, which is
 * worth stating because a reader would reasonably expect a document version bump:
 * `z.record(z.string(), z.unknown())` accepts a nested object as readily as a flat
 * one, and `z.array(z.string())` accepts `"healthSafety.ambientCo"` as readily as
 * `"atticRValue"`. `review.test.ts` and `queue/outbox-memory.test.ts` pin that.
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

/** The persisted, field-set-agnostic outcome. `ReviewOutcome` is the typed form. */
export type PersistedReviewOutcome = z.infer<typeof reviewOutcomeSchema>;
