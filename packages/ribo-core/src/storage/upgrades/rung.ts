/**
 * @file What a rung of a document's upgrade ladder is.
 *
 * A ladder is an ordered list: rung `i` describes the change from stored shape
 * version `i` to `i + 1`, so a ladder of length N describes every shape from 0
 * to N. A backend applies the rungs it needs and owns everything about *when* —
 * detection, batching, checkpointing, atomicity. Core owns only *what*.
 *
 * See `docs/roadmap/design/storage-migrations-design.md` §5.
 */

/**
 * One rung. Two branches, and the identity case is a branch rather than an
 * absent field on purpose.
 *
 * `{ reason }` alone — an omitted `upgrade` meaning "nothing to rewrite" — is
 * exactly what a half-finished rung looks like, and an adapter synthesising
 * identity from the omission would turn a forgotten rewrite into a silent
 * pass-through. Today a missing migration strategy makes RxDB refuse to *open*:
 * loud, immediate, on the first device to try. `rewrite: "none"` keeps that
 * property by making the no-op something a person had to type.
 *
 * `reason` is required on both branches. On an identity rung it is carrying the
 * real weight — "stored documents are already correct" is a claim, and a version
 * moved for some reason even when no bytes did.
 *
 * An `upgrade` is **pure and deterministic**, and takes and returns a loose
 * record because its input is a historical shape no current type describes — a
 * v1 document is not a v7 one, and typing it as such was a lie the old
 * per-backend strategies told.
 *
 * **It is not necessarily idempotent, and that is the backend's problem to
 * avoid.** A rung's input is a document at exactly version `i`; applying it to
 * its own output is undefined, and for the rungs in this repository it is
 * actively destructive — re-running the session split rebuilds an empty `legacy`
 * carrier over the populated one, losing the extraction and review it was in the
 * middle of moving. Nothing throws. So a backend owes one guarantee: **apply each
 * rung at most once per document.** RxDB provides it by tracking a version per
 * document and never handing a migrated row back to the same strategy; a backend
 * that batches and checkpoints must make the equivalent promise, and must not
 * assume it can replay a rung over a partially migrated collection. The ladder
 * tests pin this behaviour rather than wish it away.
 *
 * A rung cannot read another document, write another collection, or touch
 * attachment bytes. That bound is part of the contract: cross-collection work is
 * a backfill, and attachment work has no home here at all.
 * @category Offline & Storage
 */
export type ShapeUpgrade =
  | {
      readonly reason: string;
      readonly upgrade: (document: Record<string, unknown>) => Record<string, unknown>;
    }
  | { readonly reason: string; readonly rewrite: "none" };
