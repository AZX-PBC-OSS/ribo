import type { NoProvenance } from "../provenance/enveloped.js";
import type { Phase } from "./phase.js";

/**
 * @file The construction-time phase-list validator: reject a mis-wired list before the
 * first call is paid for, with a message that names the offending phase and id or value.
 *
 * This is the same move `groupedExtractor`'s coverage check and `enveloped()`'s
 * `validateProvenance` make — a composition error surfaces at construction rather than
 * after every other phase's calls have been spent. In the eventual agentic layer it is
 * also the admission control: a planner cannot emit a list that wires phases in the
 * wrong order, because construction rejects it and the rejection names the id, which is
 * the repair prompt for the next attempt.
 *
 * `requires` names PHASE IDS, not note keys — the ordering check is over ids, and a
 * dependency is satisfied only by the specific named phase appearing earlier in the same
 * list (ADR 0008). What it deliberately does not do: it does not verify what a phase
 * READS. A phase that reads a note from the draft's bag demands it — its `plan` throws
 * when no earlier phase wrote the key — so the runtime guarantee lives at the read site,
 * not in a declaration that can be forgotten. And there is deliberately no list-level
 * rule that some phase must run first or produce anything: `[inventory]` alone is not
 * clearly wrong (its merge writes `fields[key] = []` for stated-none collection groups),
 * and such a rule would reject every `phasedExtractor` fixture whose phases declare no
 * requirements — ADR 0008, and the test that pins it.
 * @category Extraction
 */
export function validatePhases<V extends Record<string, unknown>, P = NoProvenance>(
  phases: readonly Phase<V, P>[],
): void {
  if (phases.length === 0) {
    throw new TypeError("validatePhases: a phase list must not be empty");
  }

  const seenIds = new Set<string>();

  for (const phase of phases) {
    if (seenIds.has(phase.id)) {
      throw new TypeError(`validatePhases: duplicate phase id "${phase.id}"`);
    }

    // Order matters, and the direction is load-bearing: the check runs BEFORE this
    // phase's own id is added, so a phase cannot satisfy itself, and a dependency
    // named against a later phase is an error. The duplicate check above keeps the
    // id set unambiguous — a requires entry names exactly one phase.
    for (const id of phase.requires ?? []) {
      if (!seenIds.has(id)) {
        throw new TypeError(
          `validatePhases: phase "${phase.id}" requires phase "${id}", which does not ` +
            "appear earlier in the list — order matters, so a phase later in the list " +
            "does not satisfy it",
        );
      }
    }
    seenIds.add(phase.id);

    if (
      phase.concurrency !== undefined &&
      !(Number.isInteger(phase.concurrency) && phase.concurrency > 0)
    ) {
      throw new TypeError(
        `validatePhases: phase "${phase.id}" declares concurrency ${phase.concurrency} — ` +
          "it must be a positive integer",
      );
    }

    if (phase.maxRetries !== undefined && phase.maxRetries < 0) {
      throw new TypeError(
        `validatePhases: phase "${phase.id}" declares maxRetries ${phase.maxRetries} — ` +
          "it must not be negative",
      );
    }
  }
}
