import {
  describeExtraction,
  enveloped,
  parseSchemaPlan,
  plannedPerGroupPlan,
  walkFieldInventory,
} from "@azx/ribo-core";
import type {
  ChatClient,
  ChatRequest,
  ExtractionTarget,
  PlannedPerGroupPlan,
  SchemaMeasures,
  SchemaPlan,
  SchemaPlanPiece,
} from "@azx/ribo-core";
import type { z } from "zod";

import { schemaPlanFreshness } from "../schema-plan/freshness.js";
import type { SplitCapOptions } from "./calls.js";
import { SchemaInspectError } from "./error.js";
import type { ThresholdRow, WorstPieceReport } from "./report-schema.js";

const TARGET_NAME = "ribo-inspect";

type DryRunTarget = ExtractionTarget<Record<string, unknown>> & {
  readonly extractionSchema: z.ZodObject;
};
type DryRunPlan = PlannedPerGroupPlan<Record<string, unknown>>;

/** One reviewed semantic piece before core's cap packer runs. */
export interface PlannedSemanticPieceRow extends SchemaMeasures {
  readonly name: string;
  readonly key: string;
  readonly paths: readonly string[];
  readonly packedCount: number;
}

/** One actual request target emitted by core's planned dry run. */
export interface PlannedPackedCallRow extends SchemaMeasures {
  readonly semantic: string;
  readonly key: string;
  readonly requestName: string;
  readonly paths: readonly string[];
  readonly callIndex: number;
  readonly callCount: number;
}

/** The complete, model-free planned layout; construction failures throw instead. */
export interface PlannedInspection {
  readonly semanticPieces: readonly PlannedSemanticPieceRow[];
  readonly packedCalls: readonly PlannedPackedCallRow[];
  readonly totals: {
    readonly semanticPieces: number;
    readonly packedCalls: number;
  };
  readonly notes: readonly string[];
  readonly worstPackedCall: PlannedPackedCallRow;
}

/** Explicit inputs for a planned dry run over an already converted document. */
export interface InspectPlannedOptions {
  readonly document: unknown;
  readonly schema: z.ZodObject;
  readonly plan: SchemaPlan;
  readonly caps: SplitCapOptions;
}

/** Inputs for selecting the one measured call set a piece threshold judges. */
export interface SelectPieceCharsThresholdOptions {
  readonly limit: number;
  readonly ruleBased?: WorstPieceReport | null;
  readonly planned?: PlannedPackedCallRow | null;
}

class PlannedInspectionChatInvoked extends Error {
  constructor(request: ChatRequest) {
    super(
      `plannedPerGroupPlan construction made a chat call it must never make ` +
        `(schema name "${request.responseFormat.json_schema.name}").`,
    );
    this.name = "PlannedInspectionChatInvoked";
  }
}

const neverCalledChat = (): ChatClient => ({
  complete: (request: ChatRequest) => {
    throw new PlannedInspectionChatInvoked(request);
  },
});

const faultMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function targetFor(schema: z.ZodObject): DryRunTarget {
  return {
    name: TARGET_NAME,
    extractionSchema: enveloped(schema),
    instructions: "",
    examples: [],
  };
}

function compile(schema: z.ZodObject, plan: SchemaPlan, caps: SplitCapOptions): DryRunPlan {
  return plannedPerGroupPlan({
    target: targetFor(schema),
    plan,
    chat: neverCalledChat(),
    model: TARGET_NAME,
    ...caps,
  });
}

function targetsByKey(compiled: DryRunPlan): ReadonlyMap<string, readonly DryRunTarget[]> {
  const byKey = new Map<string, readonly DryRunTarget[]>();
  for (const [key, value] of Object.entries(compiled.targets as Record<string, unknown>)) {
    byKey.set(key, (Array.isArray(value) ? value : [value]) as DryRunTarget[]);
  }
  return byKey;
}

function semanticTargets(
  compiled: DryRunPlan,
  plan: SchemaPlan,
): readonly { readonly piece: SchemaPlanPiece; readonly target: DryRunTarget }[] {
  const byKey = targetsByKey(compiled);
  const cursors = new Map<string, number>();
  return plan.pieces.map((piece) => {
    const targets = byKey.get(piece.key) ?? [];
    const cursor = cursors.get(piece.key) ?? 0;
    const target = targets[cursor];
    if (target === undefined) {
      throw new Error(
        `planned inspection: semantic dry run produced no target for piece "${piece.name}" ` +
          `under "${piece.key}".`,
      );
    }
    cursors.set(piece.key, cursor + 1);
    return { piece, target };
  });
}

