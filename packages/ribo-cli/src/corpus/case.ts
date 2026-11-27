/**
 * @file The case file: one case's expected answer and its metadata.
 *
 * A case is hand-authored too, so it is parsed with zod at the boundary. The
 * expectation map is SPARSE: a case states what it knows about and stays
 * silent about the rest, and a leaf it says nothing about is unmentioned —
 * neither right nor wrong about it (design §1).
 *
 * The value vocabulary is deliberately narrow — a string, a number, a boolean
 * or a plain object — because a value the schema cannot hold is a scoring
 * question (the scorer's `unscorable` class), not a format question.
 */
import { z } from "zod";

/**
 * The expectation's status: what the corpus says about one leaf.
 * @category Eval
 */
export type ExpectationStatus = "asserted" | "declared-absent";

/**
 * A scoped default's status: what the corpus says about every leaf a scope
 * covers.
 * @category Eval
 */
export type ScopedDefaultStatus = "declared-absent" | "unmentioned";

/**
 * One expected value: a string, a number, a boolean, or a plain object for a
 * collection leaf.
 *
 * An array is refused: the format's value vocabulary is these four kinds, and
 * a list-valued expectation is spelled as an object.
 * @category Eval
 */
export const ExpectationValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.record(z.string(), z.unknown()),
]);

/**
 * One expected value, in the four kinds the format allows.
 * @category Eval
 */
export type ExpectationValue = z.infer<typeof ExpectationValueSchema>;

/**
 * An expectation entry's review state: a proposal is `pending` until a
 * reviewer confirms it, and only a confirmed entry is scored (ADR 0049).
 * @category Eval
 */
export type ExpectationReview = "pending" | "confirmed";

/**
 * The review states an expectation entry's `review` member carries.
 * @category Eval
 */
export const ExpectationReviewSchema = z.enum(["pending", "confirmed"]);

/**
 * One evidence link: the exact quote a proposal rests on, and the declared
 * input file it occurs in. A collection leaf's evidence is one link per
 * instance, keyed by the instance's ordinal (ADR 0049).
 * @category Eval
 */
export const ProposalEvidenceSchema = z.strictObject({
  /** The verbatim quote, matched exactly against the input's text. */
  quote: z.string().min(1),
  /** The input file's name, as the case's `inputs` list declares it. */
  input: z.string().min(1),
});

/**
 * One evidence link, as a proposal records it.
 * @category Eval
 */
export type ProposalEvidence = z.infer<typeof ProposalEvidenceSchema>;

/**
 * A collection leaf's evidence: one link per instance, keyed by the
 * instance's ordinal. An instance the proposal says nothing about omits its
 * ordinal — a sparse map, like the expected map itself.
 * @category Eval
 */
export const ProposalEvidenceMapSchema = z.record(z.string(), ProposalEvidenceSchema);

/**
 * The evidence a proposal carries: one quote-plus-input for a scalar leaf,
 * an ordinal-keyed map of them for a collection leaf. The loader refuses the
 * wrong shape for the leaf (ADR 0049).
 * @category Eval
 */
export const ProposalEvidenceSetSchema = z.union([
  ProposalEvidenceSchema,
  ProposalEvidenceMapSchema,
]);

/**
 * What the model proposed, stamped immutably beside the entry it produced
 * (ADR 0049). The reviewer edits the entry's own `status`, `value` and
 * `alternatives`; this block is what lets code later classify a confirmed
 * entry as accepted-unchanged or corrected.
 *
 * A proposed absence carries no value and no evidence — a claim of silence
 * has none to show.
 * @category Eval
 */
export const ExpectationProposalSchema = z.discriminatedUnion("status", [
  z.strictObject({
    /** What the model proposed for the leaf: a value, with its evidence. */
    status: z.literal("asserted"),
    /** The proposed value, in the same four kinds an expectation holds. */
    value: ExpectationValueSchema,
    /** Where the proposal came from: one quote-plus-input per instance. */
    evidence: ProposalEvidenceSetSchema,
    /** The backend that produced the proposal. */
    backend: z.string().min(1),
    /** The model that produced the proposal. */
    model: z.string().min(1),
    /** When the proposal was made, as an ISO 8601 datetime string. */
    proposedAt: z.iso.datetime(),
  }),
  z.strictObject({
    /** What the model proposed for the leaf: that it is absent. */
    status: z.literal("declared-absent"),
    /** The backend that produced the proposal. */
    backend: z.string().min(1),
    /** The model that produced the proposal. */
    model: z.string().min(1),
    /** When the proposal was made, as an ISO 8601 datetime string. */
    proposedAt: z.iso.datetime(),
  }),
]);

/**
 * What the model proposed, as a proposal-bearing entry records it.
 * @category Eval
 */
export type ExpectationProposal = z.infer<typeof ExpectationProposalSchema>;

const assertedExpectationSchema = z.strictObject({
  status: z.literal("asserted"),
  value: ExpectationValueSchema,
  alternatives: z.array(ExpectationValueSchema).optional(),
  sourceSpan: z.string().optional(),
  proposal: ExpectationProposalSchema.optional(),
  review: ExpectationReviewSchema.optional(),
});

