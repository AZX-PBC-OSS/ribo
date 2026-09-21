/**
 * @file The adapter from core's upgrade ladders to RxDB's `migrationStrategies`.
 *
 * Core owns *what* each version change does, as an ordered list of rungs. RxDB
 * wants an object keyed by the version being migrated **to**, with an entry for
 * every version above 0. This converts one into the other, and that is the whole
 * of this package's remaining migration logic.
 *
 * The "entry for every version" rule is satisfied here, not in the ladder, and
 * that placement is the point: it is RxDB's rule, not a fact about captures. A
 * rung that declares `rewrite: "none"` becomes an identity function, because
 * RxDB fails to *open* — not to migrate — when a declared version has no
 * strategy, and that failure arrives as COL12 without mentioning migrations.
 *
 * See `docs/roadmap/design/storage-migrations-design.md` §8.
 */

import type { ShapeUpgrade } from "@azx/ribo-core";

/** RxDB's strategy map: target version → transform. */
export type MigrationStrategies = Record<
  number,
  (document: Record<string, unknown>) => Record<string, unknown>
>;

/**
 * Convert an upgrade ladder into RxDB's `migrationStrategies`.
 *
 * Rung `i` moves a document from version `i` to `i + 1`, so it becomes the entry
 * keyed `i + 1`. A ladder of length N therefore produces keys 1 through N and no
 * key 0 — RxDB never migrates *to* version 0, because that is where documents
 * start.
 */
export function toMigrationStrategies(ladder: readonly ShapeUpgrade[]): MigrationStrategies {
  const strategies: MigrationStrategies = {};
  ladder.forEach((rung, index) => {
    strategies[index + 1] = "upgrade" in rung ? rung.upgrade : (document) => document;
  });
  return strategies;
}
