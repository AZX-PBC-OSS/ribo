import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, expect, test } from "vitest";

import { buildCliOnce } from "./test-support/build-once.js";

/**
 * @file Every command's `--help` ends with a pointer to the CLI's docs — the
 * installed package's own `docs/cli/` pages named FIRST (the docs site sits
 * behind a login; the shipped copies are readable by anyone the tarball
 * reached), the site's URL second as the online rendering of the same page.
 * One test per command, each pinning the pointer's exact tail text; a
 * pointer dropped, moved off the tail, or flipped back to site-first fails
 * here.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const BIN = join(REPO_ROOT, "packages", "ribo-cli", "dist", "bin.js");

beforeAll(() => {
  buildCliOnce();
}, 120_000);

/** Drive the built bin's help for one command path, and return its stdout. */
const helpOf = (...args: readonly string[]): string => {
  const result = spawnSync(process.execPath, [BIN, ...args, "--help"], { encoding: "utf8" });
  expect(result.status).toBe(0);
  return result.stdout;
};

/** The pointer tail, escaped for a regex: installed path primary, site URL secondary. */
const pointer = (page: string, what: string): string =>
  `Docs: node_modules\\/@azx\\/ribo-cli\\/docs\\/cli\\/${page}\\.md — ${what} ` +
  `\\(online: https:\\/\\/ribo-docs\\.azx\\.helix\\.azxlabs\\.io\\/cli\\/${page}\\.html\\)\\.$`;

test("the root --help ends with the docs pointer", () => {
  expect(helpOf().trimEnd()).toMatch(
    new RegExp(
      pointer("index", "the CLI's overview, install and the documents-to-scores walkthrough"),
      "u",
    ),
  );
});

test("ribo schema --help ends with the docs pointer", () => {
  expect(helpOf("schema").trimEnd()).toMatch(
    new RegExp(
      pointer("schema", "the schema dialect the subcommand reads, and what each report line means"),
      "u",
    ),
  );
});

test("ribo schema inspect --help ends with the docs pointer", () => {
  expect(helpOf("schema", "inspect").trimEnd()).toMatch(
    new RegExp(
      pointer("schema", "the schema dialect this command reads, and what each report line means"),
      "u",
    ),
  );
});

test("ribo eval --help ends with the docs pointer", () => {
  expect(helpOf("eval").trimEnd()).toMatch(
    new RegExp(
      "Docs: the corpus format — node_modules\\/@azx\\/ribo-cli\\/docs\\/cli\\/corpus\\.md " +
        "\\(online: https:\\/\\/ribo-docs\\.azx\\.helix\\.azxlabs\\.io\\/cli\\/corpus\\.html\\)\\n" +
        "      the verdicts and the run record — node_modules\\/@azx\\/ribo-cli\\/docs\\/cli\\/scoring\\.md " +
        "\\(online: https:\\/\\/ribo-docs\\.azx\\.helix\\.azxlabs\\.io\\/cli\\/scoring\\.html\\)\\n" +
        "      the estimate and --max-spend — node_modules\\/@azx\\/ribo-cli\\/docs\\/cli\\/spend\\.md " +
        "\\(online: https:\\/\\/ribo-docs\\.azx\\.helix\\.azxlabs\\.io\\/cli\\/spend\\.html\\)$",
      "u",
    ),
  );
});

test("ribo compare --help ends with the docs pointer", () => {
  expect(helpOf("compare").trimEnd()).toMatch(
    new RegExp(pointer("scoring", "the run record, the axes and the intersection rule"), "u"),
  );
});

test("ribo corpus --help ends with the docs pointer", () => {
  expect(helpOf("corpus").trimEnd()).toMatch(
    new RegExp(pointer("corpus", "the corpus format the subcommand reads"), "u"),
  );
});

test("ribo corpus text --help ends with the docs pointer", () => {
  expect(helpOf("corpus", "text").trimEnd()).toMatch(
    new RegExp(pointer("corpus", "the corpus format this command reads"), "u"),
  );
});
