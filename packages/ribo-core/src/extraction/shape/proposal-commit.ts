/**
 * @file The commit rule the resuming proposer folds each attempt through.
 *
 * A repair reply that contains only the fixes must not discard the operations
 * that already applied — the measured collapse the proposer-resume design
 * (§2) answers: 448 operations proposed, 2 refused, and the repair turn's
 * one-operation answer zeroed the other 446. This module owns the fold: it
 * takes the committed set and one attempt's operations, runs the partial
 * applier over both, and returns the new committed set plus one refusal per
 * incoming operation it could not commit — culprits included, so the loop can
 * tell the model why. Committed operations are never removed: every addition
 * is validated against the whole list, so a committed operation can never
 * become refused.
 */

import { deriveExtractionShapePartially } from "./shape-operations.js";
import type { ZodObject } from "zod";
import type { ShapeOperation } from "./shape-operation.js";
import type { ShapeRefusal, ShapeRefusalCause } from "./shape-refusal.js";
import type { InventoryDeclarations } from "./leaf-inventory.js";

/** One incoming operation the rule could not commit, with the reason why. */
export interface CommitRefusal {
  /** The INCOMING operation that was not committed. */
  readonly operation: ShapeOperation;
  /** The applier's message, or a commit-rule message naming the conflict. */
  readonly reason: string;
  /**
   * Present only when the culprit is another incoming operation or a
   * declaration; an operation index is translated to its position in
   * `incoming`. A conflict with a committed operation is reported through
   * `conflictsWithCommitted` instead — the model must never be told to
   * retract a locked operation.
   */
  readonly cause?: ShapeRefusalCause;
  /** The committed operation this one conflicts with, when it is one. */
  readonly conflictsWithCommitted?: ShapeOperation;
}

/** Serialize with object keys sorted, so a `moves` record compares equal regardless of key order. */
const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

const sameOperation = (a: ShapeOperation, b: ShapeOperation): boolean =>
  stableJson(a) === stableJson(b);

const operationKey = (op: ShapeOperation): string =>
  op.op === "drop" || op.op === "retype" ? op.path : op.group;

const sameKeyKind = (a: ShapeOperation, b: ShapeOperation): boolean =>
  a.op === b.op && operationKey(a) === operationKey(b);

const message = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** The index a refusal's operation-cause names, when it names one. */
const causedIndex = (refusal: ShapeRefusal): number | undefined =>
  refusal.cause?.kind === "operation" ? refusal.cause.index : undefined;

type ApplierOutcome =
  | { readonly ok: true; readonly refusals: readonly ShapeRefusal[] }
  | { readonly ok: false; readonly error: unknown };

/**
 * Fold one attempt's operations into the committed set. See the file header
 * for why the rule exists; the shape of the result — every not-committed
 * incoming operation reported once, in incoming order, with its cause
 * translated to `incoming` positions — is what the resuming loop's feedback
 * is built from.
 */
