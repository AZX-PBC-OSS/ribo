#!/usr/bin/env node
/**
 * @file The docs/api example-usage gate — that every snippet reference a page
 * makes is real, and every example is actually used.
 *
 * VitePress's own missing-snippet handling was never confirmed fatal in this
 * repo, and no other gate notices a renamed example file, a renamed `#region`,
 * or an example file no page imports any more. So this script owns the four
 * checks, each failing the `docs:build` stage (which runs it first):
 *
 *   1. every `<<<` snippet import on a page under docs/api/ points at a file
 *      that exists;
 *   2. every region name an import references exists as a `// #region` in that
 *      file — this is also what keeps the region boundary honest under
 *      `pnpm format`, instead of exempting examples from formatting;
 *   3. every example file under docs/api/examples/ is snippet-imported by at
 *      least one page (no orphans);
 *   4. every page that imports at least one example WITHOUT the `.run` suffix
 *      contains the words "type-checked only", so a page can never silently
 *      claim — or silently omit — execution status.
 *
 * Dependency-free on purpose (same shape as scripts/skip-inventory.mjs): it
 * reads the Markdown as text because that is what VitePress reads. The runner
 * (docs/api/examples/run-examples.test.ts) and the examples tsconfig are
 * exempt from check 3 by name — they are mechanism, not example.
 *
 * A vacuous pass is never a passing state: if docs/api/ is missing or holds no
 * pages, the gate fails rather than checking nothing successfully — same rule
 * as the runner, which may not register zero tests and report green.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API_DIR = path.join(ROOT, "docs", "api");
const EXAMPLES_DIR = path.join(API_DIR, "examples");

/** Mechanism files, exempt from the orphan check BY NAME — not by a loose pattern. */
const ORPHAN_EXEMPT = new Set(["run-examples.test.ts", "tsconfig.json"]);

const violations = [];

function walkMarkdown(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkMarkdown(full));
    else if (entry.endsWith(".md")) out.push(full);
  }
  return out;
}

function walkExamples(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkExamples(full));
    else if (/\.(ts|tsx)$/.test(entry) && !ORPHAN_EXEMPT.has(entry)) out.push(full);
  }
  return out;
}

// `<<< @/api/examples/file.ts#region` — VitePress snippet import, `@` = docs/.
const SNIPPET_IMPORT = /^<<<\s+@\/(\S+?)(?:#([\w-]+))?\s*$/gm;
const REGION_START = /(?:^|\n)\s*(?:\/\/|#)\s*#region\s+([\w-]+)/g;
// VitePress's findRegion needs a NAMED end marker — an unnamed `#endregion` never closes the
// region and the snippet silently renders the whole file instead. So the gate checks both ends.
const REGION_END = /(?:^|\n)\s*(?:\/\/|#)\s*#endregion\s+([\w-]+)/g;

if (!statSync(API_DIR, { throwIfNoEntry: false })?.isDirectory()) {
  console.error(
    "check-api-examples: docs/api/ does not exist — the section this gate owns is gone.",
  );
  process.exit(1);
}

const pages = walkMarkdown(API_DIR);
if (pages.length === 0) {
  console.error(
    "check-api-examples: no Markdown pages under docs/api/ — nothing to check is not a pass.",
  );
  process.exit(1);
}

const referenced = new Map(); // absolute example path -> Set of region names

for (const page of pages) {
  const text = readFileSync(page, "utf8");
  const rel = path.relative(ROOT, page);
  const importsOnPage = [];

  for (const match of text.matchAll(SNIPPET_IMPORT)) {
    const target = path.join(ROOT, "docs", match[1]);
    const region = match[2];

    if (!statSync(target, { throwIfNoEntry: false })) {
      violations.push(`${rel}: snippet import points at a missing file — ${match[1]}`);
      continue;
    }
    importsOnPage.push(target);

    if (region) {
      const source = readFileSync(target, "utf8");
      const starts = new Set([...source.matchAll(REGION_START)].map((m) => m[1]));
      const ends = new Set([...source.matchAll(REGION_END)].map((m) => m[1]));
      if (!starts.has(region)) {
        violations.push(
          `${rel}: snippet import references region "#${region}", which does not exist in ` +
            `${match[1]} (has: ${[...starts].map((r) => `"${r}"`).join(", ") || "none"})`,
        );
      } else if (!ends.has(region)) {
        violations.push(
          `${rel}: region "#${region}" in ${match[1]} has no named "// #endregion ${region}" ` +
            "— without it VitePress silently renders the whole file as the snippet.",
        );
      }
      const seen = referenced.get(target) ?? new Set();
      seen.add(region);
      referenced.set(target, seen);
    } else {
      if (!referenced.has(target)) referenced.set(target, new Set());
    }
  }

  if (importsOnPage.some((target) => !/\.run\.tsx?$/.test(target))) {
    if (!/type-checked only/i.test(text)) {
      violations.push(
        `${rel}: imports an example without the .run suffix (type-checked, never executed) ` +
          'but does not say "type-checked only" — state the execution status.',
      );
    }
  }
}

for (const example of walkExamples(EXAMPLES_DIR)) {
  if (!referenced.has(example)) {
    violations.push(
      `${path.relative(ROOT, example)}: no page snippet-imports this example file ` +
        "(orphaned) — import it from a docs/api page or delete it.",
    );
  }
}

if (violations.length > 0) {
  console.error(`check-api-examples: ${violations.length} violation(s):`);
  for (const violation of violations) console.error(`  - ${violation}`);
  process.exit(1);
}

console.log(
  `check-api-examples: ${pages.length} page(s) under docs/api/, ` +
    `${referenced.size} example file(s) referenced, no missing files/regions/orphans`,
);
