import { z } from "zod";

/**
 * The persisted shape of one extraction-accuracy run. Written by the manual
 * acceptance gate (`gate.manual.ts`), read by the docs site's accuracy page.
 *
 * These are PERSISTED RECORDS crossing a trust boundary — a hand-edited file, a
 * half-written line, or an artifact from an older format — so they are zod-parsed
 * on read, never cast (AGENTS §4). A malformed run must fail loudly at the docs
 * build rather than render as a plausible-looking data point.
 *
 * See docs/roadmap/design/extraction-accuracy-report-design.md.
 */

/**
 * What happened at one (leaf path, transcript) cell.
 *
 * `correct-null` is deliberately distinct from `correct`: a degenerate all-null
 * extraction scores a perfect 0% hallucination rate and is useless, so a grid
 * that painted both the same green would flatter exactly the failure the gate's
 * miss guard exists to catch.
 *
 * There is no `health-silent-not-tested` member even though `score.mjs` counts
 * `hSilentNotTested`: that case increments a counter and pushes NOTHING onto any
 * per-field list, so it cannot be attributed to a cell from the report alone. It
 * lands in `correct-null`, and the aggregate count remains available in `totals`.
 */
export const CELL_VERDICTS = [
  "correct",
  "correct-null",
  "miss",
  "miss-excused",
  "hallucination",
  "hallucination-soft",
  "sanctioned",
  "wrong",
  "unscorable",
  "health-hallucinated-pass",
  "health-hallucinated-problem",
  "health-clean-dropped",
  "health-miss",
  "health-wrong",
] as const;

export const CellVerdictSchema = z.enum(CELL_VERDICTS);

export const CellSchema = z.object({
  verdict: CellVerdictSchema,
  /** Ground truth, stringified for display. `null` when ground truth is null. */
  expected: z.string().nullable(),
  /** What the extractor produced, stringified. `null` when it produced nothing. */
  got: z.string().nullable(),
  sourceSpan: z.string().nullable(),
  /**
   * A span problem, if any — `fabricated`, `fabricated-decline`, `missing` or
   * `near-miss`. Kept SEPARATE from `verdict` because span verbatim-ness is its
   * own axis: a value can be correct and its span fabricated.
   */
  spanIssue: z.string().nullable(),
  detail: z.string().nullable(),
});

export const HazardsSchema = z.object({
  fuelDropped: z.number().int().nonnegative(),
  fuelInvented: z.number().int().nonnegative(),
  hallucinatedPass: z.number().int().nonnegative(),
  rvalueConversion: z.number().int().nonnegative(),
  enumWrongMember: z.number().int().nonnegative(),
  enumInvalid: z.number().int().nonnegative(),
  spanFabricated: z.number().int().nonnegative(),
  spanMissing: z.number().int().nonnegative(),
});

export const ShapeConformanceSchema = z.object({
  /** `false` for the `openai` backend, whose endpoint enforces shape server-side. */
  applicable: z.boolean(),
  firstTry: z.number().int().nonnegative(),
  retried: z.number().int().nonnegative(),
  never: z.number().int().nonnegative(),
});

/**
 * One line of `history-<backend>.jsonl`. Every field here also appears in a
 * RunRecord, so `RunRecordSchema` is a strict extension and `toHistoryEntry`
 * is a projection rather than a translation.
 */
export const HistoryEntrySchema = z.object({
  capturedAt: z.iso.datetime(),
  schemaFingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  /** The backend IDENTITY: `openai:<model>`, `claude-cli`, or `codex-cli`. */
  backend: z.string().min(1),
  /** The filename-safe label: the OpenAI model id, or the backend id. */
  backendLabel: z.string().min(1),
  model: z.string().min(1),
  /** Whether the gate's assertions passed. A failing run is still recorded. */
  passed: z.boolean(),
  hallRate: z.number(),
  missRate: z.number(),
  hazards: HazardsSchema,
  shapeConformance: ShapeConformanceSchema,
});

export const TranscriptColumnSchema = z.object({
  slug: z.string().min(1),
  status: z.enum(["scored", "unscored"]),
  problem: z.string().nullable(),
});

export const RunRecordSchema = HistoryEntrySchema.extend({
  /** Every raw counter from `aggregate()`, kept verbatim for anything not modelled above. */
  totals: z.record(z.string(), z.number()),
  leafPaths: z.array(z.string().min(1)),
  transcripts: z.array(TranscriptColumnSchema),
  /** `grid[leafPath][slug]` — dense: every leaf path × every transcript. */
  grid: z.record(z.string(), z.record(z.string(), CellSchema)),
});

export type CellVerdict = z.infer<typeof CellVerdictSchema>;
export type Cell = z.infer<typeof CellSchema>;
export type Hazards = z.infer<typeof HazardsSchema>;
export type ShapeConformance = z.infer<typeof ShapeConformanceSchema>;
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;
export type TranscriptColumn = z.infer<typeof TranscriptColumnSchema>;
export type RunRecord = z.infer<typeof RunRecordSchema>;
