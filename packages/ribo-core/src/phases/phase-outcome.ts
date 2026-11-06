import type { ExtractionUsage } from "../extraction/extractor.js";

/**
 * @file The per-item vocabulary a phase's `run` and `merge` speak: what one item's work
 * produced (its contribution plus the usage it spent), and how it settled (result or
 * error). Pure vocabulary — nothing here runs a phase or shapes a schedule; the engine is
 * a later wave.
 *
 * What this deliberately does not do: it does not wrap or extend `ExtractionResult` — a
 * phase item is one unit of work, not a whole extraction, and `merge` folds many of these
 * into the draft rather than one result replacing it.
 */

/**
 * What one item's `run` produced: its contribution, and optionally the usage it spent.
 *
 * **Why `run` returns this rather than a bare `C`.** The combinator owns usage
 * accumulation, but the phase definitions do not wrap an `Extractor` — they assemble
 * messages and call a transport directly, and one `run` can make several calls. Without a
 * usage channel the combinator would undercount every strategy it hosts.
 *
 * `usage` is **optional** precisely because a phase that computes rather than calls has
 * none to report — a plan-only or normalization phase makes no model calls, and forcing it
 * to invent `{ calls: 0 }` would blur "no calls" with "did not look".
 * @category Extraction
 */
export interface PhaseOutput<C> {
  /** The contribution the item's work produced. */
  readonly value: C;
  /** What the work cost, when the work called a model. See the note above. */
  readonly usage?: ExtractionUsage;
}

/**
 * How one item settled: a result carrying its contribution, or the error it failed with.
 *
 * **Why `outcome: "result" | "error"` and not a `Settled`-shaped type.** `arbitration.ts`
 * already establishes this exact discriminator for `ExtractionOutcome` and
 * `TranscriptionOutcome`; a second outcome vocabulary in the same package would be one too
 * many. A type named `Settled` with `status`/`fulfilled`/`rejected` would also read as
 * `PromiseSettledResult` while having a different shape (it carries the item), inviting the
 * wrong mental model in a file that also uses `Promise.allSettled`.
 *
 * **Why `error?: never` on the success arm.** It makes `.error` narrow on the discriminant
 * without a cast, matching `arbitration.ts`'s treatment — the member exists, so a
 * `switch`/`if` on `outcome` reads it as `undefined` rather than a missing property, and
 * the two arms stay structurally exclusive at construction.
 *
 * The error arm is reachable only for skip-policy phases; an abort-policy phase's failure
 * rejects before `merge` runs.
 * @category Extraction
 */
export type PhaseItemOutcome<I, C> =
  | { outcome: "result"; item: I; output: PhaseOutput<C>; error?: never }
  | { outcome: "error"; item: I; error: unknown };
