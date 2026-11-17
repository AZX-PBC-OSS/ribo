import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

/**
 * @file The docs site's CLI section, pinned cheaply at the source: the
 * VitePress config must declare the `/cli/` sidebar group with an entry per
 * page, a nav entry that reaches it, and every page it links must exist.
 * Rendering is gated by `docs:build` (dead links fail it); this suite is the
 * fast check that the section is wired at all.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const CONFIG = readFileSync(`${REPO_ROOT}/docs/.vitepress/config.ts`, "utf8");

/** The CLI section's pages: the sidebar link and the file it must resolve to. */
const PAGES: readonly { readonly link: string; readonly file: string }[] = [
  { link: "/cli/", file: "docs/cli/index.md" },
  { link: "/cli/schema", file: "docs/cli/schema.md" },
  { link: "/cli/corpus", file: "docs/cli/corpus.md" },
  { link: "/cli/scoring", file: "docs/cli/scoring.md" },
  { link: "/cli/spend", file: "docs/cli/spend.md" },
];

test("the VitePress config declares a /cli/ sidebar group with an entry per CLI page", () => {
  expect(CONFIG).toContain('"/cli/"');
  for (const page of PAGES) {
    expect(CONFIG).toContain(`link: "${page.link}"`);
  }
});

test("the VitePress nav reaches the CLI section", () => {
  expect(CONFIG).toMatch(/nav:\s*\[[\s\S]*link: "\/cli\/"/);
});

test("every CLI page the sidebar links exists", () => {
  for (const page of PAGES) {
    expect(existsSync(`${REPO_ROOT}/${page.file}`), page.file).toBe(true);
  }
});
