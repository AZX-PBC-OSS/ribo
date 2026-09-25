import { expect, test } from "vitest";
import * as api from "./index.js";
import type { HelixChatOptions } from "./index.js";

// The barrel is the contract of what consumers may depend on. This pins the
// public surface so an accidental drop from `index.ts` is a failing test, not a
// silent break at a consumer.
test("exports the Helix platform chat transport", () => {
  expect(typeof api.helixChat).toBe("function");
});

test("exports the options type a host constructs the transport with", () => {
  const options: HelixChatOptions = {
    token: "t",
    baseUrl: "https://dev-api.azx.helix.azxlabs.io/my-app",
  };
  expect(Object.keys(options)).toEqual(["token", "baseUrl"]);
});
