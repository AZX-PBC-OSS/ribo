/**
 * Unit tests for the docs Examples check (scripts/lib/docs-examples-check.mjs),
 * run in the Vitest `unit` project via the "scripts/*.test.mjs" include.
 *
 * The lib is root-parameterised, so every test points it at a committed
 * fixture tree under scripts/test-fixtures/check-api-examples/ — a miniature
 * repo root (docs/api, docs/guide, docs/examples, examples/ all present so the
 * vacuous-pass guards are satisfied). `baseline` is fully valid and must
 * produce ZERO violations; every other fixture mutates exactly one branch off
 * it, so a test that asserts the specific violation substring fails if that
 * branch is broken. Brokenness is referential only (wrong path, missing
 * region, orphan file, bad table row, non-private manifest) — never malformed
 * syntax — so Prettier and ESLint need no new ignores.
 *
 * The one thing a fixture cannot commit is a symlink (platform-fragile in
 * git), so the walker tests copy the `walker` fixture to a temp directory and
 * create its symlinks at test time.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";

import { checkDocsExamples } from "./lib/docs-examples-check.mjs";

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "test-fixtures",
  "check-api-examples",
);

/** Assert the fixture exists before asserting on it — a mistyped name would otherwise pass vacuously. */
function fixture(name) {
  const dir = path.join(FIXTURES, name);
  expect(existsSync(dir), `fixture missing: ${name}`).toBe(true);
  return dir;
}

/** Copy a fixture to a fresh temp directory and return its path (caller cleans up via returned path). */
function tempCopy(name) {
  const dest = path.join(mkdtempSync(path.join(tmpdir(), "docs-examples-check-")), name);
  cpSync(fixture(name), dest, { recursive: true });
  return dest;
}

test("baseline: a fully valid miniature repo produces zero violations", () => {
  const result = checkDocsExamples(fixture("baseline"));
  expect(result.violations).toEqual([]);
  expect(result.pageCount).toBe(3); // one page each under docs/api, docs/guide, docs/examples
  expect(result.referencedCount).toBe(3); // demo.run.ts, helpers.ts, smoke.run.ts
});

test("exemption list: a folder with no root .run.ts passes when named in typechecked-only.json", () => {
  const result = checkDocsExamples(fixture("exempt-folder-passes"));
  expect(result.violations).toEqual([]);
});

test("exemption list: the same folder unnamed fails the runnable-or-exempt check", () => {
  const result = checkDocsExamples(fixture("exempt-folder-missing"));
  expect(
    result.violations.some(
      (v) => v.includes("examples/typed") && v.includes("typechecked-only.json"),
    ),
  ).toBe(true);
});

test("walker: a symlinked node_modules and a symlinked vendor dir are never scanned", () => {
  const root = tempCopy("walker");
  // A dep-target dir holds dep.ts, an orphan if ever scanned. Two links reach
  // it from inside the examples pool: one named node_modules (the pnpm shape —
  // skipped by name) and one with an innocent name (skipped because it is a
  // symlink). Neither may be followed.
  symlinkSync(path.join(root, "dep-target"), path.join(root, "examples/smoke/node_modules"), "dir");
  symlinkSync(
    path.join(root, "dep-target"),
    path.join(root, "examples/smoke/linked-vendor"),
    "dir",
  );

  const result = checkDocsExamples(root);
  expect(result.violations).toEqual([]);
});

test("walker: the same directory as a REAL directory IS scanned — so the skip above is the branch", () => {
  const root = tempCopy("walker");
  // Control: the identical layout without the symlink trick must flag dep.ts,
  // proving zero violations in the previous test come from the skip, not from
  // the walker never reaching examples/smoke/ at all.
  mkdirSync(path.join(root, "examples/smoke/linked-vendor"));
  writeFileSync(
    path.join(root, "examples/smoke/linked-vendor/dep.ts"),
    'export const dep = "dep";\n',
  );

  const result = checkDocsExamples(root);
  expect(
    result.violations.some((v) => v.includes("linked-vendor/dep.ts") && v.includes("orphaned")),
  ).toBe(true);
});

