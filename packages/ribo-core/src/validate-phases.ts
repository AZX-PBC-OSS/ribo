import type { NoProvenance } from "./enveloped.js";
import type { Phase } from "./phase.js";

/**
 * @file The construction-time phase-list validator: reject a mis-wired list before the
 * first call is paid for, with a message that names the offending phase and key or value.
 *
 * This is the same move `groupedExtractor`'s coverage check and `enveloped()`'s
 * `validateProvenance` make — a composition error surfaces at construction rather than
 * after every other phase's calls have been spent. In the eventual agentic layer it is
 * also the admission control: a planner cannot emit a list that wires phases in the
 * wrong order, because construction rejects it and the rejection names the key, which is
 * the repair prompt for the next attempt.
 *
 * What this deliberately does not do: it is a key-presence check and not a type system —
 * Task 1's branded note keys (`NoteKey<T>`) are what make it more than string matching.
 * And it does NOT verify that a phase which declares `produces` actually writes the key:
 * that check runs at each phase boundary DURING a run, against what the phase really
 * did, and belongs with the engine in Wave 3b. There is also deliberately no list-level
 * rule that some phase must declare `seedsDraft`: `[inventory]` alone is not clearly
 * wrong (its merge writes `fields[key] = []` for stated-none collection groups), and
 * such a rule would reject every `phasedExtractor` fixture that predates the axis —
 * design `sp4a-composable-phases-design.md` §4.1, and the test that pins it.
 */
export function validatePhases<V extends Record<string, unknown>, P = NoProvenance>(
  phases: readonly Phase<V, P>[],
): void {
  if (phases.length === 0) {
    throw new TypeError("validatePhases: a phase list must not be empty");
  }

  const seenIds = new Set<string>();
  const produced = new Set<string>();
  let seeded = false;

  for (const phase of phases) {
    if (seenIds.has(phase.id)) {
      throw new TypeError(`validatePhases: duplicate phase id "${phase.id}"`);
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

    // Order matters: the key must exist in the set built from EARLIER phases only, so a
    // phase that requires what a later phase produces is still an error. A phase's own
    // `produces` is added after its `requires` are checked — a phase cannot satisfy its
    // own requirement.
    for (const key of phase.requires ?? []) {
      if (!produced.has(key)) {
        throw new TypeError(
          `validatePhases: phase "${phase.id}" requires note key "${key}", which no ` +
            "earlier phase produces — order matters, so a key produced by a later phase " +
            "does not satisfy it",
        );
      }
    }
    for (const key of phase.produces ?? []) {
      produced.add(key);
    }

    // The draft-state axis (SP4a Wave 1): a phase whose dependency is the shape of
    // `draft.fields` — not a note key, so the check above cannot see it — must be
    // preceded by a phase that populates the draft. Order matters here for the same
    // reason it does in the note-key check: the flag is built from EARLIER phases
    // only, and a phase's own `seedsDraft` is absorbed after its `requiresDraft` is
    // checked, so a phase does not satisfy itself.
    if (phase.requiresDraft && !seeded) {
      throw new TypeError(
        `validatePhases: phase "${phase.id}" declares requiresDraft, but no earlier phase ` +
          "declares seedsDraft — nothing populates the draft it reads, and the run would " +
          "die at the closing parse with a retryable error that re-spends every earlier " +
          "phase's calls. Put a phase that seeds the draft (a lifted base extractor, the " +
          "fill phase, the presence phase) before it — order matters, so a seeder later " +
          "in the list does not satisfy it",
      );
    }
    if (phase.seedsDraft) {
      seeded = true;
    }
  }
}
