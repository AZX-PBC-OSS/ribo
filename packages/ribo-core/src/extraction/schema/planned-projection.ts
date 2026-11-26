/**
 * @file Project a schema plan's semantic pieces without losing nested response structure.
 * Citation ownership is decided across the whole plan before any piece is projected.
 */

import { z } from "zod";

import { ROW_SOURCE_SPAN_KEY } from "../../provenance/enveloped.js";
import type { NoProvenance } from "../../provenance/enveloped.js";
import { stripOptionalNullable } from "../../provenance/field-path.js";
import { isExtractedSchema } from "../../provenance/provenance.js";
import type { ToolAdapterExample } from "../../write/adapter.js";
import type { ExtractionTarget } from "../extractor.js";
import { walkFieldInventory } from "../field-inventory.js";
import type { SchemaPlan, SchemaPlanPiece } from "../schema-plan.js";

/** A one-key target whose key is one of the original target's top-level properties. */
export type PlannedTarget<V extends Record<string, unknown>, P = NoProvenance> = {
  readonly [K in keyof V & string]: ExtractionTarget<Pick<V, K>, P>;
}[keyof V & string];

/** One semantic piece and its projected target. */
export interface PlannedProjection<V extends Record<string, unknown>, P = NoProvenance> {
  readonly piece: SchemaPlanPiece;
  readonly target: PlannedTarget<V, P>;
}

interface ProjectionNodeBase {
  readonly schema: z.ZodType;
}

interface LeafProjectionNode extends ProjectionNodeBase {
  readonly kind: "leaf";
}

interface ArrayProjectionNode extends ProjectionNodeBase {
  readonly kind: "array";
  readonly element: ProjectionNode;
}

interface ObjectProjectionNode extends ProjectionNodeBase {
  readonly kind: "object";
  readonly citation?: { readonly key: string; readonly schema: z.ZodType };
  readonly fields: readonly { readonly key: string; readonly node: ProjectionNode }[];
}

type ProjectionNode = LeafProjectionNode | ArrayProjectionNode | ObjectProjectionNode;

interface RowBoundary {
  readonly path: string;
}

const fieldAt = (shape: z.ZodObject["shape"], key: string): z.ZodType => shape[key] as z.ZodType;

const childPath = (path: string, key: string): string => `${path}.${key}`;
const isDescendant = (path: string, parent: string): boolean => path.startsWith(`${parent}.`);
const pathDepth = (path: string): number => path.split(".").length;

/** Row metadata is a plain citation at a row boundary, never an enveloped real field. */
function rowCitationKey(object: z.ZodObject, isRow: boolean): string | undefined {
  if (!isRow || !Object.hasOwn(object.shape, ROW_SOURCE_SPAN_KEY)) return undefined;
  const candidate = fieldAt(object.shape, ROW_SOURCE_SPAN_KEY);
  return isExtractedSchema(stripOptionalNullable(candidate)) ? undefined : ROW_SOURCE_SPAN_KEY;
}

/** Collect citation-bearing rows using element-relative paths, as the field inventory does. */
function collectRows(schema: z.ZodType, path: string, isRow: boolean, rows: RowBoundary[]): void {
  const stripped = stripOptionalNullable(schema);
  if (isExtractedSchema(stripped)) return;
  if (stripped instanceof z.ZodArray) {
    collectRows(stripped.element as z.ZodType, path, true, rows);
    return;
  }
  if (!(stripped instanceof z.ZodObject)) return;

  const citation = rowCitationKey(stripped, isRow);
  if (citation !== undefined) rows.push({ path });
  for (const key of Object.keys(stripped.shape)) {
    if (key === citation) continue;
    collectRows(fieldAt(stripped.shape, key), childPath(path, key), false, rows);
  }
}

/**
 * Direct leaves win before plan order is consulted. Nested descendants are considered only for a
 * row with no direct leaves anywhere in the plan.
 */
function citationOwners(schema: z.ZodObject, plan: SchemaPlan): ReadonlyMap<string, number> {
  const rows: RowBoundary[] = [];
  for (const key of Object.keys(schema.shape)) {
    collectRows(fieldAt(schema.shape, key), key, true, rows);
  }

  const owners = new Map<string, number>();
  for (const row of rows) {
    const descendants: { readonly pieceIndex: number; readonly direct: boolean }[] = [];
    for (const [pieceIndex, piece] of plan.pieces.entries()) {
      for (const path of piece.paths) {
        if (!isDescendant(path, row.path)) continue;
        descendants.push({
          pieceIndex,
          direct: pathDepth(path) === pathDepth(row.path) + 1,
        });
      }
    }
    const direct = descendants.filter((entry) => entry.direct);
    const candidates = direct.length > 0 ? direct : descendants;
    const owner = candidates.reduce<number | undefined>(
      (earliest, entry) =>
        earliest === undefined ? entry.pieceIndex : Math.min(earliest, entry.pieceIndex),
      undefined,
    );
    if (owner !== undefined) owners.set(row.path, owner);
  }
  return owners;
}

function withDescription(schema: z.ZodType, description: string | undefined): z.ZodType {
  return description === undefined ? schema : schema.describe(description);
}

/** Rebuild container wrappers in their original order; selected leaves themselves are reused. */
function reapplyWrappers(original: z.ZodType, projected: z.ZodType): z.ZodType {
  const wrappers: (z.ZodOptional | z.ZodNullable)[] = [];
  let current = original;
  while (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
    wrappers.push(current);
    current = current.unwrap() as z.ZodType;
  }
  let result = projected;
  for (let index = wrappers.length - 1; index >= 0; index -= 1) {
    result = wrappers[index] instanceof z.ZodOptional ? result.optional() : result.nullable();
  }
  return result;
}

