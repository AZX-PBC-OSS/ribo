import type { NoProvenance } from "../provenance/enveloped.js";
import type { PhaseFold } from "./phase-draft.js";
import type { Phase, PhaseDef } from "./phase.js";
import { phaseBuilder } from "./phase.js";

/**
 * @file `computePhase` — a deterministic, model-free fold between phases: a mid-list
 * slot where a caller's own whole-draft transform runs, at the draft's own type.
 *
 * Nothing offers that slot today. A phase's own `merge` is bound to that phase's
 * interpretation of its outcomes, and the engine's `normalize` is a single global pass
 * after the last merge — so a deterministic step between two model phases had to be
 * smuggled into a model phase's merge. This is the honest version: no call, no I/O, no
 * usage, one fold.
 *
 * **Why `plan` emits exactly one marker item.** The engine skips `merge` entirely when
 * `plan` returns nothing — an empty-plan compute phase would silently do nothing, and a
 * reader seeing the marker would delete it as obviously pointless. It is the only thing
 * that makes the fold load-bearing.
 *
 * **What this is not.**
 *
 * - It does not subsume the shipped phases' normalizes. A compute fold sees the draft's
 *   deep partial, pre-parse, where `gapFillPhase`'s normalize runs at the full enveloped
 *   shape behind the cast that file documents, and `scopedInstanceExtractor`'s runs
 *   post-parse, wrapping the engine — a position its own header documents. And
 *   `gapFillPhase`'s normalize lives in its merge so it runs on the follow-up path and
 *   never on the passthrough; a standalone phase runs unconditionally and cannot see
 *   which path ran.
 * - It has no evaluator and does no I/O — a caller-supplied callable that calls out
 *   belongs in `askPhase`. `inventoryPhase` is the shipped cousin whose `run` invokes a
 *   caller's function, and it is the boundary case that defines the line: it does work
 *   (and reports a call for it); this does none (and reports none — do not copy its
 *   `{ calls: 1 }` convention here).
 *
 * **The fold's one obligation, documented rather than enforced mid-list.** A fold must
 * leave the draft completable by the phases after it; the closing parse is where that is
 * checked, transiently. There is deliberately no per-fold key-set guard: whether a fold
 * drops a top-level `fields` key depends on what earlier phases wrote, so the same fold
 * would be a hard failure on one run and fine on the next, and a mid-list dead end is
 * the loss the retry budget exists to prevent. See ADR 0012 for the reasoning in full.
 */

/**
 * The one marker item a compute phase's `plan` emits. It carries no data — the fold
 * reads and rebuilds the whole draft — and its type is existentially hidden by the
 * `Phase` encoding, so no caller can depend on the marker's identity.
 */
const ONE_STEP = null;

/** Options for {@link computePhase}. */
export interface ComputePhaseOptions<V extends Record<string, unknown>, P = NoProvenance> {
  /**
   * The deterministic fold. It owns every write, the way a merge does, and must leave
   * the draft completable by the phases after it — the closing parse is where that is
   * checked. The value position of the fold is `void` on purpose: there is no
   * contribution, the draft is both the input and the output.
   */
  readonly fold: PhaseFold<V, P>;
  /**
   * Overrides the phase's id — `"compute"` by default. See `PhaseMeta.id` in
   * `@azx/ribo-core` for what an id reaches and why a caller-chosen one is safe.
   */
  readonly id?: string;
  /**
   * Ids of the phases this one must follow. The phase declares none of its own — it
   * reads whatever the draft holds and nothing else — so the list is exactly what you
   * pass (ADR 0008).
   */
  readonly requires?: readonly string[];
}

/**
 * The compute phase: run the caller's deterministic fold once, between the phases
 * around it. See the file header for the marker, and for what this deliberately is not.
 */
export function computePhase<V extends Record<string, unknown>, P = NoProvenance>(
  options: ComputePhaseOptions<V, P>,
): Phase<V, P> {
  const def: PhaseDef<V, P, null, void> = {
    id: options.id ?? "compute",
    // `maxRetries` budgets `run` attempts, and this `run` is a no-op that cannot
    // fail — the fold is arbitrary caller code and CAN throw, but it runs in
    // `merge`, which the retry loop never touches.
    maxRetries: 0,
    // The caller's ids are the whole `requires` — the phase declares none of
    // its own (see the option); an absent option leaves the def's `requires`
    // unset.
    ...(options.requires === undefined ? {} : { requires: options.requires }),
    plan: () => [ONE_STEP],
    // No model call, no I/O at all — the work is the fold, and `merge` owns every
    // write. Returning no usage is honest, and the engine already skips an absent
    // usage member.
    run: async () => ({ value: undefined }),
    merge: (draft) => options.fold(draft),
  };
  return phaseBuilder<V, P>()(def);
}
