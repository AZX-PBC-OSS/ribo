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

const PlannedSemanticPieces = Measures.extend({
  /** The reviewed semantic piece's name. */
  name: z.string(),
  /** The top-level key that owns the piece. */
  key: z.string(),
  /** Leaf paths in reviewed plan order. */
  paths: z.array(z.string()),
  /** Actual packed calls core produced from this semantic piece. */
  packedCount: z.number(),
});

const PlannedPackedCalls = Measures.extend({
  /** The semantic piece this actual call belongs to. */
  semantic: z.string(),
  /** The top-level key that owns the call. */
  key: z.string(),
  /** Core's actual request-target name. */
  requestName: z.string(),
  /** Leaf paths carried by this packed call. */
  paths: z.array(z.string()),
  /** One-based index within the semantic piece's packed calls. */
  callIndex: z.number(),
  /** Total packed calls for the semantic piece. */
  callCount: z.number(),
});

/** One threshold comparison and the layout whose measurement it judges. */
export const ThresholdRowSchema = z
  .object({
    measure: z.enum(["depth", "pieceChars"]),
    /** Depth is shared; piece size explicitly names the rule-based or planned call set. */
    layout: z.enum(["rule-based", "planned", "shared"]),
    /** The supplied limit. */
    limit: z.number(),
    /** The measured value; `null` when the underlying measure is unavailable. */
    measured: z.number().nullable(),
    breached: z.boolean(),
    /** The exact judged piece or packed call; never present on shared depth. */
    piece: z.string().optional(),
  })
  .superRefine((row, context) => {
    if (row.measure === "depth" && (row.layout !== "shared" || row.piece !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "depth thresholds require the shared layout and omit piece",
      });
    }
    if (row.measure === "pieceChars" && row.layout === "shared") {
      context.addIssue({
        code: "custom",
        message: "pieceChars thresholds require a rule-based or planned layout",
      });
    }
  });

/**
 * The version of the report's JSON contract (design §7). Owned by the CLI and
 * bumped when a field is added or its meaning changes — numbers computed by
 * unchanged core symbols do not bump it. v2 grew the v1 skeleton report
 * (contract, versions, `leafCount`) to the full sizing report; v3 corrected
 * the inventory to count schema FIELDS, not provenance-envelope members, and
 * added `splitCaps` and the split-cap options. v4 adds planned semantic and
 * packed-call measurements, core's plan identity, and explicit threshold layouts.
 * v5 pairs every nullable call count with the reason it is null — a null count
 * without its reason fails the parse, and a non-null count carrying one does too.
 *
 * It lives beside the zod `contractVersion` literal below so the writer, the
 * exported schema and the exported constant cannot drift apart.
 */
export const CONTRACT_VERSION = 5;

/**
 * The per-strategy call counts. The refine is the null-count contract v5
 * added: a nullable count carries its reason — the reason a reader needs
 * when the count is absent — and a non-null count carries none, since a
 * number that explains itself would drift from the number.
 */
const CallsSchema = z
  .object({
    singleShot: z.number().nullable(),
    /** Present exactly when `singleShot` is `null` — why it is. */
    singleShotReason: z.string().optional(),
    perGroup: z.number().nullable(),
    /** Present exactly when `perGroup` is `null` — why it is. */
    perGroupReason: z.string().optional(),
    presenceNarrowedAtMost: z.number().nullable(),
    /** Present exactly when `presenceNarrowedAtMost` is `null` — why it is. */
    presenceNarrowedReason: z.string().optional(),
    consensusPerCandidate: z.number().nullable(),
    /** Present exactly when `consensusPerCandidate` is `null` — why it is. */
    consensusReason: z.string().optional(),
    maxRetriesDefault: z.number(),
  })
  .superRefine((calls, context) => {
    const pairs: readonly (readonly [string, number | null, string | undefined])[] = [
      ["single-shot", calls.singleShot, calls.singleShotReason],
      ["per-group", calls.perGroup, calls.perGroupReason],
      ["presence-narrowed", calls.presenceNarrowedAtMost, calls.presenceNarrowedReason],
      ["consensus", calls.consensusPerCandidate, calls.consensusReason],
    ];
    for (const [name, count, reason] of pairs) {
      if (count === null && reason === undefined) {
        context.addIssue({
          code: "custom",
          message: `the ${name} call count is null without its reason`,
        });
      }
      if (count !== null && reason !== undefined) {
        context.addIssue({
          code: "custom",
          message: `the ${name} call count is not null and carries a reason`,
        });
      }
    }
  });

/**
 * The versioned report's serialized shape, as a zod schema. Exported so the bin, and
 * any consumer scripting against the contract, validate against the same
 * shape the entry parses every report through before returning.
 */
