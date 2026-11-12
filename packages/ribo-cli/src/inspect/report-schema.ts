import { z } from "zod";

/**
 * @file The versioned `--json` contract (design §7): the report's serialized
 * shape, zod-parsed at the boundary — the repo's zod-at-trust-boundaries rule
 * applied to the contract itself. Field names below are the contract consumers
 * (the bin, and the tickets that script against it) read; fields are added or
 * reworded only with a `CONTRACT_VERSION` bump.
 *
 * Presence rules mirror `describeExtraction`'s: fields derived from it are
 * absent exactly where its own rows are absent (a derive-stage refusal leaves
 * no `keys`/`path`/`whole`/`pieces`/`calls`); inventory-derived fields stand
 * whenever the walk succeeds. The report never invents a value for something
 * it cannot see.
 */

const Measures = z.object({
  /** Nullable unions in the serialized response schema — the union cap's unit. */
  nullableUnions: z.number(),
  /** Serialized JSON Schema characters — the byte cap's unit. */
  serializedChars: z.number(),
  /** Nesting depth of the serialized rendering, as raw JSON nesting. */
  depth: z.number(),
});

/**
 * The report's serialized shape, as a zod schema. Exported so the bin, and
 * any consumer scripting against the contract, validate against the same
 * shape the entry parses every report through before returning.
 */
export const SchemaInspectReportSchema = z.object({
  /** The version of this JSON contract itself — see `CONTRACT_VERSION`. */
  contractVersion: z.literal(2),
  /** The `@azx/ribo-cli` version that produced the numbers. */
  cliVersion: z.string(),
  /** The `@azx/ribo-core` version the measures were computed with. */
  coreVersion: z.string(),
  /** 64 lowercase hex characters: SHA-256 over the document's canonical JSON. */
  schemaFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  /** Supported leaves the schema carries, per `walkLeafInventory`. */
  leafCount: z.number(),
  /** Top-level group keys — present whenever the derive stage survived. */
  groupCount: z.number().optional(),
  /** Top-level loose (non-group) keys — present whenever the derive survived. */
  looseKeyCount: z.number().optional(),
  /** The top-level keys by kind — the split's own classification. */
  keys: z.array(z.object({ key: z.string(), kind: z.enum(["group", "loose"]) })).optional(),
  /** The split path — present whenever the derive stage survived. */
  path: z.enum(["grouped", "flat"]).optional(),
  /** Why the flat path applies — present exactly when `path` is `"flat"`. */
  flatReason: z
    .union([
      z.object({ kind: z.literal("not-an-object") }),
      z.object({ kind: z.literal("empty") }),
      z.object({ kind: z.literal("loose-keys"), keys: z.array(z.string()) }),
    ])
    .optional(),
  /** The call shape `schemaExtractor` would select. */
  callShape: z.enum(["single-shot", "per-group"]).optional(),
  /** The whole schema's three measures. */
  whole: Measures.optional(),
  /**
   * Per-piece rows — one per chat call the split produces, `key`/`part`/
   * `parts` read off the split's own entries. Absent exactly when
   * `describeExtraction` carries no pieces.
   */
  pieces: z
    .array(
      Measures.extend({
        /** The piece's group key; the unwrapped portion shares `""`. */
        key: z.string(),
        /** The 0-based part index of a partitioned piece. */
        part: z.number().optional(),
        /** The total part count of a partitioned piece. */
        parts: z.number().optional(),
      }),
    )
    .optional(),
  /**
   * The piece with the largest `serializedChars` (ties: first in split order);
   * `null` when there are no pieces.
   */
  worstPiece: z
    .object({
      key: z.string(),
      part: z.number().optional(),
      serializedChars: z.number(),
    })
    .nullable(),
  /** The per-strategy call counts — present whenever the derive survived. */
  calls: z
    .object({
      singleShot: z.number().nullable(),
      perGroup: z.number().nullable(),
      perGroupReason: z.string().optional(),
      presenceNarrowedAtMost: z.number().nullable(),
      consensusPerCandidate: z.number().nullable(),
      maxRetriesDefault: z.number(),
    })
    .optional(),
  /**
   * Described leaves over walked leaves, by `renderFieldGuidance`'s own filter
   * (`description !== undefined`); `ratio` is `0` when `total` is `0`.
   */
  guidanceCoverage: z.object({
    described: z.number(),
    total: z.number(),
    ratio: z.number(),
  }),
  /** One finding per leaf whose description asks for reformatting; empty when none. */
  reformatFindings: z.array(
    z.object({ path: z.string(), description: z.string(), directive: z.string() }),
  ),
  /**
   * EVERY group not derived at `"leaf"` provenance granularity — collected,
   * not first-only. Over a document every group reports as apparent
   * granularity `"none"`, because a document cannot carry provenance
   * envelopes; deriving at `"leaf"` granularity is what clears the list, and
   * it is what the judging combinators need.
   */
  granularityViolations: z.array(
    z.object({ group: z.string(), granularity: z.enum(["row", "none"]) }),
  ),
  /**
   * The construct classes a JSON Schema input cannot carry, named honestly —
   * always present, never detected, never guessed.
   */
  notVisible: z.array(z.object({ construct: z.string(), detail: z.string() })),
  /**
   * One row per supplied threshold — present only when an option was supplied.
   * Thresholds are comparisons the CLI makes on reported numbers, never fed
   * into the split.
   */
  thresholds: z
    .array(
      z.object({
        measure: z.enum(["depth", "pieceChars"]),
        /** The supplied limit. */
        limit: z.number(),
        /** The measured value; `null` when the underlying measure is unavailable. */
        measured: z.number().nullable(),
        breached: z.boolean(),
        /** The worst piece's name, for `pieceChars`. */
        piece: z.string().optional(),
      }),
    )
    .optional(),
  /**
   * The refusal construction would raise, carried verbatim — a finding, not a
   * failure (design §4).
   */
  refusal: z.object({ stage: z.enum(["derive", "name", "split"]), message: z.string() }).optional(),
});

