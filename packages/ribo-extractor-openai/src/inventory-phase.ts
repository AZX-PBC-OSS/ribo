/**
 * @file The inventory phase of the scoped-instance port — one house-wide roster
 * pass over the whole document, as a `Phase` the phased engine runs first.
 *
 * This is the first half of the `scopedInstanceExtractor` port (design
 * `phased-extraction-design.md` §4.7): the caller-supplied `inventory` function
 * runs once in `run`, and — because `plan` must stay pure — **every** piece of
 * roster interpretation happens in `merge`. That is not a style choice:
 * today's job-derivation loop wrote `statedEmptyGroups`, seeded empty collection
 * groups and enforced the instance cap while it built jobs, and all of that is
 * roster interpretation, so it moves here, to the only place that owns writes.
 *
 * - **`plan` returns exactly one item, whatever the draft holds.** The pass is
 *   house-wide; there is nothing to narrow.
 * - **`run` does not wrap the roster function or change its contract.** Whatever
 *   the caller's `inventory` costs internally never reaches this extractor —
 *   today or after. It reports `{ calls: 1 }` (no token totals: `inventory` is
 *   a caller-supplied function returning a Roster, not a completion, so its
 *   token cost never reaches this extractor — the same gap documented where the
 *   inventory call is counted in `usage.calls` but not in the token totals).
 * - **The phase is one-shot.** Today's inventory is called once, no retry, and
 *   its failure fails the run; `maxRetries: 0` pins that against the engine's
 *   default of 2.
 * - **Only collection groups interpret the roster.** The singleton branch runs
 *   before any roster interpretation today, so a singleton's roster entry is
 *   ignored entirely. A merge that iterated roster keys without the
 *   `isCollection` guard would leak a singleton's stated-none into
 *   `statedEmptyGroups` — and pass every existing test.
 * - **The cap check lives here, not in the fill phase's `plan`** (deviating from
 *   design §4.7, which puts it there). Deliberate and behaviourally equivalent —
 *   both are pre-fill, both produce the same two events, and a throw discards
 *   partial state either way — but it belongs where the roster is interpreted,
 *   and a pure `plan` should not throw on a roster property.
 *
 * The roster crosses the phase boundary in `notes` under {@link rosterNoteKey},
 * which the fill phase (`fill-phase.ts`) requires.
 *
 * **Deliberately NOT `seedsDraft`**, though this merge does write `fields[key] = []`
 * for stated-none and zero-current collection groups: those empty arrays are
 * scaffolding for groups the roster said are empty, not extracted data. Marking it
 * would let `[inventory, gapfill]` validate — gap-fill re-asking over a draft of
 * nothing but scaffolding — which is exactly the mis-wiring SP4a's rule 1 exists to
 * reject (design `sp4a-composable-phases-design.md` §4.1's footnote). The next reader
 * will want to "fix" this; that fix is the bug.
 */

import { phaseBuilder, noteKey } from "@azx/ribo-core";
import type {
  DeepPartial,
  Enveloped,
  NoProvenance,
  NoteKey,
  Phase,
  PhaseDef,
  Roster,
  RosterCandidate,
} from "@azx/ribo-core";

import type { PreparedGroup } from "./instance-fill.js";

/**
 * The note key the inventory phase stores its {@link Roster} under and the fill
 * phase requires — the roster crosses the phase boundary through the draft's
 * typed notes bag, not through any strategy-private state.
 */
export const rosterNoteKey: NoteKey<Roster> = noteKey("scoped-instance-roster");

/** Options for {@link inventoryPhase} — the scoped-instance port's first half. */
export interface InventoryPhaseOptions {
  /**
   * The house-wide inventory pass, called once with the transcript text. Must
   * return a {@link Roster}. Not wrapped, not retried — its failure fails the run.
   */
  readonly inventory: (transcript: string) => Promise<Roster>;
  /** The prepared groups (from `splitExtractionSchema`), read for key and `isCollection`. */
  readonly prepared: readonly PreparedGroup[];
  /** Hard ceiling on `current` instances per group. Exceeding it throws. */
  readonly instanceCap: number;
}