interface ProjectionContext {
  readonly piece: SchemaPlanPiece;
  readonly pieceIndex: number;
  readonly owners: ReadonlyMap<string, number>;
  readonly selected: ReadonlySet<string>;
}

function selectedBelow(context: ProjectionContext, path: string): boolean {
  return context.piece.paths.some(
    (candidate) => candidate === path || isDescendant(candidate, path),
  );
}

function pathRank(context: ProjectionContext, path: string): number {
  return context.piece.paths.findIndex(
    (candidate) => candidate === path || isDescendant(candidate, path),
  );
}

function buildProjectionNode(
  original: z.ZodType,
  path: string,
  isRow: boolean,
  context: ProjectionContext,
): ProjectionNode | undefined {
  const stripped = stripOptionalNullable(original);
  const isContainer = stripped instanceof z.ZodArray || stripped instanceof z.ZodObject;
  if (!isContainer || isExtractedSchema(stripped)) {
    return context.selected.has(path) ? { kind: "leaf", schema: original } : undefined;
  }

  if (stripped instanceof z.ZodArray) {
    const element = buildProjectionNode(stripped.element as z.ZodType, path, true, context);
    if (element === undefined) return undefined;
    const array = withDescription(z.array(element.schema), stripped.description);
    return { kind: "array", element, schema: reapplyWrappers(original, array) };
  }

  const citationKey = rowCitationKey(stripped, isRow);
  const citation =
    citationKey !== undefined && context.owners.get(path) === context.pieceIndex
      ? { key: citationKey, schema: fieldAt(stripped.shape, citationKey) }
      : undefined;
  const fields = Object.keys(stripped.shape)
    .filter((key) => key !== citationKey)
    .map((key) => ({ key, path: childPath(path, key) }))
    .filter((entry) => selectedBelow(context, entry.path))
    .sort((left, right) => pathRank(context, left.path) - pathRank(context, right.path))
    .flatMap((entry) => {
      const node = buildProjectionNode(
        fieldAt(stripped.shape, entry.key),
        entry.path,
        false,
        context,
      );
      return node === undefined ? [] : [{ key: entry.key, node }];
    });
  if (citation === undefined && fields.length === 0) return undefined;

  const shape: Record<string, z.ZodType> = {};
  if (citation !== undefined) shape[citation.key] = citation.schema;
  for (const field of fields) shape[field.key] = field.node.schema;
  const object = withDescription(z.strictObject(shape), stripped.description);
  return {
    kind: "object",
    ...(citation === undefined ? {} : { citation }),
    fields,
    schema: reapplyWrappers(original, object),
  };
}

function projectValue(node: ProjectionNode, value: unknown): unknown {
  if (node.kind === "leaf" || value === null || typeof value !== "object") return value;
  if (node.kind === "array") {
    return Array.isArray(value)
      ? value.map((element) => projectValue(node.element, element))
      : value;
  }

  const source = value as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  if (node.citation !== undefined && Object.hasOwn(source, node.citation.key)) {
    projected[node.citation.key] = source[node.citation.key];
  }
  for (const field of node.fields) {
    if (Object.hasOwn(source, field.key)) {
      projected[field.key] = projectValue(field.node, source[field.key]);
    }
  }
  return projected;
}

/**
 * Project every semantic piece to a one-key target. Real leaf schemas are reused, nested objects
 * are strict, arrays and nullability remain in place, and each row citation has exactly one owner.
 */
export function projectPlannedTargets<V extends Record<string, unknown>, P = NoProvenance>(
  target: ExtractionTarget<V, P>,
  plan: SchemaPlan,
): readonly PlannedProjection<V, P>[] {
  if (!(target.extractionSchema instanceof z.ZodObject)) {
    throw new Error("projectPlannedTargets: the target extractionSchema must be a ZodObject.");
  }
  const schema = target.extractionSchema;
  const knownPaths = new Set(walkFieldInventory(schema).map((entry) => entry.path));
  const absent = plan.pieces.flatMap((piece) =>
    piece.paths.filter((path) => !knownPaths.has(path)),
  );
  if (absent.length > 0) {
    throw new Error(
      `projectPlannedTargets: planned paths absent from target "${target.name}": ` +
        `${[...new Set(absent)].join(", ")}.`,
    );
  }

  const owners = citationOwners(schema, plan);
  return plan.pieces.map((piece, pieceIndex) => {
    const context: ProjectionContext = {
      piece,
      pieceIndex,
      owners,
      selected: new Set(piece.paths),
    };
    const group = buildProjectionNode(fieldAt(schema.shape, piece.key), piece.key, true, context);
    if (group === undefined) {
      throw new Error(
        `projectPlannedTargets: piece "${piece.name}" has no projectable fields under "${piece.key}".`,
      );
    }
    const extractionSchema = z.strictObject({ [piece.key]: group.schema });
    const examples: ToolAdapterExample<unknown>[] = [];
    for (const example of target.examples ?? []) {
      const fields = example.fields as Record<string, unknown>;
      if (!Object.hasOwn(fields, piece.key)) continue;
      examples.push({
        transcript: example.transcript,
        fields: { [piece.key]: projectValue(group, fields[piece.key]) },
      });
    }

    return {
      piece,
      target: {
        name: target.name,
        extractionSchema,
        instructions: target.instructions,
        examples,
      } as unknown as PlannedTarget<V, P>,
    };
  });
}
