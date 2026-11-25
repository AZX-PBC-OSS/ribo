import { z } from "zod";

import { walkFieldInventory } from "./field-inventory.js";

/** The schema-plan artifact contract version.
 *
 * @category Extraction
 */
export const SCHEMA_PLAN_CONTRACT_VERSION = 1;

const fingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const pathSchema = z.string().min(1);

const schemaPlanProvenanceSchema = z.strictObject({
  /** The model that authored or last semantically updated the plan. */
  model: z.string().min(1),
  /** The backend through which that model ran. */
  backend: z.string().min(1),
  /** When that planning call completed. */
  createdAt: z.iso.datetime(),
});

const schemaPlanPieceSchema = z.strictObject({
  /** A unique, human-reviewable semantic label. */
  name: z.string().min(1),
  /** What belongs together in this piece, and why. */
  description: z.string().min(1),
  /** The one top-level schema key every path in this piece belongs to. */
  key: z.string().min(1),
  /** Ordered, element-relative dotted leaf paths owned by this piece. */
  paths: z.array(pathSchema).min(1),
});

const duplicateValues = (values: readonly string[]): string[] => {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
};

const schemaPlanObjectSchema = z.strictObject({
  /** The artifact contract version. */
  version: z.literal(SCHEMA_PLAN_CONTRACT_VERSION),
  /** The inspect fingerprint of the schema from which the plan was authored. */
  schemaFingerprint: fingerprintSchema,
  /** The complete field set, stored in schema inventory order by the artifact author. */
  fieldPaths: z.array(pathSchema).min(1),
  /** Ordered semantic pieces; path order inside each piece is meaningful. */
  pieces: z.array(schemaPlanPieceSchema).min(1),
  /** The planning call responsible for the current semantic assignments. */
  provenance: schemaPlanProvenanceSchema,
});

/**
 * The strict schema-plan artifact contract, including internal coverage and naming invariants.
 * Use {@link parseSchemaPlan} to also check coverage against a concrete extraction schema.
 *
 * @category Extraction
 */
export const schemaPlanSchema = schemaPlanObjectSchema.superRefine((plan, ctx) => {
  for (const path of duplicateValues(plan.fieldPaths)) {
    ctx.addIssue({
      code: "custom",
      path: ["fieldPaths"],
      message: `duplicate root field path "${path}"`,
    });
  }

  const piecePaths: string[] = [];
  const names = new Set<string>();
  const ownedPaths = new Set<string>();
  for (const [pieceIndex, piece] of plan.pieces.entries()) {
    if (names.has(piece.name)) {
      ctx.addIssue({
        code: "custom",
        path: ["pieces", pieceIndex, "name"],
        message: `duplicate piece name "${piece.name}"`,
      });
    }
    names.add(piece.name);

    for (const [pathIndex, path] of piece.paths.entries()) {
      piecePaths.push(path);
      if (ownedPaths.has(path)) {
        ctx.addIssue({
          code: "custom",
          path: ["pieces", pieceIndex, "paths", pathIndex],
          message: `duplicate planned path "${path}"`,
        });
      }
      ownedPaths.add(path);

      if (path.split(".")[0] !== piece.key) {
        ctx.addIssue({
          code: "custom",
          path: ["pieces", pieceIndex, "paths", pathIndex],
          message: `path "${path}" crosses the piece's top-level key "${piece.key}"`,
        });
      }
    }
  }

  const rootPaths = new Set(plan.fieldPaths);
  const flattenedPaths = new Set(piecePaths);
  const missingFromPieces = plan.fieldPaths.filter((path) => !flattenedPaths.has(path));
  const missingFromRoot = piecePaths.filter((path) => !rootPaths.has(path));
  if (missingFromPieces.length > 0 || missingFromRoot.length > 0) {
    ctx.addIssue({
      code: "custom",
      path: ["fieldPaths"],
      message:
        "root fieldPaths and piece membership disagree: " +
        `missing from pieces [${[...new Set(missingFromPieces)].join(", ")}]; ` +
        `missing from root [${[...new Set(missingFromRoot)].join(", ")}]`,
    });
  }
});

/** Planning provenance carried by a {@link SchemaPlan}.
 *
 * @category Extraction
 */
export type SchemaPlanProvenance = z.infer<typeof schemaPlanProvenanceSchema>;

/** One named semantic partition of a schema plan.
 *
 * @category Extraction
 */
export type SchemaPlanPiece = z.infer<typeof schemaPlanPieceSchema>;

/** A parsed, versioned semantic partition over a schema's complete field inventory.
 *
 * @category Extraction
 */
export type SchemaPlan = z.infer<typeof schemaPlanObjectSchema>;

/**
 * Parse a JSON value as a schema plan and require exact, once-only coverage of the supplied
 * schema's real field inventory. The input is data, never a filename; no stored arrays are
 * reordered or repaired.
 *
 * @category Extraction
 */
export function parseSchemaPlan(value: unknown, schema: z.ZodObject): SchemaPlan {
  const plan = schemaPlanSchema.parse(value);
  const inventoryPaths = walkFieldInventory(schema).map((entry) => entry.path);
  const knownPaths = new Set(inventoryPaths);
  const plannedPaths = new Set(plan.fieldPaths);
  const unknown = plan.fieldPaths.filter((path) => !knownPaths.has(path));
  const omitted = inventoryPaths.filter((path) => !plannedPaths.has(path));

  if (unknown.length > 0 || omitted.length > 0) {
    throw new Error(
      "parseSchemaPlan(): plan coverage does not match the schema field inventory: " +
        `unknown paths [${unknown.join(", ")}]; omitted paths [${omitted.join(", ")}]`,
    );
  }
  return plan;
}

/**
 * Return the canonical asynchronous SHA-256 identity of a plan's semantics. The material covers
 * the contract version, a lexically sorted copy of the complete field set, and pieces in plan
 * order with their ordered paths. Stored schema fingerprint and planning provenance are excluded.
 *
 * @category Extraction
 */
export async function planFingerprint(plan: SchemaPlan): Promise<string> {
  const material = JSON.stringify([
    plan.version,
    [...plan.fieldPaths].sort(),
    plan.pieces.map((piece) => [piece.name, piece.description, piece.key, piece.paths]),
  ]);
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
