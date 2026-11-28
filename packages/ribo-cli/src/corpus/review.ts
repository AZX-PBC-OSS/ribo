/**
 * @file The `ribo corpus review` core: the pending-proposal sheet and the
 * three decisions (R6; ADR 0049's D8).
 *
 * The read side makes no model call, needs no credential and writes nothing:
 * it re-verifies each pending proposal's quote against the case's current
 * inputs under the ONE per-input rule the proposer used
 * (`schema-init/validate.ts`), and marks each value `literal` when the value
 * itself occurs in its quote — strings and numbers through the document fold
 * and a review-side number comparator that tolerates thousands separators and
 * currency signs. The comparator is never shared with `eval/score-numbers.ts`'
 * `parseNumberish`, which answers a different question (scoring, not
 * evidence) and stays unchanged.
 *
 * The write side applies a reviewer's decision through the guarded writer
 * (`case-write.ts`), so every write changes only `expected` and is atomic.
 * The `proposal` block is never modified — it is what lets a reader classify
 * the entry later as accepted-unchanged or corrected.
 */
import type { z } from "zod";

import type { CaseInputText } from "../eval/case-text.js";
import { matchingQuoteInputs, normalizeSchemaInitDocumentText } from "../schema-init/validate.js";
import type { ExpectationEntry, ExpectationValue, ProposalEvidence } from "./case.js";
import { writeCaseExpected } from "./case-write.js";
import type { CaseWriteFs } from "./case-write.js";
import { walkCollectionPaths } from "./collection-paths.js";
import { CorpusError } from "./error.js";
import type { LoadedCase } from "./loader.js";

/**
 * The version of the review documents the command emits — the `--json` sheet
 * and the decision report: a `contractVersion` literal the CLI owns, bumped
 * when a field's name or meaning changes — the discipline `ribo corpus text`'s
 * contract sets.
 */
export const CORPUS_REVIEW_CONTRACT_VERSION = 1;

/** One value's evidence, as the sheet reports it: the proposal's quote and input, re-verified. */
export interface ReviewEvidenceCell {
  /** The value the pending entry holds for this cell. */
  readonly value: ExpectationValue;
  /** The quote the proposal grounded the value in. */
  readonly quote: string;
  /** The input file the proposal named. */
  readonly input: string;
  /** Whether the quote still grounds in the case's current inputs. */
  readonly grounded: boolean;
  /** Whether the value itself occurs in its quote. */
  readonly literal: boolean;
}

/** One scalar pending proposal's row in the sheet. */
export interface ReviewValueRow extends ReviewEvidenceCell {
  /** The leaf's dotted path. */
  readonly path: string;
}

/** One collection's pending proposal, rendered row-major: one entry per instance ordinal. */
export interface ReviewCollectionSheet {
  /** The dotted path of the collection the pending leaves live under. */
  readonly collectionPath: string;
  /**
   * The rows, in ordinal order. A leaf that says nothing about a row omits
   * its cell — a missing cell, not a zero.
   */
  readonly rows: readonly {
    readonly ordinal: string;
    readonly cells: Readonly<Record<string, ReviewEvidenceCell | undefined>>;
  }[];
}

/** One proposed absence, in its own block: a claim of silence has no evidence to show. */
export interface ReviewAbsenceRow {
  /** The leaf's dotted path. */
  readonly path: string;
}

/** One case's pending sheet. */
export interface ReviewCaseSheet {
  readonly caseId: string;
  /** The scalar pending values. */
  readonly values: readonly ReviewValueRow[];
  /** The collection pending values, row-major. */
  readonly collections: readonly ReviewCollectionSheet[];
  /** The proposed absences, in their own block. */
  readonly absences: readonly ReviewAbsenceRow[];
}

/** The versioned `--json` sheet: one entry per selected case, in corpus order. */
export interface ReviewSheet {
  readonly contractVersion: typeof CORPUS_REVIEW_CONTRACT_VERSION;
  readonly corpus: string;
  readonly cases: readonly ReviewCaseSheet[];
}

/**
 * Does the value itself occur in the quote? Strings compare through the
 * document fold; numbers through a review-side comparator that tolerates
 * thousands separators and a currency sign; a boolean never occurs as itself
 * in prose, so it is never literal.
 * @param value - The pending entry's value (a collection cell's scalar).
 * @param quote - The quote the proposal grounded it in.
 * @returns Whether the value occurs in the quote.
 */
