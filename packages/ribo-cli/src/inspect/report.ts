import { describeExtraction, MAX_NULLABLE_UNIONS_PER_CALL } from "@azx/ribo-core";
import type { ExtractionDescription, ExtractionPieceDescription } from "@azx/ribo-core";
import type { z } from "zod";

import { cliVersion, coreVersion } from "../versions.js";
import { SchemaInspectError } from "./error.js";
import { describeCalls } from "./calls.js";
import type { SplitCapOptions } from "./calls.js";
import { walkFieldInventory } from "./field-inventory.js";
import { schemaFingerprint } from "./fingerprint.js";
import { collectGranularityViolations } from "./granularity.js";
import { NOT_VISIBLE_CONSTRUCTS } from "./not-visible.js";
import { findReformatFindings } from "./reformat-lint.js";
import type { SchemaInspectOptions } from "./options.js";
import { CONTRACT_VERSION } from "./report-schema.js";
import type { SchemaInspectReport, ThresholdRow, WorstPieceReport } from "./report-schema.js";

/** The message out of a thrown fault, reworded to the input's vocabulary. */
const faultMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The piece with the largest `serializedChars` — ties stay with the first in
 * split order; `undefined` when the split produced no pieces.
 */
const worstPieceOf = (
  pieces: readonly ExtractionPieceDescription[] | undefined,
): ExtractionPieceDescription | undefined => {
  if (pieces === undefined || pieces.length === 0) return undefined;
  let worst = pieces[0]!;
  for (const piece of pieces.slice(1)) {
    if (piece.serializedChars > worst.serializedChars) worst = piece;
  }
  return worst;
};

/** The worst piece's name, in the request-name vocabulary: `${key}` or `${key}-<part>`. */
const pieceLabel = (piece: WorstPieceReport): string =>
  piece.part === undefined ? piece.key : `${piece.key}-${piece.part}`;

/**
 * One row per supplied threshold. Thresholds are comparisons the CLI makes on
 * reported numbers — never fed into the split (design §1). When the underlying
 * measure is unavailable (a refusal left no pieces), `measured` is `null` and
 * `breached` is `false`; the report's `refusal` row already says why.
 */
const thresholdRows = (
  options: SchemaInspectOptions,
  description: ExtractionDescription,
  worst: WorstPieceReport | undefined,
): ThresholdRow[] => {
  const rows: ThresholdRow[] = [];
  if (options.maxDepth !== undefined) {
    const measured = description.whole === undefined ? null : description.whole.depth;
    rows.push({
      measure: "depth",
      limit: options.maxDepth,
      measured,
      breached: measured !== null && measured > options.maxDepth,
    });
  }
  if (options.maxPieceChars !== undefined) {
    const measured = worst === undefined ? null : worst.serializedChars;
    rows.push({
      measure: "pieceChars",
      limit: options.maxPieceChars,
      measured,
      breached: measured !== null && measured > options.maxPieceChars,
      ...(worst === undefined ? {} : { piece: pieceLabel(worst) }),
    });
  }
  return rows;
};

/**
 * Assemble the report from everything the walk and the description measured.
 * The pieces fall out in presence order: the inventory-derived fields always
 * stand (the walk succeeded — the caller got past the could-not-run faults),
 * and everything derived from `describeExtraction` is absent exactly where its
 * own rows are absent.
 */
export function assembleReport(
  document: unknown,
  schema: z.ZodObject,
  options: SchemaInspectOptions,
): SchemaInspectReport {
  let entries;
  try {
    entries = walkFieldInventory(schema);
  } catch (error) {
    // Convertible but unwalkable (a scalar array, a union, a record): the
    // field/group foundation of the report does not exist, so this is
    // could-not-run carrying the walk's own path-named message — never a
    // guessed count (Decision 9).
    throw new SchemaInspectError(
      `the document converted, but its schema could not be walked for fields: ${faultMessage(error)}`,
    );
  }

  const described = entries.filter((entry) => entry.description !== undefined).length;
  const splitCaps: SplitCapOptions = {
    ...(options.maxNullableUnionsPerGroup === undefined
      ? {}
      : { maxNullableUnionsPerGroup: options.maxNullableUnionsPerGroup }),
    ...(options.maxSerializedCharsPerGroup === undefined
      ? {}
      : { maxSerializedCharsPerGroup: options.maxSerializedCharsPerGroup }),
  };
  const description = describeExtraction({ schema, ...splitCaps });
  const keys = description.keys?.map(({ key, kind }) => ({ key, kind }));
  const groupCount = keys?.filter((key) => key.kind === "group").length;
  const worst = worstPieceOf(description.pieces);

  const report: SchemaInspectReport = {
    contractVersion: CONTRACT_VERSION,
    cliVersion,
    coreVersion,
    schemaFingerprint: schemaFingerprint(document),
    leafCount: entries.length,
    splitCaps: {
      maxSerializedCharsPerGroup: splitCaps.maxSerializedCharsPerGroup ?? null,
      maxNullableUnionsPerGroup:
        splitCaps.maxNullableUnionsPerGroup ?? MAX_NULLABLE_UNIONS_PER_CALL,
    },
    guidanceCoverage: {
      described,
      total: entries.length,
      ratio: entries.length === 0 ? 0 : described / entries.length,
    },
    reformatFindings: findReformatFindings(entries),
    granularityViolations: collectGranularityViolations(schema),
    notVisible: [...NOT_VISIBLE_CONSTRUCTS],
    worstPiece:
      worst === undefined
        ? null
        : {
            key: worst.key,
            ...(worst.part === undefined ? {} : { part: worst.part }),
            serializedChars: worst.serializedChars,
          },
  };

  if (description.refusal !== undefined) {
    report.refusal = { stage: description.refusal.stage, message: description.refusal.message };
  }

  // Keys (and everything derived beside them) are present exactly when the
  // derive stage survived — a derive-stage refusal leaves no schema to
  // classify or measure.
  if (keys !== undefined && groupCount !== undefined) {
    report.keys = keys;
    report.groupCount = groupCount;
    report.looseKeyCount = keys.length - groupCount;
    if (description.path !== undefined) report.path = description.path;
    if (description.flatReason !== undefined) {
      const { kind } = description.flatReason;
      report.flatReason =
        kind === "loose-keys" ? { kind, keys: [...description.flatReason.keys] } : { kind };
    }
    if (description.callShape !== undefined) report.callShape = description.callShape;
    if (description.whole !== undefined) {
      report.whole = { ...description.whole };
    }
    if (description.pieces !== undefined) {
      report.pieces = description.pieces.map((piece) => ({
        key: piece.key,
        ...(piece.part === undefined ? {} : { part: piece.part, parts: piece.parts }),
        nullableUnions: piece.nullableUnions,
        serializedChars: piece.serializedChars,
        depth: piece.depth,
      }));
    }
    report.calls = describeCalls(description, splitCaps);
    const thresholds = thresholdRows(options, description, worst);
    if (thresholds.length > 0) report.thresholds = thresholds;
  }

  return report;
}
