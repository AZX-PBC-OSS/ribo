import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

/**
 * @file The package README's load-bearing claims, pinned: the `npx ribo`
 * name-collision warning that names this package, the invocation paths the
 * warning recommends, and the docs links the README ends its sections with.
 * The README ships in the packed tarball (the pack-readme suite pins that),
 * so what it says is what an installed user gets.
 */

const README = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");

test("the README warns that `npx ribo` resolves an unrelated package, and names @azx/ribo-cli", () => {
  expect(README).toContain("npx ribo");
  expect(README).toMatch(/npx ribo[^\n]*\bunrelated\b|`npx ribo`[^\n]*\bunrelated\b/i);
  expect(README).toContain("@azx/ribo-cli");
});

test("the README names the three invocation paths the warning recommends", () => {
  expect(README).toContain("npx @azx/ribo-cli");
  expect(README).toContain("pnpm exec ribo");
  expect(README).toContain("./node_modules/.bin/ribo");
});

test("the README covers every command and links each docs page by its published URL path", () => {
  for (const command of ["schema inspect", "corpus text", "eval", "compare"]) {
    expect(README).toContain(`ribo ${command}`);
  }
  for (const page of ["index", "schema", "corpus", "scoring", "spend"]) {
    expect(README).toContain(`https://ribo-docs.azx.helix.azxlabs.io/cli/${page}.html`);
  }
});

test("the README walks the committed example corpus the package ships", () => {
  expect(README).toContain("examples/basic-corpus");
});