export function valueOccursLiterally(value: ExpectationValue, quote: string): boolean {
  const foldedQuote = normalizeSchemaInitDocumentText(quote).toLowerCase();
  if (typeof value === "string") {
    // Letter case folded, the way the proposal validator's quote-names-value
    // check folds: a vocabulary is often normalized.
    const fold = (text: string): string => normalizeSchemaInitDocumentText(text).toLowerCase();
    return foldedQuote.includes(fold(value));
  }
  if (typeof value === "number") return numberOccursInText(value, foldedQuote);
  return false;
}

/**
 * The review-side number occurrence: the value's digits, optionally grouped
 * in threes by commas, optionally behind a currency sign. Deliberately not
 * `parseNumberish` — that folds words and loose digits for scoring; this
 * asks whether THIS number is written in the quote.
 */
const numberOccursInText = (value: number, text: string): boolean => {
  if (!Number.isFinite(value)) return false;
  const rendered = Math.abs(value).toString();
  const dot = rendered.indexOf(".");
  const intPart = dot === -1 ? rendered : rendered.slice(0, dot);
  const fracPart = dot === -1 ? undefined : rendered.slice(dot + 1);
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/gu, ",?");
  const body = fracPart === undefined ? grouped : `${grouped}\\.${fracPart}`;
  const sign = value < 0 ? "-?" : "";
  return new RegExp(`(?:^|[^0-9])(?:[$€£¥]\\s*)?${sign}${body}(?![0-9])`, "u").test(text);
};

/** Whether the quote still grounds in the case's current inputs, under each input's own rule. */
const stillGrounded = (evidence: ProposalEvidence, inputs: readonly CaseInputText[]): boolean =>
  matchingQuoteInputs(evidence.quote, inputs).length > 0;

/** Is this evidence set the scalar shape — one quote-plus-input, not a map? */
const isScalarEvidence = (
  evidence: ProposalEvidence | Record<string, ProposalEvidence>,
): evidence is ProposalEvidence => "quote" in evidence;

/** The evidence cell one scalar evidence link reports as. */
const scalarCell = (
  value: ExpectationValue,
  evidence: ProposalEvidence,
  inputs: readonly CaseInputText[],
): ReviewEvidenceCell => ({
  value,
  quote: evidence.quote,
  input: evidence.input,
  grounded: stillGrounded(evidence, inputs),
  literal: valueOccursLiterally(value, evidence.quote),
});

/**
 * Build one case's pending sheet: scalar values, collections row-major, and
 * the proposed absences in their own block. Only pending proposals appear —
 * a confirmed or hand-written entry is no longer a question for the reviewer.
 * @param selected - The loaded case to sheet.
 * @param schema - The corpus's converted zod schema, walked for collection
 *   membership.
 * @param inputs - The case's per-input texts, documents transcribed.
 * @returns The case's sheet.
 */
export function reviewCaseSheet(
  selected: LoadedCase,
  schema: z.ZodObject,
  inputs: readonly CaseInputText[],
): ReviewCaseSheet {
  const collectionPathByLeaf = new Map<string, string | undefined>(
    walkCollectionPaths(schema).map((entry) => [entry.path, entry.collectionPath]),
  );
  const values: ReviewValueRow[] = [];
  const absences: ReviewAbsenceRow[] = [];
  const collections = new Map<string, Map<string, Record<string, ReviewEvidenceCell>>>();
  for (const [path, entry] of Object.entries(selected.expected)) {
    if (entry.proposal === undefined || entry.review !== "pending") continue;
    const { proposal } = entry;
    if (proposal.status === "declared-absent") {
      absences.push({ path });
      continue;
    }
    // A pending asserted entry's proposal is asserted; the guard keeps the
    // narrowing honest rather than trusting the loader's refusal.
    if (entry.status !== "asserted" || proposal.status !== "asserted") continue;
    const collectionPath = collectionPathByLeaf.get(path);
    if (collectionPath === undefined) {
      // The loader refuses a map-shaped evidence set on a scalar leaf; the
      // guard keeps the narrowing honest rather than trusting it.
      if (!isScalarEvidence(proposal.evidence)) continue;
      values.push({ path, ...scalarCell(entry.value, proposal.evidence, inputs) });
      continue;
    }
    // A collection leaf: its value and evidence are ordinal-keyed maps, and
    // the sheet renders them row-major — one row per instance, every leaf's
    // cell in it.
    let rows = collections.get(collectionPath);
    if (rows === undefined) {
      rows = new Map();
      collections.set(collectionPath, rows);
    }
    const value = entry.value as Record<string, ExpectationValue>;
    const evidence = proposal.evidence as Record<string, ProposalEvidence>;
    for (const ordinal of new Set([...Object.keys(value), ...Object.keys(evidence)])) {
      const cellValue = value[ordinal];
      const cellEvidence = evidence[ordinal];
      if (cellValue === undefined || cellEvidence === undefined) continue;
      const row = rows.get(ordinal) ?? {};
      row[path] = scalarCell(cellValue, cellEvidence, inputs);
      rows.set(ordinal, row);
    }
  }
  const ordinalOf = (ordinal: string): number => Number(ordinal);
  return {
    caseId: selected.id,
    values,
    collections: [...collections.entries()].map(([collectionPath, rows]) => ({
      collectionPath,
      rows: [...rows.entries()]
        .sort((left, right) => ordinalOf(left[0]) - ordinalOf(right[0]))
        .map(([ordinal, cells]) => ({ ordinal, cells })),
    })),
    absences,
  };
}

