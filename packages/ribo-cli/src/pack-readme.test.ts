import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

/**
 * @file The packed tarball's contents, pinned over `npm pack --dry-run
 * --json`: the README ships (npm includes it automatically only when one
 * exists, which is exactly the gap the dogfood run hit), and the worked
 * example corpus ships beside it, so an installed user can run the
 * walkthrough verbatim against `node_modules/@azx/ribo-cli/examples/basic-corpus`.
 *
 * The dry run needs no build and no registry: it lists what a pack would
 * archive from the working tree.
 */

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));

/** The file list `npm pack --dry-run --json` reports for this package. */
const packedPaths = (): readonly string[] => {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: PACKAGE_DIR,
    encoding: "utf8",
  });
  const parsed = JSON.parse(out) as readonly { readonly files: readonly { path: string }[] }[];
  return parsed[0]!.files.map((entry) => entry.path);
};

test("the packed @azx/ribo-cli tarball contains README.md", () => {
  expect(packedPaths()).toContain("README.md");
});

test("the packed tarball ships the worked example corpus the README walks through", () => {
  const paths = packedPaths();
  for (const file of [
    "examples/basic-corpus/manifest.json",
    "examples/basic-corpus/schema.json",
    "examples/basic-corpus/morning-visit/case.json",
    "examples/basic-corpus/morning-visit/input.txt",
    "examples/basic-corpus/follow-up-letter/case.json",
    "examples/basic-corpus/voicemail/case.json",
  ]) {
    expect(paths).toContain(file);
  }
});
