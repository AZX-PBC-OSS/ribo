/**
 * @file The run record's own format: the zod schema a persisted record is
 * parsed against, and the types inferred from it.
 *
 * A record is a PERSISTED ARTEFACT crossing a trust boundary — a
 * hand-edited file, a half-written line, an artefact from an older format —
 * so it is zod-parsed on read and never cast (AGENTS §4). Unknown keys are
 * refused, the corpus format's own rule: a record that silently dropped a
 * field would render as a measurement it is not.
 *
 * The format is versioned by `contractVersion`, owned by the CLI and bumped
 * when a field's name or meaning changes. The optional `hazards` extension is
 * reserved now, so the wrapper that computes hazard counts later carries them
 * without a format change.
 *
 * The record's identity — backend, model, settings and the run fingerprint —
 * is a field group, not a hash: the record carries all four in plain text so
 * a reader can see WHICH axis moved, while the identity KEY is derived from
 * them elsewhere.
 */
import { z } from "zod";

import { EXPECTATION_REVIEW_CLASSES } from "../corpus/expectations.js";
import type { EvalBackendName } from "./backend.js";
import { EVAL_BACKENDS } from "./backend.js";
import { EVAL_UNSCORABLE_REASONS, EVAL_VERDICTS } from "./score-types.js";
import { EVAL_CONSENSUS_ARBITERS, EVAL_STRATEGY_IDS, evalPlanIdentityProblem } from "./settings.js";
import type { EvalJsonValue, EvalSettings } from "./types.js";

/**
 * The record format's own version.
 *
 * It is owned by the CLI and bumped when a field's name or meaning changes;
 * a record written under an older version is refused by the schema rather
 * than read as the current one.
 */
export const EVAL_RUN_RECORD_CONTRACT_VERSION = 1;

/** A SHA-256 digest, as 64 lowercase hex characters with no prefix. */
const fingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/u);

/**
 * A JSON value, as the cells carry them: the expectation's value and the
 * value the run produced.
 *
 * The vocabulary is the runner's own (`EvalJsonValue`), so a cell's value is
 * the same type the scorer judged — the record persists the score verbatim
 * and never re-scores it.
 */
const evalJsonValueSchema: z.ZodType<EvalJsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(evalJsonValueSchema),
    z.record(z.string(), evalJsonValueSchema),
  ]),
);

/**
 * The run's settings, as the record persists them.
 *
 * The model is NOT here: it is the record's own field, beside the settings,
 * because ADR 0041 makes the four identity fields four separate facts. The
 * base schema is structural. The document wrapper below shares the planned
 * identity rule with effective-settings validation; the runner's other
 * cross-field rules (an arbiter needs a candidate count) have already passed
 * for every record this package writes.
 * @category Eval
 */
export const EvalRunRecordSettingsSchema = z.strictObject({
  /** The arm's ordered ladder of strategy ids. */
  strategies: z.array(z.enum(EVAL_STRATEGY_IDS)).min(1).readonly(),
  /** Core's semantic plan fingerprint, issued by the runner for a planned ladder. */
  planFingerprint: z.string().optional(),
  /** How many candidates the consensus modifier ran the ladder as. */
  consensusCandidates: z.number().int().min(2).optional(),
  /** The consensus policy the candidates were arbitrated with. */
  consensusArbiter: z.enum(EVAL_CONSENSUS_ARBITERS).optional(),
  /** The retry budget per call. */
  maxRetries: z.number().int().nonnegative().optional(),
  /** The cap on generated tokens per call. */
  responseCap: z.number().int().positive().optional(),
  /** The two split caps the group-shaped calls packed under. */
  splitCaps: z
    .strictObject({
      /** Max nullable unions per group call before a group is partitioned. */
      maxNullableUnionsPerGroup: z.number().int().positive().optional(),
      /** Max serialized JSON Schema characters per group call. */
      maxSerializedCharsPerGroup: z.number().int().positive().optional(),
    })
    .optional(),
});

/**
 * The run's settings, as the record persists them.
 * @category Eval
 */
export type EvalRunRecordSettings = z.infer<typeof EvalRunRecordSettingsSchema>;

/**
 * The persisted settings and the runner's own settings object are the same
 * contract, minus the model.
 *
 * The assignment fails to compile when a field is added to one side and not
 * the other, so the projection the record builder performs cannot drift from
 * the runner's settings.
 */
type SettingsParity =
  EvalRunRecordSettings extends Omit<EvalSettings, "model">
    ? Omit<EvalSettings, "model"> extends EvalRunRecordSettings
      ? keyof EvalRunRecordSettings extends keyof Omit<EvalSettings, "model">
        ? keyof Omit<EvalSettings, "model"> extends keyof EvalRunRecordSettings
          ? true
          : never
        : never
      : never
    : never;

const _settingsParity: SettingsParity = true;

