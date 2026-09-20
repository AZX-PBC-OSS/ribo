import type { Enveloped, NoProvenance } from "./enveloped.js";
import type { Extractor } from "./extractor.js";
import type { Phase, PhaseDef } from "./phase.js";
import { phaseBuilder } from "./phase.js";

/**
 * @file `extractorPhase` — lift any `Extractor` into a one-item phase, so an existing
 * strategy becomes a phase in a list.
 *
 * It is the primitive that makes the later `phasedExtractor` the outer shell for the
 * whole family rather than a fourth sibling beside the existing combinators: a
 * `singleShotExtractor`, a `perGroupExtractor`, a `gapFillExtractor` — any of them —
 * becomes the base phase of a list, and the follow-up phases that narrow after it are
 * just more entries. Wave 4's gap-fill port is a base extractor phase followed by a
 * follow-up phase; this is the base.
 *
 * **The contribution carries the result's field-bearing members, not just the fields.**
 * `run` returns the result's `fields` as the contribution — with `raw` and
 * `statedEmptyGroups` riding along, because `merge` must carry them into the draft (they
 * are members of `ExtractionResult` and so of the draft) and a `PhaseOutput` has no room
 * for them; `usage` travels on the `PhaseOutput` instead, where the combinator
 * accumulates it.
 *
 * **The merge is a shallow top-level assign, and that is deliberate.** A lifted extractor
 * returns a complete `Enveloped<V, P>` for the keys it covers, so a deep merge would be
 * solving a problem that does not exist here while quietly deciding precedence questions
 * this task has no basis to decide. The engine's own phases (Wave 3b) do finer-grained
 * merging; this one does not need to.
 *
 * What this deliberately does not do: it does not run anything on its own — the phase is
 * inert until an engine calls `plan`/`run`/`merge`. And it declares no `requires` of its
 * own: an `Extractor` speaks in fields and results, not in notes. Its merge populates
 * `draft.fields` unconditionally — the merge always runs (the plan is never empty) — which
 * is the guarantee a follow-up phase that reads the fields stands on; there is no marker
 * key declaring it (ADR 0008), so a follow-up that needs a populated draft takes
 * responsibility for ordering after this phase through `requires`.
 */

/**
 * The one item a lifted extractor's `plan` emits: the whole document as a single unit of
 * work. It carries no data — the document rides on the context's transcript — and its
 * type is existentially hidden by the `Phase` encoding, so no caller can depend on the
 * marker's identity.
 */
const WHOLE_DOCUMENT = null;

/** Options for {@link extractorPhase}. */
export interface ExtractorPhaseOptions {
  /**
   * Ids of the phases this one must follow. The lift declares none of its
   * own — an `Extractor` speaks in fields and results, not notes — so the
   * list is exactly what you pass (ADR 0008).
   */
  readonly requires?: readonly string[];
}

export function extractorPhase<V extends Record<string, unknown>, P = NoProvenance>(
  id: string,
  extractor: Extractor<Enveloped<V, P>>,
  options: ExtractorPhaseOptions = {},
): Phase<V, P> {
  const def: PhaseDef<
    V,
    P,
    null,
    {
      fields: Enveloped<V, P>;
      raw?: unknown;
      statedEmptyGroups?: Readonly<Record<string, string>>;
    }
  > = {
    id,
    // The caller's ids are the whole `requires` (see the option); an absent
    // option leaves the def's `requires` unset.
    ...(options.requires === undefined ? {} : { requires: options.requires }),
    plan: () => [WHOLE_DOCUMENT],
    run: async (_item, _draft, ctx) => {
      // Forwarded, not rebuilt: `signal` and `deadline` are the caller's cancellation and
      // time budget, and a dropped forward strands them silently — the same discipline
      // `toSessionExtractStep` documents for its own hand-through.
      const result = await extractor.extract(ctx.transcript, {
        signal: ctx.signal,
        deadline: ctx.deadline,
      });
      return {
        value: {
          fields: result.fields,
          raw: result.raw,
          statedEmptyGroups: result.statedEmptyGroups,
        },
        usage: result.usage,
      };
    },
    merge: (draft, results) => {
      let fields = { ...draft.fields };
      let statedEmptyGroups: Readonly<Record<string, string>> = {};
      let raw: unknown;
      let hasRaw = false;
      for (const outcome of results) {
        // An error outcome carries no contribution. A lifted extractor runs under abort
        // semantics — its failures reject out of `run` before `merge` — so this arm is
        // unreachable through the engine, and skipped rather than invented around here.
        if (outcome.outcome !== "result") continue;
        const contribution = outcome.output.value;
        // Shallow top-level assign — see the file header for why not deeper.
        fields = { ...fields, ...contribution.fields };
        // Carried when the result had them; empty when it did not. `statedEmptyGroups`
        // is unconditional on the draft, so the "not had" case is `{}`, never absent.
        statedEmptyGroups = contribution.statedEmptyGroups ?? statedEmptyGroups;
        if (contribution.raw !== undefined) {
          raw = contribution.raw;
          hasRaw = true;
        }
      }
      // `raw` is optional on the draft and its ABSENCE is what "no result carried one"
      // reads as — so it is spread in only when carried, never as an explicit undefined.
      return {
        ...draft,
        fields,
        statedEmptyGroups,
        ...(hasRaw ? { raw } : {}),
      };
    },
  };
  return phaseBuilder<V, P>()(def);
}
