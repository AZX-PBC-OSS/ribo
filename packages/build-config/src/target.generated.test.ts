import { expect, test } from "vitest";

import { BROWSER_TARGET } from "./target.generated.js";

test("the generated floor is not empty", () => {
  // An empty target silently disables all downleveling, which would look like a
  // successful build while publishing whatever syntax the source happened to use.
  expect(BROWSER_TARGET.length).toBeGreaterThan(0);
});

test("every token is an oxc family followed by a version", () => {
  for (const token of BROWSER_TARGET) {
    expect(token).toMatch(/^(chrome|edge|firefox|safari|ios)\d+(\.\d+)*$/);
  }
});

test("no browserslist family name leaked through unmapped", () => {
  // and_chr/and_ff are current-only; if either reaches the floor, the mapping in
  // target.ts regressed and the floor is far too high.
  for (const token of BROWSER_TARGET) {
    expect(token).not.toMatch(/^and_/);
  }
});

test("one token per family", () => {
  const families = BROWSER_TARGET.map((t) => t.replace(/[\d.]+$/, ""));
  expect(new Set(families).size).toBe(families.length);
});
