import type { Enveloped, NoProvenance } from "../provenance/enveloped.js";
import type { SkippedItem } from "../extraction/extractor.js";
import { emptyNotes } from "./phase-notes.js";
import type { Notes } from "./phase-notes.js";

/**
 * @file The draft a phased run's phases progressively fill: a deep partial of the enveloped
 * fields, the roster's stated-empty record, the raw output, and the typed cross-phase bag.
 *
 * This is `phasedExtractor`'s accumulated state — the value every phase's `plan` reads,
 * every `run` is handed to read, and every `merge` returns. Nothing here runs a phase; the
 * engine is a later wave.
 *
 * What this deliberately does not do: it carries no transcript and no extraction target.
 * Those live on the phase context (`PhaseContext`), not the draft — a phase that could
 * reach (let alone mutate) the transcript would defeat `isSpanGrounded`, which is only
 * sound while the one canonical text is read-only. And it defines no merge helper: a
 * `merge` is each phase's own policy, and the one merge this wave ships (`extractorPhase`)
 * is a shallow top-level assign by that phase's own decision.
 */

/**
 * The homomorphic deep partial: every key optional, every value recursed.
 *
 * **Why homomorphic, and why not `Partial`.** A top-level `Partial<Enveloped<V, P>>` cannot
 * express what the strategies need: a span phase that learned one leaf's `sourceSpan` would
 * still have to supply `value` and `confidence` for that leaf and every sibling leaf of the
 * group. The homomorphic form (`[K in keyof T]` over a bare type parameter) preserves
 * `readonly`, adds optionality at every level, keeps a collection group's array shape (its
 * element becomes possibly-undefined), and leaves leaf enum unions intact — measured against
 * the real enveloped schema during design at roughly +3% type instantiations, which is
 * negligible. A non-homomorphic or conditional "simplification" mangles enum leaves into
 * something write-compatible, so valid members still assign and nothing fails; the only
 * symptom is leaf validation quietly disappearing. `phase-draft.test.ts` pins the enum
 * union exactly, with a type-equality assertion, for exactly that reason.
 *
 * **The three-state leaf is a feature, not an accident.** Under the deep partial a leaf's
 * `value` reads as `T | null | undefined`. "Not yet asked" (`undefined`) and "asked,
 * answered null" (`null`) are different claims, and keeping them apart is exactly what
 * `provenance.ts`'s anti-hallucination rule is for — the first merge helper anyone writes
 * must not collapse them with `?? null`.
 */
export type DeepPartial<T> = { [K in keyof T]?: DeepPartial<T[K]> };

/**
 * A phased run's accumulated state, carried from phase to phase.
 *
 * **Every member is `readonly`, and that is a design commitment rather than tidiness.** A
 * phase's `run` receives the draft to read and must not write through it: items within a
 * phase run concurrently, so a mutating `run` races its siblings, and `merge` owning every
 * write is what makes the phase contract coherent. Every writer rebuilds — `emptyDraft`
 * constructs, a `merge` spreads. The group keys inside `DeepPartial` are already `readonly`
 * (the mapped type preserves the enveloped shape's modifiers), so this only extends the
 * same discipline one level out.
 *
 * @typeParam V - the writable patch's value type, as for `Enveloped<V, P>`.
 * @typeParam P - the per-group provenance granularity the enveloped shape was derived
 * with, defaulting to none.
 */
export interface PhaseDraft<V, P = NoProvenance> {
  /**
   * The progressively-filled fields: a deep partial of the enveloped shape, so a phase can
   * write one leaf's `sourceSpan` without claiming its siblings. A leaf's `value` is
   * three-state — see {@link DeepPartial}'s note before writing a merge helper.
   */
  readonly fields: DeepPartial<Enveloped<V, P>>;
  /**
   * Per-group verbatim spans where the roster recorded an explicit "none of these", keyed
   * by the group's own top-level key. **Required on the draft** — always present, empty
   * when nothing has been recorded, so a phase's `merge` never has to guard it.
   *
   * Its counterpart on `ExtractionResult` is optional and its absence there is meaningful:
   * `extractor.ts` documents absence as "this extractor ran no roster pass". The engine
   * (a later wave) omits it from the result when empty; this type only guarantees the
   * draft's side is unconditional.
   */
  readonly statedEmptyGroups: Readonly<Record<string, string>>;
  /**
   * The raw model/endpoint output, carried for provenance the same way `ExtractionResult`
   * carries it. Absent until a phase's result had one.
   */
  readonly raw?: unknown;
  /**
   * Skipped items reported by extractors lifted into this run (`extractorPhase`). The
   * engine's own skips are not written here — it records those itself, so no `merge`
   * can drop them — and appends these to its own on the result.
   */
  readonly skippedItems?: readonly SkippedItem[];
  /** The typed cross-phase channel — see `phase-notes.ts`. Written by `merge` only. */
  readonly notes: Notes;
}

/**
 * A fold: how a phase's `merge` writes a typed value into the draft — the caller's own
 * whole-draft transform, at the caller's own value type.
 *
 * The caller writes the fold and the value type `T` flows into it; the same shape reads
 * for every kind that folds a value. A phase with no contribution folds with `T` at its
 * default `void`, where the value position is unwritable without a cast — there is
 * nothing to hand it. A fold must leave the draft completable by the phases after it;
 * the closing parse is where that is checked.
 */
export type PhaseFold<V, P = NoProvenance, T = void> = (
  draft: PhaseDraft<V, P>,
  value: T,
) => PhaseDraft<V, P>;

/**
 * The draft a phased run starts from: empty fields, an empty stated-empty record, no raw
 * output, and an empty bag of notes.
 */
export function emptyDraft<V, P = NoProvenance>(): PhaseDraft<V, P> {
  return { fields: {}, statedEmptyGroups: {}, notes: emptyNotes() };
}