/** One top-level key, by the split's own classification. */
export interface SchemaKey {
  key: string;
  kind: "group" | "loose";
}

/** Why the flat path applies — present exactly when `path` is `"flat"`. */
export type FlatReasonReport =
  { kind: "not-an-object" } | { kind: "empty" } | { kind: "loose-keys"; keys: string[] };

/** The three measures, for the whole schema or a piece. */
export interface MeasuresReport {
  nullableUnions: number;
  serializedChars: number;
  depth: number;
}

/** One piece the described schema would become: one chat call's share. */
export interface PieceMeasuresReport extends MeasuresReport {
  key: string;
  part?: number;
  parts?: number;
}

/** The piece with the largest `serializedChars`; `null` when there are no pieces. */
export interface WorstPieceReport {
  key: string;
  part?: number;
  serializedChars: number;
}

/** Guidance coverage over the leaf inventory. */
export interface GuidanceCoverage {
  described: number;
  total: number;
  ratio: number;
}

/** One reformat-lint finding. */
export interface ReformatFinding {
  path: string;
  description: string;
  directive: string;
}

/** One leaf-granularity violation. */
export interface GranularityViolation {
  group: string;
  granularity: "row" | "none";
}

/** One construct class the input cannot carry. */
export interface NotVisibleConstruct {
  construct: string;
  detail: string;
}

/** One supplied threshold's comparison, as data for the flags ticket to read. */
export interface ThresholdRow {
  measure: "depth" | "pieceChars";
  limit: number;
  measured: number | null;
  breached: boolean;
  piece?: string;
}

/** The refusal construction would raise, carried verbatim. */
export interface RefusalReport {
  stage: "derive" | "name" | "split";
  message: string;
}

/**
 * The versioned report `inspectSchema` returns (design §7). Grows additively
 * from v1 — `leafCount` stays exactly where v1 put it; `contractVersion` is
 * `2` because fields were added.
 */
export interface SchemaInspectReport {
  /** The version of this JSON contract itself (see `CONTRACT_VERSION`). */
  contractVersion: 2;
  /** The `@azx/ribo-cli` version that produced the numbers. */
  cliVersion: string;
  /** The `@azx/ribo-core` version the measures were computed with. */
  coreVersion: string;
  /** SHA-256 over the document's canonical JSON — 64 lowercase hex characters. */
  schemaFingerprint: string;
  /** Supported leaves the schema carries, per `walkLeafInventory`. */
  leafCount: number;
  /** Top-level group keys, per `describeExtraction`'s classification. */
  groupCount?: number;
  /** Top-level loose keys, per the same classification. */
  looseKeyCount?: number;
  /** The top-level keys by kind. */
  keys?: SchemaKey[];
  /** The split path. */
  path?: "grouped" | "flat";
  /** Why the flat path applies. */
  flatReason?: FlatReasonReport;
  /** The call shape `schemaExtractor` would select. */
  callShape?: "single-shot" | "per-group";
  /** The whole schema's measures. */
  whole?: MeasuresReport;
  /** Per-piece rows; absent exactly when `describeExtraction` carries none. */
  pieces?: PieceMeasuresReport[];
  /** The worst piece by serialized size; `null` when there are no pieces. */
  worstPiece: WorstPieceReport | null;
  /** The per-strategy call counts. */
  calls?: {
    singleShot: number | null;
    perGroup: number | null;
    perGroupReason?: string;
    presenceNarrowedAtMost: number | null;
    consensusPerCandidate: number | null;
    maxRetriesDefault: number;
  };
  /** Described leaves over walked leaves. */
  guidanceCoverage: GuidanceCoverage;
  /** Leaves whose description asks for reformatting. */
  reformatFindings: ReformatFinding[];
  /** Every group not at `"leaf"` granularity — collected, not first-only. */
  granularityViolations: GranularityViolation[];
  /** The construct classes the input cannot carry — always present. */
  notVisible: NotVisibleConstruct[];
  /** One row per supplied threshold; present only when an option was supplied. */
  thresholds?: ThresholdRow[];
  /** The refusal construction would raise; a finding, not a failure. */
  refusal?: RefusalReport;
}
