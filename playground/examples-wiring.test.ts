/**
 * @file Wiring guard for the examples/ execution gate.
 *
 * The declared examples check runs `pnpm vitest run --project unit examples`. Its
 * `examples` path filter is a substring match that also reaches `docs/api/examples/**`,
 * so if the unit project's include ever stops reaching the examples glob, the runner
 * (examples/run-examples.test.ts) is silently not collected and the check passes green
 * while executing none of it. This file lives where BOTH the filter and the mainline
 * include reach it, and fails the moment that reach is lost — the same defense-in-depth
 * as `pnpm check:resolve`: config that looks load-bearing but is dead is exactly what
 * hid the workspace-resolution bug for as long as it did.
 *
 * Three facts whose loss would make the declared check vacuous:
 * - the runner file exists at all;
 * - the unit project's include reaches it (asserted against the imported config object,
 *   not a text grep — a grep also passes on an entry that is misspelled or placed in the
 *   wrong project);
 * - pnpm-workspace.yaml registers `examples/*`, so the example members exist as
 *   workspace packages with resolvable dependencies.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "vitest";

import vitestConfig from "../vitest.config";

type InlineProject = { test?: { name?: string; include?: readonly string[] } };

test("the examples/ execution gate is wired into the unit project", () => {
  assert.ok(
    existsSync(new URL("../examples/run-examples.test.ts", import.meta.url)),
    "examples/run-examples.test.ts is missing — the declared examples check has no subject.",
  );

  const projects = (vitestConfig.test?.projects ?? []) as InlineProject[];
  const unit = projects.find((project) => project.test?.name === "unit");
  assert.ok(unit, "vitest.config.ts defines no project named `unit`");

  assert.ok(
    unit.test?.include?.includes("examples/**/*.test.ts"),
    "the unit project's include no longer reaches examples/**/*.test.ts — the examples " +
      "runner would be silently uncollected, and `pnpm vitest run --project unit examples` " +
      "would pass while executing none of it.",
  );

  const workspace = readFileSync(new URL("../pnpm-workspace.yaml", import.meta.url), "utf8");
  assert.match(
    workspace,
    /^\s*-\s+"examples\/\*"\s*$/m,
    "pnpm-workspace.yaml no longer registers examples/* — the example members would " +
      "silently stop being workspace packages.",
  );
});
