import { choice as sdkChoice, noul as sdkNoul } from "@typesafe-ai/sdk";
import { expect, test } from "vitest";

import { systemOneClient } from "./client.js";
import { SystemOneError } from "./errors.js";
import * as api from "./index.js";

/**
 * The barrel is the contract of what consumers may depend on: the factory, the
 * error and the question builders are the very values their defining modules
 * export, not re-creations.
 */
test("the barrel re-exports the factory, the error and the question builders", () => {
  expect(api.systemOneClient).toBe(systemOneClient);
  expect(api.SystemOneError).toBe(SystemOneError);
  expect(api.noul).toBe(sdkNoul);
  expect(api.choice).toBe(sdkChoice);
});
