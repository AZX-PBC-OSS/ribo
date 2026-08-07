import { expect, test } from "vitest";
import { render } from "vitest-browser-react";
// Imported by *package name*, not a relative path — a smoke test that this tier
// (ribo-ui-react's browser project) can resolve a workspace package at all, the
// same way packages/ribo-adapter-snuggpro/src/workspace-resolution.test.ts does
// for the node tier and packages/ribo-core/src/workspace-resolution.browser.test.ts
// does for ribo-core's own browser project.
//
// This does NOT prove the browser project's `resolve.conditions` block in
// vitest.config.ts is intact. `@azx/ribo-core`'s `exports` has a `default`
// fallback to `dist/index.js`, and `./check.sh` always runs `build:packages`
// before `test`, so by the time this test runs `dist/` exists and this import
// succeeds identically whether or not the `@azx/source` condition is applied.
// The condition itself is guarded by `pnpm check:resolve`
// (`scripts/assert-source-condition.mjs`), which loads vitest.config.ts through
// Vitest's own `createVitest` and asserts the resolved `resolve.conditions`
// directly — that is the gate that actually fails if the block is lost. Keep
// this as a bare package-name import regardless — it is still worth having as
// proof the tier can do a cross-package import at all — just do not "fix" a
// failure here by switching to a relative import, which would defeat even that.
import { Recorder } from "@azx/ribo-core";

test("resolves @azx/ribo-core by package name from a ui-react browser test", () => {
  expect(new Recorder().phase).toBe("idle");
});

test("renders a React component in a real browser", async () => {
  // vitest-browser-react@2.2.0's `render` is async (it awaits React's
  // commit before returning), unlike the brief's synchronous sample --
  // resolved this way per AGENTS.md 5.4: pin what install actually gives you,
  // then adapt the call site to that API rather than inventing a version.
  const screen = await render(<p>ribo</p>);
  expect(screen.getByText("ribo")).toBeInTheDocument();
});

test("runs in a real browser with the capture APIs the recorder hook depends on", () => {
  expect(typeof MediaRecorder).toBe("function");
  expect(typeof indexedDB).toBe("object");
});
