import { z } from "zod";

import { buildFieldPath, parseFieldPath, stripOptionalNullable } from "./field-path.js";
import type { FieldPath, FieldPathSegment } from "./field-path.js";
import type { RequiredOnCreate } from "./adapter.js";
import { describeLocated, zodIssues } from "./zod-issues.js";
import { isSpanGrounded } from "./provenance.js";
import type { Extracted } from "./provenance.js";
import type { Transcript } from "./transcript.js";
import type { ExistingRecord, InstanceLinkDecision, LinkTargets } from "./instance-identity.js";

// `FieldPath` moved to `field-path.js` so `adapter.ts` can use it without the
// adapter contract depending on the review contract. Re-exported here so the
// package surface is unchanged.
export type { FieldPath } from "./field-path.js";

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
 * nests its 51 leaves under seven top-level groups (`basedata`, `hvac`, `attic`,
 * `wall`, `window`, `dhw`, `health`), and the `health` group alone is 14 named
 * tests. Mapping review over top-level keys would give that group a single
 * provenance envelope and a single verdict for all 14 — so an auditor could not
 * accept the ambient-CO result while correcting the gas-leak one, which is the
 * entire point of field-level review. So review addresses **leaves**, by dotted
 * path (`"health.healthGasLeak"`), not group keys.
 *
 * Three consequences, each of which is a property this file establishes:
 *
 *   - **The data determines how many instances exist; the schema determines every leaf
 *     within each instance.** A schema cannot know how many HVAC systems a transcript
 *     described, so instance count is necessarily data-driven. {@link buildReviewRequest}
 *     enumerates the adapter's *values* schema once per instance the data contains, and a leaf
 *     the model omitted from a present instance is still shown with the sentinel envelope
 *     `{ value: null, confidence: 0, sourceSpan: null }`. That preserves the property that
 *     matters: no leaf of a reviewed instance can silently vanish from the card. Only empty
 *     collections themselves have no leaves, and they are recorded separately so a submit
 *     can still distinguish "there are none" from "touch nothing".
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
  /**
   * Does the host tool refuse to CREATE the record without this leaf?
   *
   * Surfaced so a review card can mark the leaf and refuse a submit that leaves
   * it empty — turning a write that would fail at the host into a question the
   * auditor can answer while they are still on site, instead of a dead queue row
   * discovered that evening.
   *
   * Comes from {@link ToolAdapter.requiredOnCreate}, declared per group on the
   * adapter rather than as metadata on the schema. That is deliberate: zod `.meta()`
   * propagates through `enveloped()` into the derived extraction schema and lands
   * in the JSON Schema sent to the model, and an unknown keyword is exactly what
   * strict structured-output mode rejects. A per-group shape also expresses N
   * instances: the same leaf is required on every instance of its collection group
   * without the adapter enumerating keyed paths it cannot know before extraction.
   *
   * `false` when the adapter declares nothing — absence of a claim, not a claim
   * of absence.
   */
  readonly required: boolean;
}

/**
 * Every leaf of the adapter's values schema, prepared for review, keyed by path.
 * Paths are dotted for nested objects (`health.healthGasLeak`) and bracketed for
 * array instances (`hvac[k1].hvacSystemEquipmentType`), constructed by
 * {@link buildFieldPath} so construction and parsing never diverge.
 *
 * **Insertion order is schema-declaration order within each instance, and is part of the
 * contract.** The walk visits the shape's keys in declaration order and recurses into a
 * nested object at the position of its own key, so Snugg Pro's `health` group's 14 tests
 * appear together, where the schema author put them. A UI that maps over `Object.keys(fields)`
 * therefore renders the same order on every mount, and {@link resolveReview}'s
 * `editedFields` / `rejectedFields` follow the same order. This is deliberately *not*
 * sorted: sorting would discard the grouping the schema author chose, and 51 fields in
 * an order nobody picked is worse than 51 fields in theirs. `field-path.ts` refuses the
 * one key shape that would break the guarantee.
 */
export type ReviewFields = Readonly<Record<FieldPath, ReviewField>>;

/**
 * Whether a collection group has instances, has none, or was never mentioned.
 *
 * `hvac: []` and an absent `hvac` are opposite write instructions — "there are none of
 * these" against "touch nothing" — and the difference is invisible once per-leaf decisions
 * are collected, because neither produces a leaf. It used to be recoverable only by
 * cross-referencing {@link ReviewRequest.fields} against a separate list of empty groups,
 * which is a three-state fact split across two collections and a bug every host got to
 * write independently. It is one field now.
 */
