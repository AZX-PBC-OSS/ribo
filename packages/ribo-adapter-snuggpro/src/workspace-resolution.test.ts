import { expect, test } from "vitest";

// Imported by *package name*, not by relative path — a smoke test that this
// tier can resolve a workspace package at all. Every other test imports its
// own module relatively.
//
// This does NOT prove the `unit` project's `ssr.resolve.conditions` block in
// vitest.config.ts is intact, despite what an earlier version of this comment
// claimed. `@azx/ribo-core`'s `exports` has a `default` fallback to
// `dist/index.js`, and `./check.sh` always runs `build:packages` before
// `test`, so by the time this test runs `dist/` exists and this import
// succeeds identically whether or not the `@azx/source` condition is applied.
// R2 found that deleting the block left this test green. The condition itself
// is guarded by `pnpm check:resolve` (`scripts/assert-source-condition.mjs`),
// which loads vitest.config.ts through Vitest's own `createVitest` and asserts
// the resolved `ssr.resolve.conditions` directly — that is the gate that
// actually fails when the block is lost, and the one to read for how this is
// really proven.
//
// The imported symbol is incidental and may be swapped for any other real
// `@azx/ribo-core` export as the package evolves — it was `PACKAGE_NAME` until
// Phase 1 retired that placeholder. The *import style* is the load-bearing
// part: keep it a bare package-name import, never a relative path.
import { isSpanGrounded } from "@azx/ribo-core";

test("resolves a workspace dependency by package name via the @azx/source condition", () => {
  expect(isSpanGrounded("R-19", "The attic is R-19")).toBe(true);
});
