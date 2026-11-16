/**
 * @file The comparison report's own contract: the zod schema the `--json`
 * document is validated against, and the types inferred from it.
 *
 * The report is a versioned document, the pattern inspect's report schema
 * sets: a `contractVersion` literal the CLI owns, bumped when a field's name
 * or meaning changes. Everything in it is read off the two persisted records
 * — the identities, the totals, the leaf sets and the cells — so a reader of
 * the report never needs the corpus, the schema or the extraction internals.
 *
 * The two sides are carried as two named blocks (`left`, `right`), each with
 * its own corpus identity, its own four-field identity, its own totals and
 * its own exclusion counts: under the corpus override the two sides' corpora
 * differ by definition, so a single shared corpus block could not represent
 * the general case.
 */
import { z } from "zod";

import { EVAL_BACKENDS } from "./backend.js";
import {
  EvalRunRecordCellSchema,
  EvalRunRecordSettingsSchema,
  EvalRunRecordTotalsSchema,
} from "./record-schema.js";

/**
 * The comparison report's own version.
 *
 * It is owned by the CLI and bumped when a field's name or meaning changes;
 * it is independent of the run record's version — a change to one does not
 * bump the other.
 */
export const EVAL_COMPARE_CONTRACT_VERSION = 1;

/** A SHA-256 digest, as 64 lowercase hex characters with no prefix. */
const fingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/u);

/** The identity field an axis names: the four fields a record is keyed on. */
export const EVAL_COMPARE_AXES = ["backend", "model", "settings", "fingerprint"] as const;

/**
 * One axis: an identity field the two records differ on.
 * @category Eval
 */
export type EvalCompareAxis = (typeof EVAL_COMPARE_AXES)[number];

/**
 * One side of a comparison: everything the report says about one of the two
 * records, read off that record alone.
 * @category Eval
 */
export const EvalCompareSideSchema = z.strictObject({
  /** The corpus the run measured: its name and its fingerprint over the cases. */
  corpus: z.strictObject({
    /** The corpus's name, as the record carries it. */
    name: z.string().min(1),
    /** The corpus fingerprint, as the record carries it. */
    fingerprint: fingerprintSchema,
  }),
  /** The record's four-field identity, in plain text. */
  identity: z.strictObject({
    /** The backend the run used. */
    backend: z.enum(EVAL_BACKENDS),
    /** The model the run asked for. */
    model: z.string().min(1),
    /** The run's settings, as one object. */
    settings: EvalRunRecordSettingsSchema,
    /** The run fingerprint over the schema and the prompt. */
    fingerprint: fingerprintSchema,
  }),
  /** The run's totals, as the record persists them. */
  totals: EvalRunRecordTotalsSchema,
  /** How many of the record's leaves the intersection dropped. */
  excludedLeaves: z.number().int().nonnegative(),
  /** How many of the record's cases the intersection dropped. */
  excludedCases: z.number().int().nonnegative(),
});

/**
 * One side of a comparison.
 * @category Eval
 */
export type EvalCompareSide = z.infer<typeof EvalCompareSideSchema>;

/**
 * One differing cell pair: a leaf and case the two sides judge differently.
 *
 * Each side's full persisted cell is carried — the verdict and the values
 * behind it — because under the corpus override the two sides' expectations
 * can legitimately differ too.
 * @category Eval
 */
export const EvalCompareDifferenceSchema = z.strictObject({
  /** The leaf path, in the left record's own vocabulary. */
  leafPath: z.string(),
  /** The case the cell belongs to. */
  caseId: z.string(),
  /** The left record's persisted cell. */
  left: EvalRunRecordCellSchema,
  /** The right record's persisted cell. */
  right: EvalRunRecordCellSchema,
});

/**
 * One differing cell pair.
 * @category Eval
 */
export type EvalCompareDifference = z.infer<typeof EvalCompareDifferenceSchema>;

/**
 * The comparison report, as the `--json` document declares it.
 * @category Eval
 */
export const EvalCompareReportSchema = z.strictObject({
  /** The comparison contract's own version. */
  contractVersion: z.literal(EVAL_COMPARE_CONTRACT_VERSION),
  /** Whether the caller passed the corpus-mismatch override. Records what was asserted, matched or not. */
  corpusOverride: z.boolean(),
  /** The identity fields the two records differ on, in the identity's own field order. */
  axes: z.array(z.enum(EVAL_COMPARE_AXES)),
  /** The intersection's leaf paths, in the left record's order. */
  leafPaths: z.array(z.string()),
  /** The differing cell pairs, ordered by the left record's leaf order, then its case order. */
  differences: z.array(EvalCompareDifferenceSchema),
  /** The left record's side block. */
  left: EvalCompareSideSchema,
  /** The right record's side block. */
  right: EvalCompareSideSchema,
});

/**
 * The comparison report.
 * @category Eval
 */
export type EvalCompareReport = z.infer<typeof EvalCompareReportSchema>;
