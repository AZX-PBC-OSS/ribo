import { expect, test } from "vitest";

import { colorsFor } from "./colors.js";

const ESC = "\u001b";

test("a piped stream gets no colour even when CI is set", () => {
  expect(
    colorsFor({ isTTY: false }, { CI: "true", GITHUB_ACTIONS: "true" }).red("x"),
  ).not.toContain(ESC);
  expect(colorsFor({}, { CI: "1" }).bold("x")).toBe("x");
});

test("a terminal gets colour unless NO_COLOR is non-empty", () => {
  expect(colorsFor({ isTTY: true }, {}).red("x")).toContain(ESC);
  expect(colorsFor({ isTTY: true }, { NO_COLOR: "1" }).red("x")).toBe("x");
  expect(colorsFor({ isTTY: true }, { NO_COLOR: "" }).red("x")).toContain(ESC);
});
