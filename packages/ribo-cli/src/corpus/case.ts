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

const assertedExpectationSchema = z.strictObject({
  status: z.literal("asserted"),
  value: ExpectationValueSchema,
  alternatives: z.array(ExpectationValueSchema).optional(),
  sourceSpan: z.string().optional(),
});

const declaredAbsentExpectationSchema = z.strictObject({
  status: z.literal("declared-absent"),
  sourceSpan: z.string().optional(),
});

/**
 * One expectation entry: what the corpus says about one leaf.
 *
 * The entry is discriminated on its status: an asserted entry carries a
 * value, a declared-absent entry must not (its presence is an unknown-key
 * error naming the leaf).
 * @category Eval
 */
export const ExpectationEntrySchema = z.discriminatedUnion("status", [
  assertedExpectationSchema,
  declaredAbsentExpectationSchema,
]);

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
 * The case file: the case's id, its input kind, its expected answer and its
 * scoped defaults.
 *
 * The `capture` block is required for a document case and forbidden for the
 * other kinds — a capture record belongs to a document, and a non-document
 * case carrying one is an authoring mistake the loader refuses rather than
 * ignores.
 * @category Eval
 */
export const CorpusCaseSchema = z
  .strictObject({
    /** The case's id; it must equal the case directory's name. */
    id: z.string().min(1),
    /** The input kind: `"transcript"`, `"text"` or `"document"`. */
    kind: z.enum(["transcript", "text", "document"]),
    /** The expected answer, as a sparse map from dotted leaf path to entry. */
    expected: z.record(z.string(), ExpectationEntrySchema),
    /** The generic scoped defaults. */
    defaults: z.array(ScopedDefaultSchema).optional(),
    /** The capture metadata — a document case only. */
    capture: CorpusCaptureBlockSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.kind === "document" && value.capture === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["capture"],
        message:
          "a document case must declare a capture block (capturedAt, pageCount) — the corpus " +
          "declares what was captured, and the loader never fabricates it",
      });
    }
    if (value.kind !== "document" && value.capture !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["capture"],
        message: `a ${value.kind} case must not declare a capture block — only a document case carries one`,
      });
    }
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
 * The input kind: `"transcript"`, `"text"` or `"document"`.
 * @category Eval
 */
export type CorpusCaseKind = CorpusCase["kind"];
