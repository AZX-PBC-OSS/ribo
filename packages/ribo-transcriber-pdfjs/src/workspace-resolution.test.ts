import { expect, test } from "vitest";

// Imported by *package name*, not by relative path — a smoke test that this
// tier can resolve a workspace package at all. Every other test imports its
// own module relatively.
//
// This does NOT prove the `unit` project's `ssr.resolve.conditions` block in
// vitest.config.ts is intact, despite what an earlier version of this comment
// claimed. The package's `exports` has a `default` fallback to `dist/index.js`,
// and `./check.sh` always runs `build:packages` before `test`, so by the time
// this test runs `dist/` exists and this import succeeds identically whether or
// not the `@azx/source` condition is applied. The condition itself is guarded
// by `pnpm check:resolve` (`scripts/assert-source-condition.mjs`).
//
// The imported symbol is incidental and may be swapped for any other real
// export as the package evolves. The *import style* is the load-bearing part:
// keep it a bare package-name import, never a relative path.
import { PDFJS_ENGINE } from "@azx/ribo-transcriber-pdfjs";

test("resolves a workspace dependency by package name via the @azx/source condition", () => {
  expect(PDFJS_ENGINE).toBe("pdfjs");
});
