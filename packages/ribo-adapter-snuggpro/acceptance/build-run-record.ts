import type {
  Cell,
  CellVerdict,
  Hazards,
  HistoryEntry,
  RunRecord,
  ShapeConformance,
} from "./run-record.js";
import { HistoryEntrySchema } from "./run-record.js";

/**
 * Densifies the acceptance gate's scored reports into a self-contained RunRecord.
 *
 * PURE, and deliberately imports NOTHING from `spikes/`. Two reasons, both
 * load-bearing:
 *
 *   1. `score.mjs` and `ground-truth.mjs` are untyped `.mjs` and must never be
 *      edited. `tsconfig.acceptance.json` therefore excludes `gate.manual.ts`
 *      (the only file that imports them). Keeping this module free of those
 *      imports is what lets it be typechecked at all.
 *   2. A pure function over plain data is unit-testable with fixtures, with no
 *      inference, no corpus and no network — so it runs in `./check.sh` while
 *      the gate that feeds it stays manual.
 *
 * See docs/roadmap/design/extraction-accuracy-report-design.md §3.
 */

/**
 * The subset of `score.mjs`'s per-transcript report this module reads. Declared
 * structurally rather than imported, per the note above. Every list is keyed by
 * leaf path (`field`, or `test` for health rows).
 */
export interface ScoreReportLike {
  slug: string;
  status: string;
  problem: string | null;
  hallucinations: Array<{
    field: string;
    value: unknown;
    confidence?: number | null;
    sourceSpan?: string | null;
    rvalueConversion?: boolean;
  }>;
  softAlternatives: Array<{ field: string; value: unknown; note?: string }>;
  sanctionedRows: Array<{ field: string; value: unknown; note?: string }>;
  misses: Array<{ field: string; expected: unknown; span?: string | null }>;
  excused: Array<{ field: string; note?: string }>;
  wrong: Array<{
    field: string;
    expected: unknown;
    got: unknown;
    tag?: string | null;
    detail?: string | null;
  }>;
  unscorableRows: Array<{ field: string; got: unknown; detail?: string | null }>;
  badSpans: Array<{
    field: string;
    value: unknown;
    span?: string | null;
    status: string;
    detail?: string | null;
  }>;
  health: Array<{ test: string; gt: string | null; got: unknown; category: string }>;
}

export interface BuildRunRecordInput {
  capturedAt: string;
  schemaFingerprint: string;
  backend: string;
  backendLabel: string;
  model: string;
  passed: boolean;
  hallRate: number;
  missRate: number;
  totals: Record<string, number>;
  hazards: Hazards;
  shapeConformance: ShapeConformance;
  /** Every leaf path in the schema, generic and health alike, in display order. */
  leafPaths: string[];
  reports: ScoreReportLike[];
  /**
   * Per transcript slug, the leaf paths whose ground truth `status` is
   * `"asserted"`. This is the ONLY thing that separates `correct` from
   * `correct-null`, and the gate is the only place with the raw ground truth in
   * hand — hence a parameter rather than a lookup.
   */
  assertedLeaves: Record<string, string[]>;
}