function packedTargetsFor(
  semantic: DryRunTarget,
  piece: SchemaPlanPiece,
  byKey: ReadonlyMap<string, readonly DryRunTarget[]>,
): readonly DryRunTarget[] {
  const targets = (byKey.get(piece.key) ?? []).filter(
    (target) => target.name === semantic.name || target.name.startsWith(`${semantic.name}-`),
  );
  if (targets.length === 0) {
    throw new Error(
      `planned inspection: packed dry run produced no target for semantic piece "${piece.name}".`,
    );
  }
  return targets;
}

function measures(schema: z.ZodType): SchemaMeasures {
  const whole = describeExtraction({ extractionSchema: schema }).whole;
  if (whole === undefined) {
    throw new Error(
      "planned inspection: core returned no whole-schema measures for a dry-run target.",
    );
  }
  return { ...whole };
}

function paths(target: DryRunTarget): readonly string[] {
  return walkFieldInventory(target.extractionSchema).map((field) => field.path);
}

function constructionRefusal(error: unknown): SchemaInspectError {
  return new SchemaInspectError(
    `planned inspection could not construct the planned call layout: ${faultMessage(error)}`,
  );
}

/**
 * Derive semantic and actual packed layouts through core's public dry run. Stale membership and
 * construction incompatibilities are command faults, never partial measurements or report findings.
 */
export function inspectPlanned({
  document,
  schema,
  plan,
  caps,
}: InspectPlannedOptions): PlannedInspection {
  const freshness = schemaPlanFreshness(document, plan);
  if (freshness.status === "stale") {
    throw new SchemaInspectError(
      `planned inspection refused a stale schema plan: ${freshness.notes.join("; ")}; ` +
        `fix: ${freshness.fix ?? "ribo schema plan --update"}`,
    );
  }

  let parsed: SchemaPlan;
  try {
    parsed = parseSchemaPlan(plan, schema);
  } catch (error) {
    throw new SchemaInspectError(
      `planned inspection could not construct the reviewed plan against the converted schema: ` +
        faultMessage(error),
    );
  }

  try {
    // An infinite union cap and no byte cap leave one dry-run target per semantic piece. The second
    // compilation receives exactly the caller's caps; threshold limits never enter either call.
    const semantic = compile(schema, parsed, {
      maxNullableUnionsPerGroup: Number.POSITIVE_INFINITY,
    });
    const packed = compile(schema, parsed, caps);
    const packedByKey = targetsByKey(packed);
    const packedCalls: PlannedPackedCallRow[] = [];
    const semanticPieces = semanticTargets(semantic, parsed).map(({ piece, target }) => {
      const actual = packedTargetsFor(target, piece, packedByKey);
      const firstCallIndex = packedCalls.length;
      packedCalls.push(
        ...actual.map((call, index) => ({
          semantic: piece.name,
          key: piece.key,
          requestName: call.name,
          paths: paths(call),
          callIndex: index + 1,
          callCount: actual.length,
          ...measures(call.extractionSchema),
        })),
      );
      return {
        name: piece.name,
        key: piece.key,
        paths: [...piece.paths],
        packedCount: packedCalls.length - firstCallIndex,
        ...measures(target.extractionSchema),
      };
    });
    const first = packedCalls[0];
    if (first === undefined) {
      throw new Error("planned inspection: core produced no packed calls for a non-empty plan.");
    }
    const worstPackedCall = packedCalls.reduce(
      (worst, row) => (row.serializedChars > worst.serializedChars ? row : worst),
      first,
    );
    return {
      semanticPieces,
      packedCalls,
      totals: { semanticPieces: semanticPieces.length, packedCalls: packedCalls.length },
      notes: freshness.notes,
      worstPackedCall,
    };
  } catch (error) {
    if (error instanceof PlannedInspectionChatInvoked) throw error;
    throw constructionRefusal(error);
  }
}

const ruleBasedLabel = (piece: WorstPieceReport): string =>
  piece.part === undefined ? piece.key : `${piece.key}-${piece.part}`;

/**
 * Select the only piece-character measurement a threshold may judge: planned packed calls whenever
 * a plan was requested, otherwise the existing rule-based worst piece.
 */
export function selectPieceCharsThreshold({
  limit,
  ruleBased,
  planned,
}: SelectPieceCharsThresholdOptions): ThresholdRow {
  if (planned !== undefined && planned !== null) {
    return {
      measure: "pieceChars",
      limit,
      measured: planned.serializedChars,
      breached: planned.serializedChars > limit,
      piece: planned.requestName,
    };
  }
  const measured = ruleBased?.serializedChars ?? null;
  return {
    measure: "pieceChars",
    limit,
    measured,
    breached: measured !== null && measured > limit,
    ...(ruleBased === undefined || ruleBased === null ? {} : { piece: ruleBasedLabel(ruleBased) }),
  };
}
