import type { AnnotatedTranscript } from "../capture/annotated-transcript.js";
import type { NoProvenance } from "../provenance/enveloped.js";
import type { ExtractionTarget } from "../extraction/extractor.js";
import type { PhaseDraft } from "./phase-draft.js";
import type { PhaseItemOutcome, PhaseOutput } from "./phase-outcome.js";

/**
 * @file The phase type, existentially quantified: a phase is `plan`, `run` and `merge` —
 * with its item and contribution types hidden behind a single `with` member rather than
 * erased — plus the metadata a phase list is validated and planned from, and the curried
 * builder that constructs one.
 *
 * **The encoding, precisely.** `Phase<V, P>` exposes its metadata as ordinary properties
 * and hides `I` and `C` behind `with`, a function taking a GENERIC callback
 * (`<I, C>(def: PhaseDef<V, P, I, C>) => R`) and returning that callback's `R`. The
 * combinator writes `phase.with(def => …)` and, inside that callback, `I` and `C` are
 * bound and correlated — so `def.plan`'s items provably feed `def.run`, and handing
 * another phase's items to this one's `run` is a compile error.
 *
 * **Why not an erasing cast.** `Phase<V, P> = PhaseDef<V, P, unknown, unknown>` with the
 * builder doing an `as unknown as` compiles, and it makes the single most likely bug in
 * the Wave 3b scheduling loop — an off-by-one over the phase list, a retry re-dispatching
 * against a stale index — invisible to the compiler, in the exact code that is hardest to
 * test. The design's §4.4 claims this combinator deletes a bug class; funding that by
 * introducing one is not a trade worth making. The encoding costs one level of
 * indentation in the loop. This file contains no `as` cast, and none may be added.
 *
 * **Why curried.** TypeScript has no partial type-argument inference, and every
 * `V`/`P`-generic constructor in this repo is called with explicit `<V, P>`. A single
 * four-parameter `definePhase<V, P, I, C>` would fail at the call site the moment anyone
 * wrote the two they know (`TS2558: Expected 4 type arguments, but got 2`). Currying fixes
 * `V`/`P` once per strategy and infers `I` and `C` per phase from the definition.
 *
 * What this deliberately does not do: nothing here RUNS a phase — no scheduling, no
 * retry loop, no budget derivation, no unit events. That is the Wave 3b engine, and the
 * construction-time list check lives in `validate-phases.ts`.
 */

/** The metadata a phase list carries on the outside, where `with` need not be entered. */
export interface PhaseMeta {
  /**
   * Stable identifier for the phase, e.g. `"presence"`. Unique within a list.
   *
   * **Why a caller-chosen id is safe** — the one doc comment for the optional
   * `id` every phase factory's options accept (SP4a wave 2): a phase list
   * cannot use a phase KIND twice unless one instance can be renamed, because
   * `validatePhases`' duplicate check is per id, not per kind. An id reaches
   * exactly three places — `validatePhases`' duplicate detection, the engine's
   * error messages, and `PhaseUnit.phaseId` in the live observer stream — and
   * nothing persists it, so a caller-chosen id changes only what a live
   * progress consumer sees. No charset is validated at the factories:
   * constraining a model-chosen id belongs with the planner that accepts model
   * input, not with a factory a developer calls.
   */
  readonly id: string;
  /**
   * Ids of the phases this one must follow: every named phase must appear EARLIER in
   * the same list, checked by `validatePhases` at construction (ADR 0008). The ids are
   * the caller-visible ones, so a caller who renames a phase must update whoever
   * depends on it — the factory defaults name the shipped providers, and supplying the
   * option REPLACES the default (a caller adding a constraint must still name every
   * provider the phase actually reads from).
   *
   * The cross-phase data itself still travels through the draft's typed notes bag —
   * the runtime channel (`phase-notes.ts`). A phase that reads a note demands it: its
   * `plan` throws when no earlier phase wrote the key, which is the guarantee this
   * declaration orders.
   */
  readonly requires?: readonly string[];
  /**
   * How many of this phase's items may run at once. The run-level default a phase
   * inherits when it declares none is the combinator's concern (Wave 3b).
   */
  readonly concurrency?: number;
  /**
   * What happens when one of this phase's items fails: `"abort"` fails the run and stops
   * the siblings; `"skip"` hands the failed outcome to `merge`, which interprets it.
   */
  readonly onItemFailure?: "abort" | "skip";
  /** Retries per item, so the total attempts per item is `maxRetries + 1`. */
  readonly maxRetries?: number;
}

/**
 * The immutable inputs a phase reads: the transcript, the extraction target, and the
 * caller's `signal` and `deadline`.
 *
 * The transcript and target are on the CONTEXT, not the draft — a phase that could mutate
 * the transcript would defeat `isSpanGrounded`, which is only sound while the one
 * canonical text is read-only. `signal` and `deadline` are the caller's cancellation and
 * time budget, forwarded exactly as `ExtractOptions` documents.
 */