/** `null`/`undefined` stay null; everything else becomes a display string. */
function show(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

const HEALTH_VERDICTS: Record<string, CellVerdict> = {
  hallucinatedPass: "health-hallucinated-pass",
  hallucinatedProblem: "health-hallucinated-problem",
  cleanDropped: "health-clean-dropped",
  miss: "health-miss",
};

function emptyCell(): Cell {
  return {
    verdict: "correct",
    expected: null,
    got: null,
    sourceSpan: null,
    spanIssue: null,
    detail: null,
  };
}

/**
 * Build one transcript's column. Precedence matters: a leaf can legitimately
 * appear in more than one list (a health row is also a miss; a sanctioned row is
 * also a near-match), and the FIRST assignment wins. Health rows are applied
 * first because they carry the more specific vocabulary.
 */
function cellsForReport(
  report: ScoreReportLike,
  leafPaths: string[],
  asserted: Set<string>,
): Record<string, Cell> {
  const cells: Record<string, Cell> = {};
  for (const path of leafPaths) cells[path] = emptyCell();

  const claimed = new Set<string>();
  const claim = (path: string, patch: Partial<Cell> & { verdict: CellVerdict }): void => {
    const cell = cells[path];
    if (cell === undefined || claimed.has(path)) return; // unknown leaf, or already decided
    claimed.add(path);
    Object.assign(cell, patch);
  };

  for (const row of report.health) {
    claim(row.test, {
      verdict: HEALTH_VERDICTS[row.category] ?? "health-wrong",
      expected: show(row.gt),
      got: show(row.got),
    });
  }
  for (const row of report.hallucinations) {
    claim(row.field, {
      verdict: "hallucination",
      got: show(row.value),
      sourceSpan: row.sourceSpan ?? null,
      detail: row.rvalueConversion === true ? "R-value converted to a band" : null,
    });
  }
  for (const row of report.softAlternatives) {
    claim(row.field, {
      verdict: "hallucination-soft",
      got: show(row.value),
      detail: row.note ?? null,
    });
  }
  for (const row of report.sanctionedRows) {
    claim(row.field, { verdict: "sanctioned", got: show(row.value), detail: row.note ?? null });
  }
  for (const row of report.misses) {
    claim(row.field, {
      verdict: "miss",
      expected: show(row.expected),
      sourceSpan: row.span ?? null,
    });
  }
  for (const row of report.excused) {
    claim(row.field, { verdict: "miss-excused", detail: row.note ?? null });
  }
  for (const row of report.wrong) {
    claim(row.field, {
      verdict: "wrong",
      expected: show(row.expected),
      got: show(row.got),
      detail: row.detail ?? row.tag ?? null,
    });
  }
  for (const row of report.unscorableRows) {
    claim(row.field, { verdict: "unscorable", got: show(row.got), detail: row.detail ?? null });
  }

  // Everything unclaimed was neither a problem nor an omission: it is correct.
  // Ground truth decides WHICH kind of correct, and the distinction is the whole
  // reason `assertedLeaves` is threaded through — see the design doc §3.
  for (const path of leafPaths) {
    if (claimed.has(path)) continue;
    const cell = cells[path];
    if (cell !== undefined) cell.verdict = asserted.has(path) ? "correct" : "correct-null";
  }

  // Span problems are a SEPARATE axis and never overwrite a content verdict: a
  // value can be right and its quote fabricated. Applied last, to every cell,
  // claimed or not.
  for (const row of report.badSpans) {
    const cell = cells[row.field];
    if (cell === undefined) continue;
    cell.spanIssue = row.status;
    if (cell.sourceSpan === null) cell.sourceSpan = row.span ?? null;
    if (cell.detail === null) cell.detail = row.detail ?? null;
  }

  return cells;
}

export function buildRunRecord(input: BuildRunRecordInput): RunRecord {
  const grid: Record<string, Record<string, Cell>> = {};
  for (const path of input.leafPaths) grid[path] = {};

  for (const report of input.reports) {
    const asserted = new Set(input.assertedLeaves[report.slug] ?? []);
    const cells = cellsForReport(report, input.leafPaths, asserted);
    for (const path of input.leafPaths) {
      const column = grid[path];
      const cell = cells[path];
      if (column !== undefined && cell !== undefined) column[report.slug] = cell;
    }
  }

  return {
    capturedAt: input.capturedAt,
    schemaFingerprint: input.schemaFingerprint,
    backend: input.backend,
    backendLabel: input.backendLabel,
    model: input.model,
    passed: input.passed,
    hallRate: input.hallRate,
    missRate: input.missRate,
    hazards: input.hazards,
    shapeConformance: input.shapeConformance,
    totals: input.totals,
    leafPaths: [...input.leafPaths],
    transcripts: input.reports.map((r) => ({
      slug: r.slug,
      status: r.status === "scored" ? "scored" : "unscored",
      problem: r.problem,
    })),
    grid,
  };
}

/**
 * Projects a run down to the one line appended to `history-<backend>.jsonl`.
 * Uses the schema's own key list rather than a hand-written pick, so a field
 * added to HistoryEntrySchema cannot be silently forgotten here.
 */
export function toHistoryEntry(run: RunRecord): HistoryEntry {
  return HistoryEntrySchema.parse(run);
}
