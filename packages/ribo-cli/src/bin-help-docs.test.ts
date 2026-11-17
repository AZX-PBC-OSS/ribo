import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, expect, test } from "vitest";

import { buildCliOnce } from "./test-support/build-once.js";

/**
 * @file Every command's `--help` ends with a pointer to the CLI section of
 * the docs site — the formats the help does not spell out (the corpus
 * format, the schema dialect, the verdicts) live there and in the shipped
 * README. One test per command, each pinning the pointer's exact tail text;
 * a pointer dropped or moved off the tail fails here.
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

test("the root --help ends with the docs pointer", () => {
  expect(helpOf().trimEnd()).toMatch(
    /Docs: https:\/\/ribo-docs\.azx\.helix\.azxlabs\.io\/cli\/index\.html — the CLI's overview, install and the documents-to-scores walkthrough; the package's README covers the same ground\.$/u,
  );
});

test("ribo schema --help ends with the docs pointer", () => {
  expect(helpOf("schema").trimEnd()).toMatch(
    /Docs: https:\/\/ribo-docs\.azx\.helix\.azxlabs\.io\/cli\/schema\.html — the schema dialect the subcommand reads, and what each report line means\.$/u,
  );
});

test("ribo schema inspect --help ends with the docs pointer", () => {
  expect(helpOf("schema", "inspect").trimEnd()).toMatch(
    /Docs: https:\/\/ribo-docs\.azx\.helix\.azxlabs\.io\/cli\/schema\.html — the schema dialect this command reads, and what each report line means\.$/u,
  );
});

test("ribo eval --help ends with the docs pointer", () => {
  expect(helpOf("eval").trimEnd()).toMatch(
    new RegExp(
      "Docs: the corpus format — https://ribo-docs\\.azx\\.helix\\.azxlabs\\.io/cli/corpus\\.html\\n" +
        "      the verdicts and the run record — https://ribo-docs\\.azx\\.helix\\.azxlabs\\.io/cli/scoring\\.html\\n" +
        "      the estimate and --max-spend — https://ribo-docs\\.azx\\.helix\\.azxlabs\\.io/cli/spend\\.html$",
      "u",
    ),
  );
});

test("ribo compare --help ends with the docs pointer", () => {
  expect(helpOf("compare").trimEnd()).toMatch(
    /Docs: https:\/\/ribo-docs\.azx\.helix\.azxlabs\.io\/cli\/scoring\.html — the run record, the axes and the intersection rule\.$/u,
  );
});

test("ribo corpus --help ends with the docs pointer", () => {
  expect(helpOf("corpus").trimEnd()).toMatch(
    /Docs: https:\/\/ribo-docs\.azx\.helix\.azxlabs\.io\/cli\/corpus\.html — the corpus format the subcommand reads\.$/u,
  );
});

test("ribo corpus text --help ends with the docs pointer", () => {
  expect(helpOf("corpus", "text").trimEnd()).toMatch(
    /Docs: https:\/\/ribo-docs\.azx\.helix\.azxlabs\.io\/cli\/corpus\.html — the corpus format this command reads\.$/u,
  );
});
