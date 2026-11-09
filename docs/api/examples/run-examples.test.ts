/**
 * The execution gate for docs/api examples (R6b) — the one test file matching
 * the Vitest `unit` project's docs/api examples test-include glob (the include
 * spells that glob out; this comment cannot, because a literal glob's slash
 * would close this very comment).
 *
 * A runnable example is a `*.run.ts` file under docs/api/examples/ whose every
 * named export is a zero-argument function ending in `node:assert/strict`
 * assertions on what the page prose claims. This runner `import.meta.glob`s
 * those files (eager, so tests register synchronously during collection —
 * there is no hand-maintained manifest) and registers one `test` per export.
 * A wrong assertion fails the `test` stage; a `.run.ts` exporting no functions
 * — or an export that is not a zero-argument function — fails here outright,
 * so an example can never pass by doing nothing.
 *
 * The glob matches `.run.ts` only, so `.tsx` hook examples and browser-only
 * `.ts` examples are excluded by construction: they are type-checked by the
 * examples tsconfig and never executed (their pages say "type-checked only",
 * checked by scripts/check-api-examples.mjs).
 */

import { test } from "vitest";

type Runnable = () => unknown;

const modules = import.meta.glob<Record<string, unknown>>("./**/*.run.ts", { eager: true });

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
