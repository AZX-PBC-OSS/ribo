import { expect, test } from "vitest";
import { PACKAGE_NAME } from "./index.js";

test("exports its package name", () => {
  expect(PACKAGE_NAME).toBe("@azx/ribo-ui-react");
});