/** Is this entry a pending proposal — the only thing a decision applies to? */
const isPendingProposal = (entry: ExpectationEntry | undefined): boolean =>
  entry !== undefined && entry.proposal !== undefined && entry.review === "pending";

/** The refusal for a decision on a leaf with no pending proposal — by name. */
const refuseNoPending = (selected: LoadedCase, leaf: string): never => {
  throw new CorpusError(
    `the corpus case "${selected.id}" has no pending proposal for leaf "${leaf}" — a decision ` +
      "applies only to a pending proposal (fix: run `ribo corpus review` without flags to see " +
      "the pending sheet, and name a leaf it lists)",
  );
};

/**
 * One reviewer decision: confirm (whole-case or narrowed to leaves),
 * mark-absent one leaf, or reject one leaf.
 * @category Eval
 */
export type ReviewDecision =
  | { readonly action: "confirm"; readonly leaves?: readonly string[] }
  | { readonly action: "mark-absent"; readonly leaf: string }
  | { readonly action: "reject"; readonly leaf: string };

/** What one decision did, as the command reports it. */
export interface ReviewDecisionOutcome {
  /** The action applied. */
  readonly action: ReviewDecision["action"];
  /** The leaves the decision applied to, in the order decided. */
  readonly decided: readonly string[];
  /**
   * A whole-case confirm only: the pending leaves it deliberately left
   * pending, each with the reason — a proposed absence, a non-literal value,
   * or a quote that no longer grounds.
   */
  readonly leftPending: readonly { readonly path: string; readonly reason: string }[];
}

/** Why a whole-case confirm refuses an entry: the reasons, stated once. */
const ABSENCE_REASON =
  "a proposed absence is never confirmed by a whole-case confirm — a claim of silence has no " +
  "evidence to show (fix: name it with --leaf)";
const nonLiteralReason = (grounded: boolean): string =>
  grounded
    ? "its value is not literal in its quote (fix: check the quote, correct the entry's value " +
      "in case.json, or name it with --leaf)"
    : "its quote no longer grounds in any input (fix: re-check the case's inputs, correct the " +
      "entry, or name it with --leaf)";

/** Is every value of this pending asserted entry literal in a still-grounded quote? */
const confirmable = (
  entry: Extract<ExpectationEntry, { status: "asserted" }>,
  inputs: readonly CaseInputText[],
): { readonly ok: boolean; readonly reason?: string } => {
  const evidence = entry.proposal?.status === "asserted" ? entry.proposal.evidence : undefined;
  if (evidence === undefined) return { ok: false, reason: ABSENCE_REASON };
  if (!isScalarEvidence(evidence)) {
    // A collection leaf: every instance's cell must be literal and grounded.
    const ordinals = new Set([
      ...Object.keys(entry.value as Record<string, ExpectationValue>),
      ...Object.keys(evidence),
    ]);
    if (ordinals.size === 0) {
      return { ok: false, reason: "the entry carries no values to confirm" };
    }
    for (const ordinal of ordinals) {
      const value = (entry.value as Record<string, ExpectationValue>)[ordinal];
      const link = evidence[ordinal];
      if (value === undefined || link === undefined) {
        return { ok: false, reason: `its row ${ordinal} carries no grounded value to confirm` };
      }
      if (!stillGrounded(link, inputs) || !valueOccursLiterally(value, link.quote)) {
        return { ok: false, reason: nonLiteralReason(stillGrounded(link, inputs)) };
      }
    }
    return { ok: true };
  }
  const grounded = stillGrounded(evidence, inputs);
  if (!grounded || !valueOccursLiterally(entry.value, evidence.quote)) {
    return { ok: false, reason: nonLiteralReason(grounded) };
  }
  return { ok: true };
};

