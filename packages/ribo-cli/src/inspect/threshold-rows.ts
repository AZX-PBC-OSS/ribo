import type { PlannedPackedCallRow } from "./planned.js";
import type { ThresholdRow, WorstPieceReport } from "./report-schema.js";

/** Inputs for selecting the one measured call set a piece threshold judges. */
export interface SelectPieceCharsThresholdOptions {
  readonly limit: number;
  readonly ruleBased?: WorstPieceReport | null;
  /** Undefined means no plan; null means a planned measurement is unavailable. */
  readonly planned?: PlannedPackedCallRow | null;
}

/** All measurements needed for the supplied threshold options. */
export interface BuildThresholdRowsOptions {
  readonly maxDepth?: number;
  readonly maxPieceChars?: number;
  readonly depth: number | null;
  readonly ruleBased?: WorstPieceReport | null;
  readonly planned?: PlannedPackedCallRow | null;
}

const ruleBasedLabel = (piece: WorstPieceReport): string =>
  piece.part === undefined ? piece.key : `${piece.key}-${piece.part}`;

/** The semantic label of the exact planned call a threshold judged. */
export const plannedPackedCallLabel = (call: PlannedPackedCallRow): string =>
  call.callCount === 1
    ? call.semantic
    : `${call.semantic} — call ${call.callIndex} of ${call.callCount}`;

/** Select planned packed calls with a plan, otherwise the rule-based worst piece. */
export function selectPieceCharsThreshold({
  limit,
  ruleBased,
  planned,
}: SelectPieceCharsThresholdOptions): ThresholdRow {
  if (planned !== undefined) {
    return {
      measure: "pieceChars",
      layout: "planned",
      limit,
      measured: planned?.serializedChars ?? null,
      breached: planned !== null && planned.serializedChars > limit,
      ...(planned === null ? {} : { piece: plannedPackedCallLabel(planned) }),
    };
  }
  const measured = ruleBased?.serializedChars ?? null;
  return {
    measure: "pieceChars",
    layout: "rule-based",
    limit,
    measured,
    breached: measured !== null && measured > limit,
    ...(ruleBased === undefined || ruleBased === null ? {} : { piece: ruleBasedLabel(ruleBased) }),
  };
}

/** Build one explicitly labelled row per supplied threshold. */
export function buildThresholdRows({
  maxDepth,
  maxPieceChars,
  depth,
  ruleBased,
  planned,
}: BuildThresholdRowsOptions): ThresholdRow[] {
  const rows: ThresholdRow[] = [];
  if (maxDepth !== undefined) {
    rows.push({
      measure: "depth",
      layout: "shared",
      limit: maxDepth,
      measured: depth,
      breached: depth !== null && depth > maxDepth,
    });
  }
  if (maxPieceChars !== undefined) {
    rows.push(selectPieceCharsThreshold({ limit: maxPieceChars, ruleBased, planned }));
  }
  return rows;
}
