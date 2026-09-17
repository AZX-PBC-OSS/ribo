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
 * did, and belongs with the engine in Wave 3b.
 */
export function validatePhases<V extends Record<string, unknown>, P = NoProvenance>(
  phases: readonly Phase<V, P>[],
): void {
  if (phases.length === 0) {
    throw new TypeError("validatePhases: a phase list must not be empty");
  }

  const seenIds = new Set<string>();
  const produced = new Set<string>();

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
  }
}