/**
 * The run's totals, as the scorer computed them.
 *
 * The counters and the three rates travel together, because any two of them
 * read as a contradiction when the third is missing; a rate is null when its
 * denominator is zero, never NaN and never absent.
 * @category Eval
 */
export const EvalRunRecordTotalsSchema = z.strictObject({
  /** The number of scored cases. */
  cases: z.number().int().nonnegative(),
  /** The cells judged correct. */
  correct: z.number().int().nonnegative(),
  /** The cells judged wrong. */
  wrong: z.number().int().nonnegative(),
  /** The cells judged missed. */
  missed: z.number().int().nonnegative(),
  /** The cells judged hallucinated. */
  hallucinated: z.number().int().nonnegative(),
  /** The cells that could not be judged. */
  unscorable: z.number().int().nonnegative(),
  /** The judged cells. */
  judged: z.number().int().nonnegative(),
  /** The judged cells where the run produced a value. */
  answered: z.number().int().nonnegative(),
  /** Coverage: answered over judged. */
  answerRate: z.number().nullable(),
  /** Quality of what was said: correct over answered. */
  accuracyOverAnswered: z.number().nullable(),
  /** Quality of the whole run: correct over judged. */
  accuracyOverAll: z.number().nullable(),
});

/**
 * A cell's review provenance, as the record persists it (R8, ADR 0049): the
 * review class of the explicit entry the expectation was resolved from, and
 * — when that entry carries a proposal — the proposer's backend and model.
 * The member is written only by a run over a proposal-bearing corpus, so a
 * proposal-free corpus's records stay byte-identical to the format's earlier
 * output (D10).
 * @category Eval
 */
export const EvalRunRecordCellReviewSchema = z.strictObject({
  /** How the entry's answer came to be what it is. */
  class: z.enum(EXPECTATION_REVIEW_CLASSES),
  /** The proposal's backend, when the entry carries a proposal. */
  proposerBackend: z.string().min(1).optional(),
  /** The proposal's model, when the entry carries a proposal. */
  proposerModel: z.string().min(1).optional(),
});

/**
 * A cell's review provenance, as the record persists it.
 * @category Eval
 */
export type EvalRunRecordCellReview = z.infer<typeof EvalRunRecordCellReviewSchema>;

/**
 * One scored cell, as the record persists it.
 * @category Eval
 */
export const EvalRunRecordCellSchema = z.strictObject({
  /** The verdict the cell carries. */
  verdict: z.enum(EVAL_VERDICTS),
  /** The expectation's value, or null when the corpus declared absence. */
  expected: evalJsonValueSchema.nullable(),
  /** The value the run produced, or null when the run produced nothing. */
  got: evalJsonValueSchema.nullable(),
  /** The corpus's verbatim span, when it recorded one. */
  sourceSpan: z.string().optional(),
  /** Where the expectation came from. */
  origin: z.enum(["explicit", "default", "none"]),
  /** The cell's review provenance, when the corpus is proposal-bearing. */
  review: EvalRunRecordCellReviewSchema.optional(),
  /** Why the cell is unscorable, when it is. */
  reason: z.enum(EVAL_UNSCORABLE_REASONS).optional(),
});

/**
 * One scored cell, as the record persists it.
 * @category Eval
 */
export type EvalRunRecordCell = z.infer<typeof EvalRunRecordCellSchema>;

/**
 * One earlier record's entry in a record's lineage.
 *
 * The entry carries the earlier record's identity KEY, its capture time and
 * its totals: enough to show the trend without carrying a whole grid twice.
 * @category Eval
 */
export const EvalRunRecordHistoryEntrySchema = z.strictObject({
  /** The earlier record's identity key. */
  identity: fingerprintSchema,
  /** When the earlier record was captured. */
  capturedAt: z.iso.datetime(),
  /** The earlier record's totals. */
  totals: EvalRunRecordTotalsSchema,
});

/**
 * The optional hazard extension a run's caller may supply.
 *
 * It names itself, so a reader that does not know the extension can skip it
 * and a reader that does can tell which extension it is looking at.
 * @category Eval
 */
export const EvalRunRecordHazardsSchema = z.strictObject({
  /** The extension's own name. */
  kind: z.string().min(1),
  /** The extension's own version. */
  version: z.number().int().positive(),
  /** The hazard counts, by hazard. */
  counts: z.record(z.string(), z.number()),
});

/**
 * The record's expectations summary: how the judged cells' expectations came
 * to be what they are (R8, ADR 0049). Every count is computed from the
 * scored cells only — never by re-reading case files — and the review-class
 * counts always sum to the record's judged total. No rate is split by
 * origin: a corrected cell is selected for difficulty, so a rate over it
 * would mislead (D5).
 *
 * The summary is written only when the corpus holds a proposal-bearing
 * entry, so every record over a proposal-free corpus — every record written
 * before proposals existed — stays byte-identical (D10).
 * @category Eval
 */
