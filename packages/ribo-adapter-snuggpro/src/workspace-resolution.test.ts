import { expect, test } from "vitest";

// Imported by *package name*, not by relative path. That is the whole point of
// this test: it is the only thing in the suite that exercises the
// `@azx/source` export condition, so it fails loudly ("Failed to resolve entry
// for package `@azx/ribo-core`") if vitest.config.ts ever stops applying that
// condition where Vitest actually reads it. Every other test imports its own
// module relatively and would keep passing with the condition removed.
//
// The imported symbol is incidental and may be swapped for any other real
// `@azx/ribo-core` export as the package evolves — it was `PACKAGE_NAME` until
// Phase 1 retired that placeholder. The *import style* is the load-bearing
// part: keep it a bare package-name import, never a relative path.
import { isSpanGrounded } from "@azx/ribo-core";

test("resolves a workspace dependency by package name via the @azx/source condition", () => {
  expect(isSpanGrounded("R-19", "The attic is R-19")).toBe(true);
});