const declaredAbsentExpectationSchema = z.strictObject({
  status: z.literal("declared-absent"),
  sourceSpan: z.string().optional(),
  proposal: ExpectationProposalSchema.optional(),
  review: ExpectationReviewSchema.optional(),
});

/**
 * One expectation entry: what the corpus says about one leaf.
 *
 * The entry is discriminated on its status: an asserted entry carries a
 * value, a declared-absent entry must not (its presence is an unknown-key
 * error naming the leaf).
 *
 * The `proposal` and `review` members are provenance and review state (ADR
 * 0049): a proposal-bearing entry carries both or neither, and the loader
 * refuses the half-dressed entry naming the leaf.
 * @category Eval
 */
export const ExpectationEntrySchema = z
  .discriminatedUnion("status", [assertedExpectationSchema, declaredAbsentExpectationSchema])
  .superRefine((entry, ctx) => {
    if ((entry.proposal === undefined) !== (entry.review === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: entry.proposal === undefined ? ["review"] : ["proposal"],
        message:
          'a proposal-bearing entry carries "proposal" and "review" together — one without the ' +
          "other cannot say whether the entry is a model's pending guess or a reviewer's judgement",
      });
    }
  });

/**
 * One scoped default: a blanket statement about every leaf a scope covers.
 *
 * The scope is normalized to a read-only array at the boundary, so a consumer
 * never re-branches on the string-or-array shape the file may use.
 * @category Eval
 */
export const ScopedDefaultSchema = z.strictObject({
  scope: z
    .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
    .transform((scope): readonly string[] =>
      Object.freeze(Array.isArray(scope) ? [...scope] : [scope]),
    ),
  status: z.enum(["declared-absent", "unmentioned"]),
  sourceSpan: z.string().optional(),
});

/**
 * The capture metadata a document case declares.
 *
 * The corpus declares what was captured; the loader never fabricates it.
 * @category Eval
 */
export const CorpusCaptureBlockSchema = z.strictObject({
  /** When the document was captured, as an ISO 8601 datetime string. */
  capturedAt: z.iso.datetime(),
  /** How many pages the document has. */
  pageCount: z.number().int().positive(),
});

/**
 * The capture metadata a document case declares.
 * @category Eval
 */
export type CorpusCaptureBlock = z.infer<typeof CorpusCaptureBlockSchema>;

/**
 * One declared input: a file in the case folder, its kind, and — for a
 * document — its capture block.
 * @category Eval
 */
export const CorpusCaseInputSchema = z
  .strictObject({
    /** The input file's name, directly inside the case folder. */
    file: z.string().min(1),
    /** The input kind: `"transcript"`, `"text"` or `"document"`. */
    kind: z.enum(["transcript", "text", "document"]),
    /** The capture metadata — a document input only. */
    capture: CorpusCaptureBlockSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.kind === "document" && value.capture === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["capture"],
        message:
          `the document input "${value.file}" must declare a capture block (capturedAt, ` +
          "pageCount) — the corpus declares what was captured, and the loader never fabricates it",
      });
    }
    if (value.kind !== "document" && value.capture !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["capture"],
        message: `the ${value.kind} input "${value.file}" must not declare a capture block — only a document input carries one`,
      });
    }
  });

/**
 * One declared input, as the case file declares it.
 * @category Eval
 */
export type CorpusCaseInput = z.infer<typeof CorpusCaseInputSchema>;

/**
 * The case file: the case's id, its ordered input files, its expected answer
 * and its scoped defaults.
 *
 * The `capture` block is required on a document input and forbidden on the
 * other kinds — a capture record belongs to a document, and a non-document
 * input carrying one is an authoring mistake the loader refuses rather than
 * ignores.
 * @category Eval
 */
export const CorpusCaseSchema = z.strictObject({
  /** The case's id; it must equal the case directory's name. */
  id: z.string().min(1),
  /**
   * The case's input files, in the order they are read and joined. Every case
   * has at least one; the old single-input shape (a case-level `kind` and one
   * implied file) is retired.
   */
  inputs: z.array(CorpusCaseInputSchema).min(1),
  /** The expected answer, as a sparse map from dotted leaf path to entry. */
  expected: z.record(z.string(), ExpectationEntrySchema),
  /** The generic scoped defaults. */
  defaults: z.array(ScopedDefaultSchema).optional(),
});

/**
 * One expectation entry, as the case file declares it.
 * @category Eval
 */
export type ExpectationEntry = z.infer<typeof ExpectationEntrySchema>;

/**
 * One scoped default, as the case file declares it — with its scope
 * normalized to a read-only array.
 * @category Eval
 */
export type ScopedDefault = z.infer<typeof ScopedDefaultSchema>;

/**
 * The case file, as the case file declares it.
 * @category Eval
 */
export type CorpusCase = z.infer<typeof CorpusCaseSchema>;

/**
 * One input's kind: `"transcript"`, `"text"` or `"document"`.
 * @category Eval
 */
export type CorpusInputKind = CorpusCaseInput["kind"];