export const commitAttempt = (
  schema: ZodObject,
  declarations: InventoryDeclarations,
  committed: readonly ShapeOperation[],
  incoming: readonly ShapeOperation[],
): { committed: readonly ShapeOperation[]; refused: readonly CommitRefusal[] } => {
  const runApplier = (operations: readonly ShapeOperation[]): ApplierOutcome => {
    try {
      return {
        ok: true,
        refusals: deriveExtractionShapePartially(schema, {
          ...declarations,
          operations,
        }).refusals,
      };
    } catch (error) {
      return { ok: false, error };
    }
  };

  // Dropped before validation: a model that re-sends committed work must not
  // hit a duplicate conflict and lose the operation for good. The kept
  // operations' positions in `incoming` ride along — the model sees the delta
  // it sent, so every index a refusal reports is one of those, never a
  // position in this filtered list.
  const fresh: ShapeOperation[] = [];
  const freshAt: number[] = [];
  for (const [position, op] of incoming.entries()) {
    if (!committed.some((c) => sameOperation(c, op))) {
      fresh.push(op);
      freshAt.push(position);
    }
  }

  const combinedRun = runApplier([...committed, ...fresh]);

  // Candidates: incoming operations no refusal is about and no refusal names
  // as its cause — tracked as positions in `incoming`. A refusal about a
  // committed operation never excludes one; its cause can.
  let combinedRefusals: readonly ShapeRefusal[] = [];
  let candidatePositions: readonly number[];
  if (combinedRun.ok) {
    combinedRefusals = combinedRun.refusals;
    const bad = new Set<number>();
    for (const refusal of combinedRefusals) {
      if (refusal.index >= committed.length) bad.add(refusal.index - committed.length);
      const culprit = causedIndex(refusal);
      if (culprit !== undefined && culprit >= committed.length) {
        bad.add(culprit - committed.length);
      }
    }
    candidatePositions = fresh.map((_, i) => i).filter((i) => !bad.has(i));
  } else {
    // The combined run threw. The committed list alone throwing is a schema
    // defect — the hard boundary — rethrown; otherwise every incoming
    // operation is a candidate for the slow path.
    const baseRun = runApplier(committed);
    if (!baseRun.ok) throw baseRun.error;
    candidatePositions = fresh.map((_, i) => i);
  }

  const candidates = candidatePositions.map((i) => fresh[i]!);

  // The fast path: every refusal of the combined run is about an incoming
  // operation, so removing the refused and the cause-named leaves a set the
  // applier accepts — one validation confirms it.
  const fastValidation =
    combinedRun.ok && combinedRun.refusals.every((r) => r.index >= committed.length)
      ? runApplier([...committed, ...candidates])
      : undefined;
  if (fastValidation !== undefined && fastValidation.ok && fastValidation.refusals.length === 0) {
    return {
      committed: [...committed, ...candidates],
      refused: reportRefused(candidatePositions, new Map()),
    };
  }

  // The slow path: the committed list is known clean, so each candidate is
  // tried against the growing list and re-validated over the whole of it.
  // This is what attributes refusals the applier records without a cause.
  const list: ShapeOperation[] = [...committed];
  const survivors: number[] = [];
  const movedOut = new Map<number, { reason: string; conflictsWithCommitted?: ShapeOperation }>();
  for (const position of candidatePositions) {
    const candidate = fresh[position]!;
    const trial = runApplier([...list, candidate]);
    if (trial.ok && trial.refusals.length === 0) {
      list.push(candidate);
      survivors.push(position);
      continue;
    }
    if (trial.ok) {
      const aboutEarlier = trial.refusals.find((refusal) => refusal.index < list.length);
      const first = aboutEarlier ?? trial.refusals[0]!;
      movedOut.set(
        position,
        aboutEarlier === undefined
          ? { reason: first.reason }
          : { reason: first.reason, conflictsWithCommitted: aboutEarlier.operation },
      );
    } else {
      movedOut.set(position, { reason: message(trial.error) });
    }
  }
  return { committed: list, refused: reportRefused(survivors, movedOut) };

  /** One refusal per not-committed incoming operation, in incoming order. */
  function reportRefused(
    survivorPositions: readonly number[],
    movedOutReports: ReadonlyMap<
      number,
      { reason: string; conflictsWithCommitted?: ShapeOperation }
    >,
  ): readonly CommitRefusal[] {
    const survivors = new Set(survivorPositions);
    const out: CommitRefusal[] = [];
    for (const [position, operation] of fresh.entries()) {
      if (survivors.has(position)) continue;
      out.push(reportOne(position, operation, movedOutReports.get(position)));
    }
    return out;
  }

  function reportOne(
    position: number,
    operation: ShapeOperation,
    movedOutReport:
      { readonly reason: string; readonly conflictsWithCommitted?: ShapeOperation } | undefined,
  ): CommitRefusal {
    if (movedOutReport !== undefined) {
      return movedOutReport.conflictsWithCommitted === undefined
        ? { operation, reason: movedOutReport.reason }
        : {
            operation,
            reason: movedOutReport.reason,
            conflictsWithCommitted: movedOutReport.conflictsWithCommitted,
          };
    }
    const combinedIndex = committed.length + position;
    const own = combinedRefusals.find((refusal) => refusal.index === combinedIndex);
    if (own !== undefined) {
      const cause = own.cause;
      if (cause === undefined) {
        // A set-class refusal the applier records without a cause: when a
        // sibling refusal blames a committed operation of the same kind and
        // key, this one is in a set conflict with it — a second regroup on a
        // committed regroup's group.
        const counterpart = combinedRefusals.find(
          (refusal) =>
            refusal.index < committed.length && sameKeyKind(refusal.operation, operation),
        );
        return counterpart === undefined
          ? { operation, reason: own.reason }
          : { operation, reason: own.reason, conflictsWithCommitted: counterpart.operation };
      }
      if (cause.kind === "declaration") return { operation, reason: own.reason, cause };
      if (cause.index < committed.length) {
        // The culprit is committed — report the conflict against it, never a
        // retraction of a locked operation.
        return { operation, reason: own.reason, conflictsWithCommitted: cause.operation };
      }
      return {
        operation,
        reason: own.reason,
        cause: {
          kind: "operation",
          operation: cause.operation,
          index: freshAt[cause.index - committed.length]!,
        },
      };
    }
    // Not refused itself — a culprit. A refusal about a committed operation
    // makes this one the named culprit of a locked operation's refusal.
    const committedRefusal = combinedRefusals.find(
      (refusal) => refusal.index < committed.length && causedIndex(refusal) === combinedIndex,
    );
    if (committedRefusal !== undefined) {
      return {
        operation,
        reason: `would invalidate an already-applied operation: ${committedRefusal.reason}`,
        conflictsWithCommitted: committedRefusal.operation,
      };
    }
    const incomingRefusal = combinedRefusals.find(
      (refusal) => refusal.index >= committed.length && causedIndex(refusal) === combinedIndex,
    );
    if (incomingRefusal !== undefined) {
      // The reason already names the refusal this one caused; a cause field
      // here would name the culprit itself.
      return {
        operation,
        reason: `named as the cause of another refusal: ${incomingRefusal.reason}`,
      };
    }
    // Unreachable: the applier partitions applied and refused exactly, and
    // the candidates exclude precisely the refused and the cause-named.
    throw new Error(
      `commitAttempt(): internal — the operation at incoming position ${String(
        freshAt[position],
      )} was neither committed nor refused.`,
    );
  }
};
