import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

/**
 * @file The drift check for the docs the package ships.
 *
 * The CLI's docs live in `docs/cli/` (the docs site's source) and ship inside
 * the package as a generated copy at `packages/ribo-cli/docs/cli/`, produced
 * by `scripts/sync-cli-docs.mjs` — never a hand-maintained fork. This suite
 * fails the moment a shipped copy and its source page differ, so the two can
 * never drift: edit the source page, run the sync script, and this suite
 * passes again.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SOURCE_DIR = `${REPO_ROOT}/docs/cli`;
const SHIPPED_DIR = fileURLToPath(new URL("../docs/cli", import.meta.url));

/** The markdown pages of one docs directory, by file name. */
const pagesIn = (dir: string): readonly string[] =>
  readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .sort();

test("the shipped docs/cli copies are byte-identical to the docs site's CLI pages", () => {
  expect(pagesIn(SHIPPED_DIR)).toEqual(pagesIn(SOURCE_DIR));
  for (const page of pagesIn(SOURCE_DIR)) {
    const source = readFileSync(`${SOURCE_DIR}/${page}`);
    const shipped = readFileSync(`${SHIPPED_DIR}/${page}`);
    expect(
      shipped.equals(source),
      `${page} differs from docs/cli/${page} — run: node scripts/sync-cli-docs.mjs`,
    ).toBe(true);
  }
});