test("per-pool orphans: an unreferenced file in the docs/api pool fails", () => {
  const result = checkDocsExamples(fixture("orphan-api"));
  expect(result.violations.some((v) => v.includes("lonely.ts") && v.includes("orphaned"))).toBe(
    true,
  );
});

test("per-pool orphans: an unreferenced file in the examples pool fails", () => {
  const result = checkDocsExamples(fixture("orphan-examples"));
  expect(result.violations.some((v) => v.includes("lonely.ts") && v.includes("orphaned"))).toBe(
    true,
  );
});

test("per-pool orphans: an examples/ file referenced only by a docs/guide page is not orphaned", () => {
  const result = checkDocsExamples(fixture("guide-referenced"));
  expect(result.violations).toEqual([]);
});

test("per-pool orphans: the name-based exemptions still hold for the docs/api pool", () => {
  // baseline carries an unreferenced docs/api/examples/run-examples.test.ts.
  const result = checkDocsExamples(fixture("baseline"));
  expect(result.violations).toEqual([]);
});

test("table rows: a folder with no row fails", () => {
  const result = checkDocsExamples(fixture("row-missing"));
  expect(
    result.violations.some((v) => v.includes("examples/extra") && v.includes("no table row")),
  ).toBe(true);
});

test("table rows: a folder named by two rows fails", () => {
  const result = checkDocsExamples(fixture("row-duplicate"));
  expect(
    result.violations.some((v) => v.includes("examples/smoke") && v.includes("2 table rows")),
  ).toBe(true);
});

test("table rows: a row naming a missing examples/ folder fails", () => {
  const result = checkDocsExamples(fixture("row-missing-folder"));
  expect(
    result.violations.some(
      (v) => v.includes("examples/ghost") && v.includes("resolves to nothing"),
    ),
  ).toBe(true);
});

test("table rows: a row naming a missing docs/api/examples/ file fails", () => {
  const result = checkDocsExamples(fixture("row-missing-api-file"));
  expect(
    result.violations.some(
      (v) => v.includes("docs/api/examples/ghost.ts") && v.includes("resolves to nothing"),
    ),
  ).toBe(true);
});

test("table rows: a row naming an existing docs/api/examples/ file passes (either-pool rule)", () => {
  const result = checkDocsExamples(fixture("row-api-file"));
  expect(result.violations).toEqual([]);
});

test("table rows: a row whose target is outside both pools fails", () => {
  const result = checkDocsExamples(fixture("row-outside-pools"));
  expect(
    result.violations.some(
      (v) => v.includes("packages/ribo-core") && v.includes("resolves to nothing"),
    ),
  ).toBe(true);
});

test("table rows: an Examples page with zero parseable rows fails", () => {
  const result = checkDocsExamples(fixture("zero-rows"));
  expect(result.violations.some((v) => v.includes("no parseable table rows"))).toBe(true);
});

test("private manifests: a package.json without private: true fails", () => {
  const result = checkDocsExamples(fixture("not-private"));
  expect(
    result.violations.some(
      (v) => v.includes("examples/smoke/package.json") && v.includes('"private": true'),
    ),
  ).toBe(true);
});

test("widened checks: a missing-file include on a docs/guide page fails", () => {
  const result = checkDocsExamples(fixture("guide-missing-file"));
  expect(
    result.violations.some((v) => v.includes("docs/guide") && v.includes("missing file")),
  ).toBe(true);
});

test("widened checks: a missing region referenced from a docs/guide page fails", () => {
  const result = checkDocsExamples(fixture("guide-missing-region"));
  expect(result.violations.some((v) => v.includes("docs/guide") && v.includes('"#nope"'))).toBe(
    true,
  );
});

test("widened checks: a non-.run import without the wording fails from a root other than docs/api", () => {
  const result = checkDocsExamples(fixture("non-run-wording"));
  expect(
    result.violations.some((v) => v.includes("docs/guide") && v.includes("type-checked only")),
  ).toBe(true);
});
