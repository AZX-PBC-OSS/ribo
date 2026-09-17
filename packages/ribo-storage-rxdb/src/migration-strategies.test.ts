import { expect, test } from "vitest";

import {
  CAPTURE_DOCUMENT_UPGRADES,
  CAPTURE_DOCUMENT_VERSION,
  PLUGIN_STORAGE_DOCUMENT_UPGRADES,
  PLUGIN_STORAGE_DOCUMENT_VERSION,
  SESSION_DOCUMENT_UPGRADES,
  SESSION_DOCUMENT_VERSION,
} from "@azx/ribo-core";
import type { ShapeUpgrade } from "@azx/ribo-core";

import { toMigrationStrategies } from "./migration-strategies.js";

// RxDB keys by the version being migrated TO, while a ladder is indexed by the
// version being migrated FROM. Off by one here and every device gets the wrong
// transform applied at the wrong step — silently, because each strategy is a
// plausible function.
test("a ladder is keyed by target version, so rung 0 becomes key 1", () => {
  const ladder: ShapeUpgrade[] = [
    { reason: "first", rewrite: "none" },
    { reason: "second", upgrade: (document) => ({ ...document, touched: true }) },
  ];

  expect(Object.keys(toMigrationStrategies(ladder))).toEqual(["1", "2"]);
  expect(toMigrationStrategies(ladder)[2]!({})).toEqual({ touched: true });
});

// The reason `rewrite: "none"` cannot simply be omitted from the output. RxDB
// calls the migration plugin for every version above 0, and a declared version
// with no strategy makes the storage FAIL TO OPEN with COL12 — an error that
// arrives at open time and does not mention migrations.
test("a no-rewrite rung becomes an identity function, never a missing key", () => {
  const strategies = toMigrationStrategies([{ reason: "nothing changed", rewrite: "none" }]);

  expect(Object.keys(strategies)).toEqual(["1"]);
  const document = { id: "c1", status: "queued" };
  expect(strategies[1]!(document)).toEqual(document);
});

test("an empty ladder produces no strategies at all", () => {
  expect(toMigrationStrategies([])).toEqual({});
});

// The property that matters in production: every version RxDB will ask about has
// an answer. A gap is an un-bootable app, so this checks the real ladders rather
// than a fixture.
test.each([
  ["captures", CAPTURE_DOCUMENT_UPGRADES, CAPTURE_DOCUMENT_VERSION],
  ["sessions", SESSION_DOCUMENT_UPGRADES, SESSION_DOCUMENT_VERSION],
  ["plugin storage", PLUGIN_STORAGE_DOCUMENT_UPGRADES, PLUGIN_STORAGE_DOCUMENT_VERSION],
] as const)(
  "the %s ladder covers every version from 1 to its current one",
  (_, ladder, version) => {
    const strategies = toMigrationStrategies(ladder);

    for (let target = 1; target <= version; target += 1) {
      expect(typeof strategies[target]).toBe("function");
    }
    expect(Object.keys(strategies)).toHaveLength(version);
  },
);
