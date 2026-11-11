/**
 * The execution gate for examples/ — the one `*.test.ts` under `examples/`
 * (example packages carry no test files of their own; the orphan check in the
 * docs check script flags any stray one).
 *
 * A runnable example is a `*.run.ts` file at an example package's root whose
 * every named export is a zero-argument function ending in
 * `node:assert/strict` assertions. This runner `import.meta.glob`s those files
 * (eager, so tests register synchronously during collection — there is no
 * hand-maintained manifest) and registers one `test` per export. A wrong
 * assertion fails the `test` stage; a `.run.ts` exporting no functions — or
 * an export that is not a zero-argument function — fails here outright, so an
 * example can never pass by doing nothing.
 *
 * Two fail-loud guards beyond the docs/api runner's pattern, because this
 * glob is hand-widened rather than spelled per directory:
 *
 * - the glob throws when it matches ZERO modules, so a wrong pattern can
 *   never produce a green run that executed nothing;
 * - the folder-coverage walk reads `examples/` directly (directories only,
 *   never following symlinks, never entering `node_modules` — pnpm symlinks
 *   each example's `node_modules/@azx/*` into `packages/`), and fails when a
 *   folder holding a root `*.run.ts` is not reached by the glob above. The
 *   glob exists only here, so this check cannot drift from it.
 */

import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { test } from "vitest";
import typecheckedOnlyJson from "./typechecked-only.json";

type Runnable = () => unknown;

// `[]` at scaffolding time infers as never[]; widen it — the T2 check script
// is the file's second reader and stores folder names there.
const typecheckedOnly: readonly string[] = typecheckedOnlyJson;

const modules = import.meta.glob<Record<string, unknown>>(
  ["./**/*.run.ts", "!./**/node_modules/**"],
  { eager: true },
);

if (Object.keys(modules).length === 0) {
  throw new Error(
    "examples/run-examples.test.ts: the *.run.ts glob matched zero modules — " +
      "a runner that executes nothing proves nothing.",
  );
}

for (const [file, module] of Object.entries(modules)) {
  const runnables = Object.entries(module).filter(
    (entry): entry is [string, Runnable] => typeof entry[1] === "function",
  );

  if (runnables.length === 0) {
    throw new Error(
      `${file}: a *.run.ts example must export at least one zero-argument function — ` +
        "an example that exports nothing cannot prove anything.",
    );
  }

  for (const [name, run] of runnables) {
    if (run.length !== 0) {
      throw new Error(
        `${file}: export "${name}" takes parameters — every export of a *.run.ts ` +
          "example must be a zero-argument function.",
      );
    }
    test(`${file} › ${name}`, async () => {
      await run();
    });
  }
}

const root = new URL(".", import.meta.url);
for (const entry of readdirSync(root, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === "node_modules") continue;
  if (typecheckedOnly.includes(entry.name)) continue;
  const folder = new URL(`./${entry.name}/`, root);
  const hasRootRunFile = readdirSync(folder).some((name) => name.endsWith(".run.ts"));
  if (!hasRootRunFile) continue;
  const reached = Object.keys(modules).some((key) => key.startsWith(`./${entry.name}/`));
  assert.ok(
    reached,
    `examples/${entry.name}: holds a root *.run.ts the runner's glob cannot reach — ` +
      "the glob and the folder layout have drifted apart.",
  );
}
