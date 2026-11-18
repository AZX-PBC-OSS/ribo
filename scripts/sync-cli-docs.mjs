#!/usr/bin/env node
/**
 * @file Sync the docs site's CLI pages into the @azx/ribo-cli package:
 * `docs/cli/*.md` → `packages/ribo-cli/docs/cli/`, verbatim.
 *
 * The shipped copy exists so a reader with only the installed tarball has the
 * CLI's docs — the docs site sits behind a login. It is a generated copy,
 * never a hand-maintained fork: edit the page under `docs/cli/`, then run
 * this script. `packages/ribo-cli/src/shipped-docs.test.ts` is the drift
 * check — it fails the build the moment a shipped copy and its source page
 * differ, and its failure names this script.
 *
 * Usage: node scripts/sync-cli-docs.mjs
 */
import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCE_DIR = `${REPO_ROOT}/docs/cli`;
const TARGET_DIR = `${REPO_ROOT}/packages/ribo-cli/docs/cli`;

const pages = readdirSync(SOURCE_DIR)
  .filter((name) => name.endsWith(".md"))
  .sort();

// Replace the directory whole, so a deleted page stops shipping instead of
// lingering as a stale copy.
rmSync(TARGET_DIR, { recursive: true, force: true });
mkdirSync(TARGET_DIR, { recursive: true });
for (const page of pages) {
  copyFileSync(`${SOURCE_DIR}/${page}`, `${TARGET_DIR}/${page}`);
}
console.log(`synced ${pages.length} CLI docs page(s) into packages/ribo-cli/docs/cli/`);
