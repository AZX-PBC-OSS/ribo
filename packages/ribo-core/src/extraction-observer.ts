/**
 * @file Extraction observability — the shared vocabulary every strategy reports through.
 *
 * One optional progress hook, declared once here and inherited by every extractor's
 * options. A full Manual J extraction is 16 model calls and six to ten minutes; without
 * this hook the reviewer sees nothing for that entire time, and "nothing" is
 * indistinguishable from "hung".
 */

/** Fields every unit carries, whatever divided the work. */
interface UnitBase {
  /**
   * Stable across this unit's `start` and its `done`/`error`, so a consumer
   * correlates the two without bookkeeping.
   */
  readonly id: string;
  readonly phase: "start" | "done" | "error";
  /** 1 on the first try. The only way a retry is observable at all. */
  readonly attempt: number;
  /** The composing strategy, when one is running, so a unit is attributable to its tier. */
  readonly strategy?: string;
  /** On `"done"`. */
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
  /** On `"error"`. */
  readonly error?: unknown;
}

/** `singleShotExtractor`: the document in one call. */
export type WholeUnit = UnitBase & { readonly unit: "whole" };

/** `perGroupExtractor`: one group, or one part of a partitioned group. */
export type GroupUnit = UnitBase & {
  readonly unit: "group";
  readonly key: string;
  readonly part: number;
  readonly parts: number;
};

/** `scopedInstanceExtractor`: the house-wide roster pass. */
export type InventoryUnit = UnitBase & { readonly unit: "inventory" };

/** `scopedInstanceExtractor`: one instance's fill. */
export type InstanceUnit = UnitBase & {
  readonly unit: "instance";
  readonly key: string;
  readonly instance: number;
  readonly instances: number;
  readonly part: number;
  readonly parts: number;
};

/** `threePhaseExtractor`: one call in the presence -> quote -> classify sequence. */
export type PhaseUnit = UnitBase & {
  readonly unit: "phase";
  /**
   * Position in the phase list, 0-based. Previously the strategy's own pass
   * index — for the ported three-phase the two coincide, but position is the
   * only meaning a general combinator can offer (a four-phase list would not).
   */
  readonly pass: number;
  /**
   * The phase's identity — `"presence"`, `"span"`, `"classify"` — what a
   * consumer rendering progress actually wants, as opposed to the numeric
   * `pass`.
   *
   * Deliberately **not** named `phase`: `UnitBase.phase` is the lifecycle
   * discriminator (`"start" | "done" | "error"`) and `PhaseUnit` is an
   * intersection with it, so a `phase: string` member here would not widen
   * anything — it would narrow to that lifecycle union, and emitting a
   * phase identity through it would fail with an error naming neither the
   * cause nor the collision. The name keeps the two axes apart.
   */
  readonly phaseId: string;
  readonly key: string;
  /** Phase 2 only — one leaf per call. */
  readonly leaf?: string;
};

/** `gapFillExtractor`: one focused follow-up over abstained-with-evidence leaves. */
export type GapFillUnit = UnitBase & {
  readonly unit: "gapfill";
  readonly candidates: number;
};

export type ExtractionUnit =
  WholeUnit | GroupUnit | InventoryUnit | InstanceUnit | PhaseUnit | GapFillUnit;

/**
 * Observation points shared by every extraction strategy.
 *
 * `U` is the set of units the extractor being configured can actually emit, so an
 * options type states its own vocabulary rather than every consumer handling events
 * that will never arrive. The default keeps the general case general.
 */
export interface ExtractionObserver<U extends ExtractionUnit = ExtractionUnit> {
  /** Called as each unit of extraction work starts and settles. Must not throw. */
  onUnit?: (event: U) => void;
}

let unitCounter = 0;

/**
 * Returns a fresh opaque id, unique for the lifetime of the module.
 *
 * Deliberately opaque and not derived from a group key or response-schema name: the
 * structured fields are how a consumer identifies a unit, and an id that looked
 * parseable would invite the coupling this hook exists to remove. Process-global so
 * ids from two tiers of one ladder cannot collide.
 */
export function nextUnitId(): string {
  unitCounter += 1;
  return `unit-${unitCounter}`;
}

/**
 * Wrap an `onUnit` so every forwarded event carries `strategy`. Returns `undefined`
 * when handed `undefined`, so an extractor threading an absent observer stays absent
 * rather than getting a no-op function. Generic in `U` to preserve a narrow set.
 */
export function stampStrategy<U extends ExtractionUnit>(
  strategy: string,
  onUnit: ((event: U) => void) | undefined,
): ((event: U) => void) | undefined {
  if (onUnit === undefined) return undefined;
  return (event: U) => onUnit({ ...event, strategy });
}