export type ReviewGroupState = "absent" | "empty" | "populated";

/** A reviewable leaf, in the position the schema declared it. */
export interface ReviewLeafNode {
  readonly kind: "leaf";
  /** The schema key at this level — `"rValue"`, not the full path. */
  readonly key: string;
  readonly path: FieldPath;
  /**
   * The same object {@link ReviewRequest.fields} holds under `path`, not a copy. The tree
   * is a second view of one source; a leaf that could differ between them would be two.
   */
  readonly field: ReviewField;
}

/** A nested object group — `healthSafety` and its tests, in one place. */
export interface ReviewObjectNode {
  readonly kind: "object";
  readonly key: string;
  readonly path: FieldPath;
  readonly children: readonly ReviewNode[];
}

/** One instance of a collection group, addressed by the key review already assigns it. */
export interface ReviewInstanceNode {
  /** `k1`, `k2`, … — the same instance keys the flat paths carry. */
  readonly key: string;
  /** `hvac[k1]` — the instance's own path, which is what link decisions are keyed by. */
  readonly path: FieldPath;
  readonly children: readonly ReviewNode[];
}

/** A collection group — a house with two HVAC systems has two instances here. */
export interface ReviewCollectionNode {
  readonly kind: "collection";
  readonly key: string;
  readonly path: FieldPath;
  readonly state: ReviewGroupState;
  /** Empty for both `absent` and `empty`; `state` is what tells those apart. */
  readonly instances: readonly ReviewInstanceNode[];
}

export type ReviewNode = ReviewLeafNode | ReviewObjectNode | ReviewCollectionNode;

