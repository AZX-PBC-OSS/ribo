import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, expect, test } from "vitest";

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

// `npm pack` costs seconds per invocation, so the dry run happens once for
// the whole file and every test reads the same list.
let paths: readonly string[];

beforeAll(() => {
  paths = packedPaths();
}, 60_000);

test("the packed @azx/ribo-cli tarball contains README.md", () => {
  expect(paths).toContain("README.md");
});

test("the packed tarball ships the worked example corpus the README walks through", () => {
  for (const file of [
    "examples/basic-corpus/manifest.json",
    "examples/basic-corpus/schema.json",
    "examples/basic-corpus/morning-visit/case.json",
    "examples/basic-corpus/morning-visit/input.txt",
    "examples/basic-corpus/follow-up-letter/case.json",
    "examples/basic-corpus/voicemail/case.json",
    "examples/basic-corpus/service-sheet/case.json",
    "examples/basic-corpus/service-sheet/input.pdf",
    "examples/basic-corpus/service-sheet/site-note.txt",
  ]) {
    expect(paths).toContain(file);
  }
});

test("the packed tarball ships the CLI docs pages, and every relative link in the README resolves in it", () => {
  for (const page of ["index.md", "schema.md", "corpus.md", "scoring.md", "spend.md"]) {
    expect(paths).toContain(`docs/cli/${page}`);
  }
  // The README links the shipped pages by relative path (the docs site sits
  // behind a login), so each relative link must resolve to a packed file.
  const readme = readFileSync(join(PACKAGE_DIR, "README.md"), "utf8");
  const relativeLinks = [...readme.matchAll(/\]\(([^)\s]+)\)/g)]
    .map((match) => match[1]!)
    .filter((href) => !href.includes("://") && !href.startsWith("#"))
    .map((href) => href.split("#")[0]!);
  expect(relativeLinks.length).toBeGreaterThan(0);
  for (const link of relativeLinks) {
    expect(paths, link).toContain(link);
  }
});
