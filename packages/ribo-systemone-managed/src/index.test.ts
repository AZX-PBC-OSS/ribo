import { expect, test } from "vitest";

import { systemOneClient } from "./client.js";
import { SystemOneError } from "./errors.js";
import * as api from "./index.js";

/**
 * The barrel is the contract of what consumers may depend on: the factory and
 * the error are the very values their defining modules export, not re-creations.
 */
test("the barrel re-exports the factory and the error", () => {
  expect(api.systemOneClient).toBe(systemOneClient);
  expect(api.SystemOneError).toBe(SystemOneError);
});