/** What a human reviewer is shown. */
export interface ReviewRequest {
  /** The transcript the draft came from — the auditor's own words, for context. */
  readonly transcript: Transcript;
  /** Every leaf, by path, with its provenance, grounded flag and schema. */
  readonly fields: ReviewFields;
  /**
   * The same leaves as {@link fields}, in the shape the schema walk saw them: groups, their
   * instances, and their leaves, in declaration order.
   *
   * `fields` encodes structure in the path text, so every host rebuilt this with
   * `parseFieldPath` — three review models doing the same parse, each free to get instance
   * keys or nesting subtly wrong. {@link collectFields} has the structure in hand while it
   * descends and used to throw it away.
   *
   * **A second view, never a second source.** A leaf lives once, in `fields`; the tree holds
   * the same object. `resolveReview` is still path-keyed, and `fields`' insertion order is
   * still the contract — the tree is built by the same walk in the same order, so the two
   * agree by construction rather than by discipline.
   */
  readonly tree: readonly ReviewNode[];
  /**
   * Existing records of each collection group, keyed by the group path (e.g. `"hvac"`).
   *
   * These enter at the review boundary, after extraction, so a model can never be handed
   * them at extraction time. They are surfaced for a human to link against, and the safe
   * default is always to create a new record.
   */
  readonly existingRecords: Readonly<Record<string, readonly ExistingRecord[]>>;
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
 * this boundary — a `Record<FieldPath, …>` has one value type for 51 differently
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
  | {
      readonly status: "submitted";
      readonly decisions: FieldDecisions;
      /**
       * Per-instance link decisions, keyed by the instance path (e.g. `"hvac[k1]"`).
       *
       * Absent means the safe default: create a new record. A link is only valid when
       * the human explicitly made the decision; {@link resolveReview} rejects an
       * unknown instance path, and a missing decision always resolves to a create.
       */
      readonly instanceLinks?: Readonly<Record<string, InstanceLinkDecision>>;
    }
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
 * `fields` is the reassembled **nested** object — `{ health: { healthGasLeak } }`,
 * never `{ "health.healthGasLeak" }` — because that is the shape the adapter's
 * patch schema describes and the shape `write` sends. It is deliberately untyped
 * here: `ToolAdapter.schema.parse` at the write step is what turns it into `V`, and
 * that is the trust boundary. Carrying a `V` through review would mean either
 * trusting a UI's `unknown` edit as a `V[K]`, or a recursive mapped type whose
 * mismatch anywhere reports against the whole tree.
 */
export type ReviewOutcome =
  | {
      readonly status: "accepted";
      readonly fields: Record<string, unknown>;
      /**
       * Which resolved collection instances update an existing record (`string` uuid)
       * and which create a new one (`null`). Absent when no collection groups survived
       * review, so callers can treat it as optional rather than an empty object.
       */
      readonly linkTargets?: LinkTargets;
    }
  | {
      readonly status: "edited";
      /** Accepted and edited values, nested. Rejected leaves are absent, not `null`. */
      readonly fields: Record<string, unknown>;
      /** Leaf paths the human changed the value of, in schema-declaration order. */
      readonly editedFields: readonly FieldPath[];
      /** Leaf paths the human dropped, in schema-declaration order. */
      readonly rejectedFields: readonly FieldPath[];
      /**
       * Which resolved collection instances update an existing record (`string` uuid)
       * and which create a new one (`null`). Absent when no collection groups survived
       * review.
       */
      readonly linkTargets?: LinkTargets;
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
    super(`review submission rejected: ${describeLocated(issues)}`);
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
 * is mutable; one shared instance across 51 leaves would let a caller's mutation of one
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
 * what leaves exist — `readChild` may hand back `undefined` the whole way down and
 * the leaves still get presented. For array groups the data decides how many
 * instances exist: each element is assigned a stable key (`k1`, `k2`, …) and the
 * element schema is walked once per instance, producing bracketed paths like
 * `hvac[k1].hvacSystemEquipmentType`. Order is the order the data emits the
 * instances in; the key is what keeps a decision attached to the same instance if
 * the UI removes one later.
 */
const collectFields = (
  values: z.ZodObject,
  prefixSegments: readonly FieldPathSegment[],
  node: unknown,
  transcript: Transcript,
  requiredOnCreate: RequiredOnCreate,
  out: Record<FieldPath, ReviewField>,
  nodes: ReviewNode[],
): void => {
  for (const [key, declared] of Object.entries(values.shape) as [string, z.ZodType][]) {
    const pathSegments: readonly FieldPathSegment[] = [
      ...prefixSegments,
      { kind: "objectKey", key },
    ];
    const path = buildFieldPath(pathSegments);
    const stripped = stripOptionalNullable(declared);

    if (stripped instanceof z.ZodObject) {
      const children: ReviewNode[] = [];
      collectFields(
        stripped,
        pathSegments,
        readChild(node, key),
        transcript,
        requiredOnCreate,
        out,
        children,
      );
      nodes.push({ kind: "object", key, path, children });
      continue;
    }

    if (stripped instanceof z.ZodArray) {
      // zod 4's `ZodArray.element` is typed as the core `$ZodType`; every schema in this
      // codebase is built through the classic API, so the cast reflects the actual value.
      const elementSchema = stripOptionalNullable(stripped.element as z.ZodType);
      if (!(elementSchema instanceof z.ZodObject)) {
        throw new Error(
          `review cannot walk array at "${path}" — its element is not a plain object, ` +
            "so there are no leaf fields to review per instance.",
        );
      }
      const arrayNode = readChild(node, key);
      const elements = Array.isArray(arrayNode) ? arrayNode : [];
      // Absent and empty are opposite write instructions and neither produces a leaf, so
      // the state has to be read here, where the raw extraction is still in view.
      const state: ReviewGroupState =
        arrayNode === undefined || !Array.isArray(arrayNode)
          ? "absent"
          : elements.length === 0
            ? "empty"
            : "populated";
      const instances: ReviewInstanceNode[] = [];
      for (let i = 0; i < elements.length; i++) {
        const instanceKey = `k${i + 1}`;
        const instanceSegments: readonly FieldPathSegment[] = [
          ...pathSegments,
          { kind: "instanceKey", key: instanceKey },
        ];
        const children: ReviewNode[] = [];
        collectFields(
          elementSchema,
          instanceSegments,
          elements[i],
          transcript,
          requiredOnCreate,
          out,
          children,
        );
        instances.push({
          key: instanceKey,
          path: buildFieldPath(instanceSegments),
          children,
        });
      }
      nodes.push({ kind: "collection", key, path, state, instances });
      continue;
    }

    const groupPath = pathSegments[0]?.key ?? "";
    const extracted = readEnvelope(readChild(node, key));
    const requiredLeaves = requiredOnCreate[groupPath];
    const field: ReviewField = {
      extracted,
      isGrounded: isSpanGrounded(extracted.sourceSpan, transcript.text),
      // The DECLARED schema, wrappers and all — see `ReviewField.schema`.
      schema: declared,
      required: Array.isArray(requiredLeaves) && requiredLeaves.includes(key),
    };
    out[path] = field;
    // The same object, not a copy — see `ReviewLeafNode.field`.
    nodes.push({ kind: "leaf", key, path, field });
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
 * silently missing from the card. For collection groups, the data determines how
 * many instances exist and the schema determines every leaf within each instance;
 * empty-but-present collections are marked on {@link ReviewRequest.tree}'s group state
 * so the submit path can still distinguish "there are none" from "touch nothing".
 */
export const buildReviewRequest = (
  extracted: Record<string, unknown>,
  transcript: Transcript,
  valuesSchema: z.ZodObject,
  options: BuildReviewRequestOptions = {},
): ReviewRequest => {
  const fields: Record<FieldPath, ReviewField> = {};
  const tree: ReviewNode[] = [];
  const requiredOnCreate = options.requiredOnCreate ?? {};
  collectFields(valuesSchema, [], extracted, transcript, requiredOnCreate, fields, tree);
  return { transcript, fields, tree, existingRecords: options.existingRecords ?? {} };
};

/**
 * Paths of the collection groups that were present in the extraction as empty arrays.
 *
 * Walks the whole tree rather than only its top level: a collection nested inside an object
 * group is still a collection, and "there are none of these" means the same thing at any
 * depth. What {@link resolveReview} does with the answer is unchanged from when this was a
 * field on the request.
 */
const emptyCollectionPaths = (nodes: readonly ReviewNode[]): FieldPath[] =>
  nodes.flatMap((node) => {
    if (node.kind === "leaf") return [];
    if (node.kind === "object") return emptyCollectionPaths(node.children);
    return [
      ...(node.state === "empty" ? [node.path] : []),
      ...node.instances.flatMap((instance) => emptyCollectionPaths(instance.children)),
    ];
  });

/**
 * The adapter facts `buildReviewRequest` cannot read off the values schema.
 *
 * An options object rather than more positional parameters: this is where
 * per-leaf adapter metadata will accumulate (requiredness today; the API's
 * field descriptions are the obvious next one), and each addition should not
 * be another signature change for every caller.
 */
export interface BuildReviewRequestOptions {
  /**
   * Leaf names, grouped by the group that owns the create endpoint, that the host
   * tool requires in order to CREATE the record. Unknown groups and leaves are
   * ignored here — an adapter is responsible for keeping its own declaration honest,
   * and `ToolAdapter.requiredOnCreate` says how to guard that.
   */
  readonly requiredOnCreate?: RequiredOnCreate;
  /**
   * Existing records of each collection group, keyed by the group path (e.g. `"hvac"`).
   *
   * These are not shown to the extractor; they are surfaced at review for a human to
   * link against, with a default of creating a new record.
   */
  readonly existingRecords?: Readonly<Record<string, readonly ExistingRecord[]>>;
}

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
  // Messages only, no paths: the path is the leaf being validated, and it is already
  // carried on the `ReviewIssue` this message goes onto — repeating it inside the text
  // would read as a second, nested field name to whoever is looking at that one editor.
  const reason = zodIssues(error)
    .map((issue) => issue.message)
    .join("; ");
  return status === "edited"
    ? `edited value is not valid for this field: ${reason}`
    : `the extracted value is not valid for this field (${reason}) — it cannot be accepted ` +
        "as it stands; edit it, or reject the leaf to leave the field untouched";
};

/**
 * Record the positional index for every instance key that survives review.
 *
 * Review paths address instances by a stable key (`k1`, `k2`, …) so a UI can
 * remove one without reattaching the remaining decisions to a different physical
 * instance. The vendor patch is positional, so this named remap is the step that
 * converts keyed decisions into array indices, preserving first-mention order.
 */
const buildInstancePositions = (
  acceptedPaths: readonly FieldPath[],
): Map<string, Map<string, number>> => {
  const positions = new Map<string, Map<string, number>>();
  for (const path of acceptedPaths) {
    const segments = parseFieldPath(path);
    let parentPath = "";
    for (const segment of segments) {
      if (segment.kind === "instanceKey") {
        let indexMap = positions.get(parentPath);
        if (indexMap === undefined) {
          indexMap = new Map();
          positions.set(parentPath, indexMap);
        }
        if (!indexMap.has(segment.key)) {
          indexMap.set(segment.key, indexMap.size);
        }
      }
      parentPath =
        parentPath === ""
          ? segment.kind === "objectKey"
            ? segment.key
            : `[${segment.key}]`
          : segment.kind === "objectKey"
            ? `${parentPath}.${segment.key}`
            : `${parentPath}[${segment.key}]`;
    }
  }
  return positions;
};

/**
 * All collection instance paths present in a review request, derived from its leaf paths.
 *
 * An instance path is the group key plus the instance key — `"hvac[k1]"` — and is what
 * a human links-or-creates against. It is not itself a leaf, so it is not in
 * `request.fields`, but it is recoverable from the leaf paths that pass through it.
 */
const instancePathsFromFields = (fields: ReviewFields): ReadonlySet<string> => {
  const paths = new Set<string>();
  for (const path of Object.keys(fields)) {
    const segments = parseFieldPath(path);
    let currentPath = "";
    for (const segment of segments) {
      currentPath =
        currentPath === ""
          ? segment.kind === "objectKey"
            ? segment.key
            : `[${segment.key}]`
          : segment.kind === "objectKey"
            ? `${currentPath}.${segment.key}`
            : `${currentPath}[${segment.key}]`;
      if (segment.kind === "instanceKey") {
        paths.add(currentPath);
      }
    }
  }
  return paths;
};

/**
 * Validate that every provided link decision names a real collection instance.
 *
 * A link decision is a human act; an unknown path is a stale or mistyped decision and
 * must be refused rather than silently dropped, or it could mask a UI bug that attaches
 * a link to the wrong instance.
 */
const instanceLinkIssues = (
  instanceLinks: Readonly<Record<string, InstanceLinkDecision>> | undefined,
  validInstancePaths: ReadonlySet<string>,
): ReviewIssue[] => {
  if (instanceLinks === undefined) return [];
  const issues: ReviewIssue[] = [];
  for (const [path, decision] of Object.entries(instanceLinks)) {
    if (!validInstancePaths.has(path)) {
      issues.push({ path, message: "not a collection instance of this review request" });
      continue;
    }
    if (decision.kind === "link" && typeof decision.uuid !== "string") {
      issues.push({ path, message: "a link decision must carry a string uuid" });
    }
  }
  return issues;
};

/**
 * Build the link-target map for every collection group that survives review.
 *
 * The array length matches the resolved instance count for the group, and indices follow
 * first-mention order. The default for every instance is `null` (create a new record);
 * a human link decision overrides it with the target uuid.
 */
const buildLinkTargets = (
  positions: Map<string, Map<string, number>>,
  instanceLinks: Readonly<Record<string, InstanceLinkDecision>> | undefined,
): LinkTargets => {
  const linkTargets: Record<string, ReadonlyArray<string | null>> = {};
  for (const [groupPath, indexMap] of positions) {
    const groupTargets = new Array<string | null>(indexMap.size);
    for (const [key, index] of indexMap) {
      const instancePath = buildFieldPath([
        { kind: "objectKey", key: groupPath },
        { kind: "instanceKey", key },
      ]);
      const decision = instanceLinks?.[instancePath];
      groupTargets[index] = decision?.kind === "link" ? decision.uuid : null;
    }
    linkTargets[groupPath] = groupTargets;
  }
  return linkTargets;
};

/**
 * Write `value` at a parsed path, creating nested objects and arrays on the way
 * down.
 *
 * Uses {@link parseFieldPath} so bracketed instance keys become array elements
 * rather than object keys whose name is the literal text `hvac[k1]`. The
 * `positions` map supplies the keyed-to-positional remap for each array group.
 */
const setAtPath = (
  target: Record<string, unknown>,
  path: FieldPath,
  value: unknown,
  positions: Map<string, Map<string, number>>,
): void => {
  const segments = parseFieldPath(path);
  if (segments.length === 0) {
    throw new Error(`field path "${path}" is empty`);
  }
  const leaf = segments[segments.length - 1] as FieldPathSegment;
  if (leaf.kind !== "objectKey") {
    throw new Error(`field path "${path}" must end with an object-key segment`);
  }

  let node: Record<string, unknown> | unknown[] = target;
  let parentPath = "";
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i] as FieldPathSegment;
    if (segment.kind === "objectKey") {
      const nextSegment = segments[i + 1];
      const isArrayParent = nextSegment?.kind === "instanceKey";
      const objectNode = node as Record<string, unknown>;
      if (objectNode[segment.key] === undefined) {
        if (isArrayParent) {
          const indexMap = positions.get(
            parentPath === "" ? segment.key : `${parentPath}.${segment.key}`,
          );
          objectNode[segment.key] = new Array(indexMap?.size ?? 0);
        } else {
          objectNode[segment.key] = {};
        }
      }
      node = objectNode[segment.key] as Record<string, unknown> | unknown[];
      parentPath = parentPath === "" ? segment.key : `${parentPath}.${segment.key}`;
    } else {
      const indexMap = positions.get(parentPath);
      if (indexMap === undefined) {
        throw new Error(
          `field path "${path}" references an unexpected instance key "${segment.key}"`,
        );
      }
      const index = indexMap.get(segment.key);
      if (index === undefined) {
        throw new Error(
          `field path "${path}" references an unexpected instance key "${segment.key}"`,
        );
      }
      const arrayNode = node as unknown[];
      let child = arrayNode[index] as Record<string, unknown> | undefined;
      if (child === undefined) {
        child = {};
        arrayNode[index] = child;
      }
      node = child;
      parentPath = `${parentPath}[${segment.key}]`;
    }
  }
  (node as Record<string, unknown>)[leaf.key] = value;
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
 * All four are checked over every leaf before any throws, so a UI gets the
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
  const validInstancePaths = instancePathsFromFields(request.fields);
  const instanceLinkInvalid = instanceLinkIssues(submission.instanceLinks, validInstancePaths);
  if (structural.length > 0 || instanceLinkInvalid.length > 0) {
    throw new ReviewValidationError([...structural, ...instanceLinkInvalid]);
  }

  const accepted: { path: FieldPath; value: unknown }[] = [];
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

    // Defer reassembly until every accepted leaf is known, so the keyed-to-positional
    // remap can be built as a named step rather than happening as a side effect of
    // iteration order.
    accepted.push({ path, value: parsed.data });
  }

