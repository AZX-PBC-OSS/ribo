import { parseSchemaPlan, schemaPlanSchema, SCHEMA_PLAN_CONTRACT_VERSION } from "@azx/ribo-core";
import type { ChatClient, SchemaPlan, SchemaPlanPiece } from "@azx/ribo-core";

import { convertDocument } from "./inspect/convert.js";
import { walkFieldInventory } from "./inspect/field-inventory.js";
import { schemaFingerprint } from "./inspect/fingerprint.js";
import { proposeSchemaPlanPieces } from "./schema-plan/propose.js";

export { schemaPlanFreshness } from "./schema-plan/freshness.js";
export type { SchemaPlanFreshness, SchemaPlanFreshnessStatus } from "./schema-plan/freshness.js";

/** Configuration for {@link planSchema}; all model traffic and time are injected. */
export interface PlanSchemaOptions {
  /** The transport used when semantic planning is necessary. Zero-call updates may omit it. */
  readonly chat?: ChatClient;
  /** Model name stamped into provenance after a successful planning call. */
  readonly model: string;
  /** Backend name stamped beside that model. */
  readonly backend: string;
  /** A stored artifact to update incrementally; absence requests an initial plan. */
  readonly existingPlan?: SchemaPlan;
  /** Injected completion time for a real planning call. Never read by a zero-call update. */
  readonly clock?: () => Date;
}

function provenance(options: PlanSchemaOptions): SchemaPlan["provenance"] {
  const now = options.clock === undefined ? new Date() : options.clock();
  return { model: options.model, backend: options.backend, createdAt: now.toISOString() };
}

function mergeAdditions(
  surviving: readonly SchemaPlanPiece[],
  proposed: readonly SchemaPlanPiece[],
): SchemaPlanPiece[] {
  const pieces = surviving.map((piece) => ({ ...piece, paths: [...piece.paths] }));
  const targets = new Map(pieces.map((piece) => [piece.name, piece]));
  const created: SchemaPlanPiece[] = [];

  for (const piece of proposed) {
    const target = targets.get(piece.name);
    if (target === undefined) {
      const addition = { ...piece, paths: [...piece.paths] };
      targets.set(addition.name, addition);
      created.push(addition);
    } else {
      target.paths.push(...piece.paths);
    }
  }
  return [...pieces, ...created];
}

/**
 * Author or incrementally update a core schema plan over an OpenAPI 3.0 JSON Schema document.
 *
 * Code owns the contract version, inspect fingerprint, schema-ordered complete inventory and exact
 * coverage. The injected model owns only semantic piece naming and placement. Updates filter
 * vanished paths, lock every surviving assignment and relative order, and ask the model to place
 * additions only. An update with no additions performs no chat or clock call and preserves the
 * stored provenance. Invalid replies receive bounded named-feedback repairs; exhaustion throws and
 * never returns a partial artifact.
 */
export async function planSchema(
  document: unknown,
  options: PlanSchemaOptions,
): Promise<SchemaPlan> {
  const schema = convertDocument(document);
  const inventory = walkFieldInventory(schema);
  const fieldPaths = inventory.map((entry) => entry.path);
  const fingerprint = schemaFingerprint(document);

  if (options.existingPlan === undefined) {
    const pieces = await proposeSchemaPlanPieces({
      chat: options.chat,
      document,
      inventory,
      model: options.model,
    });
    return parseSchemaPlan(
      {
        version: SCHEMA_PLAN_CONTRACT_VERSION,
        schemaFingerprint: fingerprint,
        fieldPaths,
        pieces,
        provenance: provenance(options),
      },
      schema,
    );
  }

  const existing = schemaPlanSchema.parse(options.existingPlan);
  const currentPaths = new Set(fieldPaths);
  const storedPaths = new Set(existing.fieldPaths);
  const additions = fieldPaths.filter((path) => !storedPaths.has(path));
  const surviving = existing.pieces
    .map((piece) => ({
      ...piece,
      paths: piece.paths.filter((path) => currentPaths.has(path)),
    }))
    .filter((piece) => piece.paths.length > 0);
  const refreshed = {
    version: SCHEMA_PLAN_CONTRACT_VERSION,
    schemaFingerprint: fingerprint,
    fieldPaths,
    provenance: existing.provenance,
  } as const;

  if (additions.length === 0) {
    return parseSchemaPlan({ ...refreshed, pieces: surviving }, schema);
  }

  const proposed = await proposeSchemaPlanPieces({
    chat: options.chat,
    document,
    inventory,
    model: options.model,
    existingPieces: surviving,
    additions,
  });
  const pieces = mergeAdditions(surviving, proposed);
  // Prove the semantic merge before reading the clock: a failed update cannot acquire fresh
  // provenance or look like a real planning call.
  parseSchemaPlan({ ...refreshed, pieces }, schema);
  return parseSchemaPlan({ ...refreshed, pieces, provenance: provenance(options) }, schema);
}