export const EvalRunRecordExpectationsSchema = z.strictObject({
  /** The judged cells, by review class. A class no judged cell carries is omitted. */
  reviewClasses: z.partialRecord(
    z.enum(EXPECTATION_REVIEW_CLASSES),
    z.number().int().nonnegative(),
  ),
  /** The judged cells proposed by each proposer, by backend and model, ordered by backend then model. */
  proposers: z
    .array(
      z.strictObject({
        /** The proposer's backend. */
        backend: z.string().min(1),
        /** The proposer's model. */
        model: z.string().min(1),
        /** The judged cells this proposer proposed. */
        cells: z.number().int().nonnegative(),
      }),
    )
    .readonly(),
  /**
   * The accepted-unchanged cells whose proposer is the record's own backend
   * AND model — the cells over which the run measures agreement with the
   * scored model's own proposal, not accuracy against an independent answer.
   */
  sameModelAcceptedUnchanged: z.number().int().nonnegative(),
});

/**
 * The record's expectations summary.
 * @category Eval
 */
export type EvalRunRecordExpectations = z.infer<typeof EvalRunRecordExpectationsSchema>;

/**
 * The record format's version, as the record carries it.
 * @category Eval
 */
export const EvalRunRecordSchema = z.strictObject({
  /** The record format's own version. */
  contractVersion: z.literal(EVAL_RUN_RECORD_CONTRACT_VERSION),
  /** When the run was captured. */
  capturedAt: z.iso.datetime(),
  /** The corpus the run measured: its name, its fingerprint and its declared provenance. */
  corpus: z.strictObject({
    /** The corpus's name, as the manifest declares it. */
    name: z.string().min(1),
    /** The corpus fingerprint: a hash over the corpus's cases only. */
    fingerprint: fingerprintSchema,
    /** The corpus's declared provenance. */
    provenance: z.enum(["real", "synthetic"]),
  }),
  /** The run fingerprint: a hash over the schema document and the prompt inputs. */
  fingerprint: fingerprintSchema,
  /** The backend the run used. */
  backend: z.enum(EVAL_BACKENDS),
  /** The model the run asked for, as its own field. */
  model: z.string().min(1),
  /** The run's settings, as one object. */
  settings: EvalRunRecordSettingsSchema,
  /** The run's totals. */
  totals: EvalRunRecordTotalsSchema,
  /** The leaf paths the grid is keyed on, in the field inventory's order. */
  leafPaths: z.array(z.string()),
  /** The dense grid, keyed leaf-major: `grid[leafPath][caseId]`. */
  grid: z.record(z.string(), z.record(z.string(), EvalRunRecordCellSchema)),
  /** The judged cells' expectation origins, when the corpus is proposal-bearing. */
  expectations: EvalRunRecordExpectationsSchema.optional(),
  /** The lineage: the strictly-earlier records of the same identity in the same directory. */
  history: z.array(EvalRunRecordHistoryEntrySchema),
  /** The optional hazard extension. */
  hazards: EvalRunRecordHazardsSchema.optional(),
});

/**
 * The persisted document contract: the plain v1 object plus the semantic
 * planned-identity rule. The base object remains available for extension.
 */
export const EvalRunRecordDocumentSchema = EvalRunRecordSchema.superRefine((record, context) => {
  const problem = evalPlanIdentityProblem(record.settings);
  if (problem === undefined) return;
  context.addIssue({
    code: "custom",
    path: ["settings", "planFingerprint"],
    message: problem,
  });
});

/**
 * A run record, as the record file declares it.
 * @category Eval
 */
export type EvalRunRecord = z.infer<typeof EvalRunRecordSchema>;

/**
 * A run record's lineage entry.
 * @category Eval
 */
export type EvalRunRecordHistoryEntry = z.infer<typeof EvalRunRecordHistoryEntrySchema>;

/**
 * A run record's hazard extension.
 * @category Eval
 */
export type EvalRunRecordHazards = z.infer<typeof EvalRunRecordHazardsSchema>;

/**
 * The record's identity: the four fields that decide whether two records
 * measure the same thing.
 *
 * The settings accept a stray `model` key, because the runner's own settings
 * object carries the model inside it: a caller holding that object must get
 * the same identity key the record persisted.
 * @category Eval
 */
export interface EvalRunRecordIdentity {
  /** The backend the run used. */
  readonly backend: EvalBackendName;
  /** The model the run asked for. */
  readonly model: string;
  /** The run's settings, with or without the model's stray copy. */
  readonly settings: EvalRunRecordSettings & { readonly model?: string };
  /** The run fingerprint. */
  readonly fingerprint: string;
}

/**
 * A run record without its lineage: the writer's input.
 *
 * The lineage is a fact of the records DIRECTORY, computed by the store when
 * the record is written, so a caller cannot claim a lineage it did not earn.
 * @category Eval
 */
export type EvalRunRecordDraft = Omit<EvalRunRecord, "history">;