  if (invalid.length > 0) throw new ReviewValidationError(invalid);

  const positions = buildInstancePositions(accepted.map((entry) => entry.path));
  const fields: Record<string, unknown> = {};
  for (const { path, value } of accepted) {
    // The PARSED value, not the raw one: the leaf's schema is the authority on what
    // a legal value for it is, so what gets persisted is what it accepted.
    setAtPath(fields, path, value, positions);
  }

  // A group that was present-but-empty in the extraction means "there are none of these",
  // which is the opposite of "touch nothing". Record it as an empty array when no instance
  // survived review.
  for (const groupPath of emptyCollectionPaths(request.tree)) {
    if (!Object.hasOwn(fields, groupPath)) {
      fields[groupPath] = [];
    }
  }

  // Link targets are only meaningful when at least one collection instance survived review.
  // For non-collection field sets the map is empty and is omitted, keeping the outcome shape
  // backward-compatible for callers that only deal with singleton groups.
  const linkTargets = buildLinkTargets(positions, submission.instanceLinks);
  const hasLinkTargets = Object.keys(linkTargets).length > 0;

  if (editedFields.length === 0 && rejectedFields.length === 0) {
    return hasLinkTargets
      ? { status: "accepted", fields, linkTargets }
      : { status: "accepted", fields };
  }
  return hasLinkTargets
    ? { status: "edited", fields, editedFields, rejectedFields, linkTargets }
    : { status: "edited", fields, editedFields, rejectedFields };
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
 * one, and `z.array(z.string())` accepts `"health.healthGasLeak"` as readily as
 * `"basedata.yearBuilt"`. `review.test.ts` and `queue/outbox-memory.test.ts` pin that.
 *
 * Strict objects on each branch: an `edited` outcome that lost `editedFields` is
 * indistinguishable from `accepted`, and silently under-reporting review effort is
 * exactly the failure `resolveReview`'s doc comment refuses.
 */
export const reviewOutcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("accepted"),
    fields: z.record(z.string(), z.unknown()),
    linkTargets: z.record(z.string(), z.array(z.string().nullable())).optional(),
  }),
  z.strictObject({
    status: z.literal("edited"),
    fields: z.record(z.string(), z.unknown()),
    editedFields: z.array(z.string()),
    rejectedFields: z.array(z.string()),
    linkTargets: z.record(z.string(), z.array(z.string().nullable())).optional(),
  }),
  z.strictObject({
    status: z.literal("discarded"),
    reason: z.string().optional(),
  }),
]);

/** The persisted, field-set-agnostic outcome. `ReviewOutcome` is the typed form. */
export type PersistedReviewOutcome = z.infer<typeof reviewOutcomeSchema>;
