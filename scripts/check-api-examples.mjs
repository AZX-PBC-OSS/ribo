#!/usr/bin/env node
/**
 * @file The docs Examples gate — that every snippet reference a page makes is
 * real, and every example is actually used.
 *
 * VitePress's own missing-snippet handling was never confirmed fatal in this
 * repo, and no other gate notices a renamed example file, a renamed `#region`,
 * or an example file no page imports any more. So this script owns eight
 * checks, each failing the `docs:build` stage (which runs it first):
 *
 *   1. every `<<<` snippet import on a page under docs/api/, docs/guide/ or
 *      docs/examples/ points at a file that exists;
 *   2. every region name an import references exists as a `// #region` in that
 *      file — this is also what keeps the region boundary honest under
 *      `pnpm format`, instead of exempting examples from formatting;
 *   3. every example file in either pool (docs/api/examples/ and examples/,
 *      attributed by include-target prefix) is snippet-imported by at least one
 *      page (no orphans);
 *   4. every page that imports at least one example WITHOUT the `.run` suffix
 *      contains the words "type-checked only", so a page can never silently
 *      claim — or silently omit — execution status;
 *   5. every directory under examples/ is named by exactly one row of the
 *      Examples page's table;
 *   6. every table row's source link resolves to an existing examples/<folder>
 *      or docs/api/examples/<file>;
 *   7. every examples/ folder holds a root *.run.ts, or is named in
 *      examples/typechecked-only.json;
 *   8. every examples/<folder>/package.json declares "private": true.
 *
 * The check logic lives in scripts/lib/docs-examples-check.mjs — importable and
 * root-parameterised, because its branches are unit-tested against fixture
 * trees (scripts/check-api-examples.test.mjs) and a lib that called
 * `process.exit` could not be. This file is only the CLI: resolve the root,
 * print, exit.
 *
 * Dependency-free on purpose (same shape as scripts/skip-inventory.mjs): it
 * reads the Markdown as text because that is what VitePress reads. The runner
 * files (docs/api/examples/run-examples.test.ts, examples/run-examples.test.ts)
 * and the tsconfigs are exempt from check 3 by name — they are mechanism, not
 * example.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkDocsExamples } from "./lib/docs-examples-check.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const { violations, pageCount, referencedCount } = checkDocsExamples(ROOT);

if (violations.length > 0) {
  console.error(`check-api-examples: ${violations.length} violation(s):`);
  for (const violation of violations) console.error(`  - ${violation}`);
  process.exit(1);
}

console.log(
  `check-api-examples: ${pageCount} page(s) across docs/api/, docs/guide/ and docs/examples/, ` +
    `${referencedCount} example file(s) referenced, no missing files/regions/orphans`,
);