export const SchemaInspectReportSchema = z.object({
  /** The version of this JSON contract itself — see `CONTRACT_VERSION`. */
  contractVersion: z.literal(5),
  /** The `@azx/ribo-cli` version that produced the numbers. */
  cliVersion: z.string(),
  /** The `@azx/ribo-core` version the measures were computed with. */
  coreVersion: z.string(),
  /** 64 lowercase hex characters: SHA-256 over the document's canonical JSON. */
  schemaFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  /** Core's canonical semantic plan identity; present only for planned inspection. */
  planFingerprint: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  /** Planned semantic pieces and the actual packed calls measured under the split caps. */
  planned: z
    .object({
      semanticPieces: z.array(PlannedSemanticPieces),
      packedCalls: z.array(PlannedPackedCalls),
      totals: z.object({ semanticPieces: z.number(), packedCalls: z.number() }),
      notes: z.array(z.string()),
    })
    .optional(),
  /** Supported schema fields, one per provenance envelope — see `walkFieldInventory`. */
  leafCount: z.number(),
  /**
   * The split configuration the report's partition was computed under, for a
   * consumer reproducing the numbers: the byte cap (`null` — off, the library
   * carries no provider's number, ADR 0015) and the union cap (the supplied
   * value, or core's `MAX_NULLABLE_UNIONS_PER_CALL` default).
   */
  splitCaps: z.object({
    maxSerializedCharsPerGroup: z.number().nullable(),
    maxNullableUnionsPerGroup: z.number(),
  }),
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
  calls: CallsSchema.optional(),
  /**
   * Described fields over walked fields, by `renderFieldGuidance`'s own filter
   * (`description !== undefined`); `ratio` is `0` when `total` is `0`.
   */
  guidanceCoverage: z.object({
    described: z.number(),
    total: z.number(),
    ratio: z.number(),
  }),
  /** One finding per field whose description asks for reformatting; empty when none. */
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
  thresholds: z.array(ThresholdRowSchema).optional(),
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

/** One reviewed semantic piece before core's cap packer runs. */
export interface PlannedSemanticPieceReport extends MeasuresReport {
  name: string;
  key: string;
  paths: string[];
  packedCount: number;
}

/** One actual packed request target emitted by core's planned dry run. */
export interface PlannedPackedCallReport extends MeasuresReport {
  semantic: string;
  key: string;
  requestName: string;
  paths: string[];
  callIndex: number;
  callCount: number;
}

/** The planned semantic layout and the actual calls it becomes under the caps. */
export interface PlannedInspectionReport {
  semanticPieces: PlannedSemanticPieceReport[];
  packedCalls: PlannedPackedCallReport[];
  totals: { semanticPieces: number; packedCalls: number };
  notes: string[];
}

/** One supplied threshold's comparison, as data for the flags ticket to read. */
export interface ThresholdRow {
  measure: "depth" | "pieceChars";
  layout: "rule-based" | "planned" | "shared";
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
 * The versioned report `inspectSchema` returns (design §7). v5 pairs every
 * nullable call count with its reason and leaves the v4 rows untouched: the
 * rule-based measurements and the planned rows read exactly as they did.
 */
export interface SchemaInspectReport {
  /** The version of this JSON contract itself (see `CONTRACT_VERSION`). */
  contractVersion: 5;
  /** The `@azx/ribo-cli` version that produced the numbers. */
  cliVersion: string;
  /** The `@azx/ribo-core` version the measures were computed with. */
  coreVersion: string;
  /** SHA-256 over the document's canonical JSON — 64 lowercase hex characters. */
  schemaFingerprint: string;
  /** Core's canonical semantic plan identity; present only for planned inspection. */
  planFingerprint?: string;
  /** Planned semantic and packed-call measurements; present only with a plan. */
  planned?: PlannedInspectionReport;
  /** Supported schema fields, one per provenance envelope (see `walkFieldInventory`). */
  leafCount: number;
  /** The split configuration the partition was computed under (see the zod copy above). */
  splitCaps: {
    maxSerializedCharsPerGroup: number | null;
    maxNullableUnionsPerGroup: number;
  };
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
    /** Present exactly when `singleShot` is `null`. */
    singleShotReason?: string;
    perGroup: number | null;
    /** Present exactly when `perGroup` is `null`. */
    perGroupReason?: string;
    presenceNarrowedAtMost: number | null;
    /** Present exactly when `presenceNarrowedAtMost` is `null`. */
    presenceNarrowedReason?: string;
    consensusPerCandidate: number | null;
    /** Present exactly when `consensusPerCandidate` is `null`. */
    consensusReason?: string;
    maxRetriesDefault: number;
  };
  /** Described fields over walked fields. */
  guidanceCoverage: GuidanceCoverage;
  /** Fields whose description asks for reformatting. */
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
