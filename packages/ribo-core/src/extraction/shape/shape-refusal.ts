/**
 * @file The refusal record the partial derivation surface reports, and the
 * canonical order the records are sorted into.
 *
 * The throwing surface (`deriveExtractionShape`) refuses an operation set
 * all-or-nothing, at the first bad operation in evaluation order. The partial
 * surface (`deriveExtractionShapePartially`) instead reports every refusal it
 * can find in one pass — each carrying the caller's verbatim operation, its
 * index, its class, and the applier's own message — and applies the
 * operations that survive. Applied and refused partition the input exactly:
 * every operation is in exactly one of the two states; there is no third
 * state and no silent discard.
 *
 * The three classes say what a refusal is defeasible AGAINST:
 *
 *   - **local** — the operation is defective against the caller's schema
 *     alone, with no other operation applied. No retraction of a sibling
 *     repairs it.
 *   - **consequential** — the operation is defective only because another
 *     operation THAT IS APPLIED removed or occupied its target. The `cause`
 *     names the culprit — the drop, or the caller's own declaration — so a
 *     repair loop can tell which of the two to retract. (The live run that
 *     motivated this design refused a retype naming a dropped leaf and named
 *     the RETYPE; the repair model could not tell the drop was the culprit.)
 *   - **set** — no single operation is defective; a subset is jointly
 *     inconsistent (duplicates, a doubly-claimed nest source, drops that
 *     together empty an object). The applier does not pick which member to
 *     blame.
 */

import type { DerivedExtractionShape } from "./derived-shape.js";
import type { ShapeOperation } from "./shape-operation.js";

/**
 * What a refusal is defeasible against — see the file header.
 *
 * @category Extraction
 */
export type ShapeRefusalClass = "local" | "consequential" | "set";

/**
 * The culprit a consequential refusal names: the applied operation that
 * removed or occupied the target, or the caller's declaration the operation
 * conflicts with (the declaration is the invariant; the operation takes the
 * refusal).
 * @category Extraction
 */
export type ShapeRefusalCause =
  | {
      readonly kind: "operation";
      /** The applied operation, verbatim from the caller's array. */
      readonly operation: ShapeOperation;
      /** Its position in the caller's array. */
      readonly index: number;
    }
  | {
      readonly kind: "declaration";
      /** Which declaration the operation conflicts with. */
      readonly declaration: "requiredOnCreate" | "identifyingFields" | "provenance";
      /** The group (or top-level key) the declaration names. */
      readonly group: string;
      /** The leaf under the group, when the declaration names one. */
      readonly leaf?: string;
    };

/**
 * One refused operation: which, where, why — and for consequential, who did it.
 *
 * @category Extraction
 */
export interface ShapeRefusal {
  /** The caller's operation, verbatim. */
  readonly operation: ShapeOperation;
  /**
   * Its position in the caller's array — identity for diffing, and what makes
   * the applied + refused = input partition checkable.
   */
  readonly index: number;
  /** `local`, `consequential`, or `set` — see the file header. */
  readonly class: ShapeRefusalClass;
  /** The applier's own message — the same prose the throwing surface carries. */
  readonly reason: string;
  /** Present only on consequential refusals: what removed or occupied the target. */
  readonly cause?: ShapeRefusalCause;
}

/**
 * The partial derivation's result: the artifact from the survivors, and every refusal.
 *
 * @category Extraction
 */
export interface PartiallyDerivedShape {
  /**
   * A full {@link DerivedExtractionShape} derived from the operations that
   * survived — never a schema with holes; `assertShapeMapping` ran as the
   * post-condition. When `refusals` is empty this is exactly what
   * `deriveExtractionShape` returns — the two are the same code path, so
   * equivalence is by construction.
   */
  readonly shape: DerivedExtractionShape;
  /**
   * Every refusal the applier found, sorted canonically — by class, then
   * operation kind, then path or group, then index — never by discovery or
   * input order. Empty if and only if the artifact is exactly what
   * `deriveExtractionShape` would return.
   */
  readonly refusals: readonly ShapeRefusal[];
}

/**
 * The canonical refusal order: class, then kind, then path/group, then index.
 *
 * @category Extraction
 */
export const compareShapeRefusals = (a: ShapeRefusal, b: ShapeRefusal): number => {
  const byClass = a.class.localeCompare(b.class);
  if (byClass !== 0) return byClass;
  const byKind = a.operation.op.localeCompare(b.operation.op);
  if (byKind !== 0) return byKind;
  const aKey =
    a.operation.op === "drop" || a.operation.op === "retype" ? a.operation.path : a.operation.group;
  const bKey =
    b.operation.op === "drop" || b.operation.op === "retype" ? b.operation.path : b.operation.group;
  const byKey = aKey.localeCompare(bKey);
  if (byKey !== 0) return byKey;
  return a.index - b.index;
};
