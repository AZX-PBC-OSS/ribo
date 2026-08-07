import { expect, test } from "vitest";
import { render } from "vitest-browser-react";
// Imported by *package name*, not a relative path — that is the point. This is the
// browser project's counterpart to
// packages/ribo-adapter-snuggpro/src/workspace-resolution.test.ts, which guards the
// same property for the node tier. The two projects need OPPOSITE spellings
// (`resolve.conditions` here, `ssr.resolve.conditions` there) and neither guard
// covers the other. If this file fails to resolve, the browser project has lost its
// block — do not "fix" it by switching to a relative import.
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