export interface PhaseContext<V extends Record<string, unknown>, P = NoProvenance> {
  /** The one canonical text an extraction reads from, plus its annotations. */
  readonly transcript: AnnotatedTranscript;
  /**
   * The field knowledge this run extracts against — see `ExtractionTarget`. Carries the
   * phase's own `P` so the target's `examples` are the `Enveloped<V, P>` shape the same
   * strategy's provenance granularity implies, not an all-`"leaf"` one.
   */
  readonly target: ExtractionTarget<V, P>;
  /** The caller's cancellation. Advisory to honour, like `ExtractOptions.signal`. */
  readonly signal?: AbortSignal;
  /** Absolute epoch ms after which the caller considers the work failed, like `ExtractOptions.deadline`. */
  readonly deadline?: number;
}

/**
 * One phase definition: the three functions, an optional `describeItem`, plus the
 * metadata. `I` and `C` are bound only inside `with` — a `PhaseDef` is never exposed
 * against a concrete item type from the outside.
 *
 * `plan` is **synchronous and pure**: it reads accumulated state and returns the work
 * items. Sync is a constraint with a purpose — a phase that needs I/O to decide its work
 * does that I/O in an earlier phase's `run`. `run` is the only async member, opaque to
 * the combinator. `merge` takes the whole batch (not one result at a time) because some
 * phases' interpretations span a group's outcomes, and it owns every write to the draft.
 */
export interface PhaseDef<
  V extends Record<string, unknown>,
  P = NoProvenance,
  I = unknown,
  C = unknown,
> extends PhaseMeta {
  /** The work items for this phase, from the state the previous merges accumulated. */
  readonly plan: (draft: PhaseDraft<V, P>, ctx: PhaseContext<V, P>) => readonly I[];
  /** One unit of work — the only async member. */
  readonly run: (
    item: I,
    draft: PhaseDraft<V, P>,
    ctx: PhaseContext<V, P>,
  ) => Promise<PhaseOutput<C>>;
  /** Fold the batch back in. Owns every write to the draft. */
  readonly merge: (
    draft: PhaseDraft<V, P>,
    results: readonly PhaseItemOutcome<I, C>[],
  ) => PhaseDraft<V, P>;
  /**
   * A human- (and combinator-) readable key for one item, for the `PhaseUnit` events.
   *
   * **Why it exists.** `PhaseUnit` carries a required `key` and an optional `leaf`, and
   * the design gives the combinator the unit stream — but a phase's `run` is opaque and
   * `I` is existentially hidden, so the scheduler has no other way to learn what group an
   * item belongs to. Every other member of the event is derivable (`phaseId` and `pass`
   * from position and metadata, `usage` from `PhaseOutput`, `attempt` from the retry
   * loop); `key` and `leaf` are not.
   *
   * **Why optional, and why the default is `key: ""`.** `groupedExtractor`'s `GroupMap`
   * already uses the `""` arm to mean "one entry covering the whole schema", and a phase
   * whose single item IS the whole document — `extractorPhase`, the inventory pass — has
   * no meaningful group key. The default and the convention agree. Supplying none is
   * valid; applying the default is the combinator's job (Wave 3b), not the builder's.
   *
   * **The piece coordinates** (`instance`/`instances`/`part`/`parts`) are the same
   * optional quartet `PhaseUnit` carries — a scoped-instance fill item reports them so a
   * consumer can render "HVAC system 2 of 3, part 1 of 2". A phase that omits them emits
   * events with the members absent, never `undefined` (the combinator spreads a member
   * in only when it is defined).
   */
  readonly describeItem?: (item: I) => {
    key: string;
    leaf?: string;
    instance?: number;
    instances?: number;
    part?: number;
    parts?: number;
  };
}

/**
 * A phase in a `phases` list: the metadata on the outside, the item and contribution
 * types existentially hidden behind one `with` member.
 *
 * Read `PhaseMeta` off it directly for validation and planning; enter `with` to run it.
 */
export type Phase<V extends Record<string, unknown>, P = NoProvenance> = PhaseMeta & {
  /**
   * Bind this phase's item and contribution types. Inside the callback, `def.plan`'s
   * items are typed to feed `def.run` and `def.merge` — and no other phase's do. The
   * callback's return value is `with`'s return value, so a run loop can thread the draft
   * through without a cast.
   */
  readonly with: <R>(use: <I, C>(def: PhaseDef<V, P, I, C>) => R) => R;
};

/**
 * Build the phase constructor for one strategy: fix `V` and `P` once, infer `I` and `C`
 * per phase from each definition.
 *
 * The returned closure wraps a `PhaseDef` into a `Phase` by spreading the metadata and
 * supplying `with` as `use => use(def)` — the callback gets the ORIGINAL definition, with
 * `I` and `C` bound at the point `use` instantiates them. That is the whole mechanism: no
 * cast, no erasure, no type-argument juggling at the call site.
 */
export function phaseBuilder<V extends Record<string, unknown>, P = NoProvenance>(): <I, C>(
  def: PhaseDef<V, P, I, C>,
) => Phase<V, P> {
  // Copied member-by-member, not by spread: a spread would carry `plan`/`run`/`merge`
  // onto the outside of the `Phase`, defeating the existential hiding. The cost is that
  // a new `PhaseMeta` member MUST be added to this list — missed, it reads `undefined`
  // off every builder-constructed phase and validation silently never sees it.
  return (def) => ({
    id: def.id,
    requires: def.requires,
    concurrency: def.concurrency,
    onItemFailure: def.onItemFailure,
    maxRetries: def.maxRetries,
    with: (use) => use(def),
  });
}