/**
 * The one work item the inventory pass runs. It carries the transcript text its
 * `run` hands the caller's inventory function — sourced from the phase context,
 * which owns the one canonical text.
 */
interface InventoryItem {
  readonly transcript: string;
}

/**
 * The inventory phase: run the caller-supplied roster pass once, then interpret
 * the whole roster in `merge` — record stated-empty spans, seed empty collection
 * groups, and enforce the instance cap. See the file header for why `merge`
 * owns all of it.
 *
 * Nothing here reads the target, so `V` and `P` appear only on the returned
 * phase — a host composing a phase list by hand passes them explicitly.
 */
export function inventoryPhase<V extends Record<string, unknown>, P = NoProvenance>(
  options: InventoryPhaseOptions,
): Phase<V, P> {
  const def: PhaseDef<V, P, InventoryItem, Roster> = {
    id: "inventory",
    // The inventory is one-shot: called once today, no retry, its failure fails
    // the run. The engine's default of 2 would re-issue whatever calls the
    // caller's inventory function makes.
    maxRetries: 0,
    produces: [rosterNoteKey],
    describeItem: () => ({ key: "" }),
    plan: (_draft, ctx) => [{ transcript: ctx.transcript.text }],
    run: async (item) => {
      const roster = await options.inventory(item.transcript);
      return { value: roster, usage: { calls: 1 } };
    },
    merge: (draft, outcomes) => {
      // The phase plans exactly one item and runs under the default abort
      // policy, so under the engine a failure rejects before merge and this is
      // always a single result outcome. An error outcome driven directly has no
      // roster to interpret; returning the draft unchanged lets the engine's
      // produces check name the missing key rather than inventing a roster.
      const settled = outcomes.find((o) => o.outcome === "result");
      if (settled === undefined) return draft;
      const roster = settled.output.value;

      const statedEmptyGroups: Record<string, string> = { ...draft.statedEmptyGroups };
      // THE CAST, and why it is sound: the merge writes whole group entries by
      // dynamic key — `[]` seeds and filled arrays — which the deep partial's
      // mapped type cannot index by a runtime string. Every write is a value
      // the closing parse validates against the full extraction schema, so a
      // wrong shape cannot survive the run.
      const fields = { ...(draft.fields as Record<string, unknown>) };

      for (const group of options.prepared) {
        // Only collection groups interpret the roster — the singleton branch
        // runs before any roster interpretation today, so a singleton's roster
        // entry is ignored entirely.
        if (!group.isCollection || group.key === "") continue;

        // Today's `?? []`: a group missing from the roster entirely is an empty
        // candidate list, not an error and not a stated-none.
        const rosterGroup = roster[group.key] ?? [];

        if (!Array.isArray(rosterGroup)) {
          // A `stated: "none"` entry: record the span and seed the group empty.
          // The cast is today's — `Array.isArray` cannot narrow a `readonly T[]`
          // member out of the union, so the stated-none shape is claimed here.
          const statedNone = rosterGroup as { stated: "none"; span: string };
          statedEmptyGroups[group.key] = statedNone.span;
          fields[group.key] = [];
          continue;
        }

        // The cast is today's — `Array.isArray` cannot narrow a `readonly T[]`
        // member out of the union, so the array side is claimed here.
        const candidates = rosterGroup as readonly RosterCandidate[];
        const current = candidates.filter((c) => c.eligibility === "current");
        if (current.length === 0) {
          fields[group.key] = [];
          continue;
        }

        if (current.length > options.instanceCap) {
          throw new Error(
            `scopedInstanceExtractor: group "${group.key}" has ${current.length} current instances, exceeding the cap of ${options.instanceCap}`,
          );
        }
      }

      return {
        ...draft,
        fields: fields as DeepPartial<Enveloped<V, P>>,
        statedEmptyGroups,
        notes: draft.notes.set(rosterNoteKey, roster),
      };
    },
  };
  return phaseBuilder<V, P>()(def);
}