/**
 * Apply one reviewer decision to one case, through the guarded writer.
 *
 * The `proposal` block is never modified: a confirm flips only `review`, a
 * mark-absent sets the entry declared-absent and confirms it keeping its
 * proposal, and a reject removes the pending explicit entry — the leaf then
 * resolves exactly as the corpus otherwise would, through a covering default
 * if one exists, else unmentioned. Reject never edits defaults and never
 * writes an explicit unmentioned entry.
 * @param selected - The loaded case whose pending proposals are decided.
 * @param inputs - The case's per-input texts, documents transcribed through
 *   the shared path — the same texts the sheet's re-verification read.
 * @param decision - The decision: one action, with its leaf or leaves.
 * @param dependencies - The injected write filesystem, for tests.
 * @returns What the decision did.
 * @throws {@link CorpusError} when the case file cannot be written, or when
 *   a decision names a leaf with no pending proposal — refused by name.
 */
export function applyReviewDecision(
  selected: LoadedCase,
  inputs: readonly CaseInputText[],
  decision: ReviewDecision,
  dependencies: { readonly writeFs?: CaseWriteFs } = {},
): ReviewDecisionOutcome {
  const options = dependencies.writeFs === undefined ? {} : { fs: dependencies.writeFs };
  if (decision.action === "confirm") {
    const narrowed = decision.leaves !== undefined && decision.leaves.length > 0;
    if (narrowed) {
      const leaves = decision.leaves;
      for (const leaf of leaves) {
        if (!isPendingProposal(selected.expected[leaf])) refuseNoPending(selected, leaf);
      }
      writeCaseExpected(
        selected.caseFile,
        (expected) => {
          const next: Record<string, unknown> = { ...expected };
          for (const leaf of leaves) {
            next[leaf] = { ...(expected[leaf] as Record<string, unknown>), review: "confirmed" };
          }
          return next;
        },
        options,
      );
      return { action: "confirm", decided: [...leaves], leftPending: [] };
    }
    // Whole-case: confirm only entries whose every value is literal in a
    // still-grounded quote. Proposed absences and non-literals stay pending,
    // named with their reason.
    const decided: string[] = [];
    const leftPending: { path: string; reason: string }[] = [];
    for (const [path, entry] of Object.entries(selected.expected)) {
      if (!isPendingProposal(entry)) continue;
      if (entry.status === "declared-absent") {
        leftPending.push({ path, reason: ABSENCE_REASON });
        continue;
      }
      const verdict = confirmable(entry, inputs);
      if (verdict.ok) decided.push(path);
      else leftPending.push({ path, reason: verdict.reason ?? "it cannot be confirmed" });
    }
    if (decided.length > 0) {
      writeCaseExpected(
        selected.caseFile,
        (expected) => {
          const next: Record<string, unknown> = { ...expected };
          for (const leaf of decided) {
            next[leaf] = { ...(expected[leaf] as Record<string, unknown>), review: "confirmed" };
          }
          return next;
        },
        options,
      );
    }
    return { action: "confirm", decided, leftPending };
  }
  const leaf = decision.leaf;
  if (!isPendingProposal(selected.expected[leaf])) refuseNoPending(selected, leaf);
  writeCaseExpected(
    selected.caseFile,
    (expected) => {
      const next: Record<string, unknown> = { ...expected };
      if (decision.action === "reject") {
        delete next[leaf];
        return next;
      }
      // Mark-absent: the entry becomes declared-absent and confirmed, keeping
      // its proposal block untouched — the reviewer's judgement rides beside
      // what the model proposed, which is what classifies the entry later.
      // The proposal rides through raw, byte-identical.
      next[leaf] = {
        status: "declared-absent",
        proposal: (next[leaf] as { proposal: ExpectationEntry["proposal"] }).proposal,
        review: "confirmed",
      };
      return next;
    },
    options,
  );
  return { action: decision.action, decided: [leaf], leftPending: [] };
}
