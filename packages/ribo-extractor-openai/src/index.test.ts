import { expect, test } from "vitest";
import * as api from "./index.js";

// The barrel is the contract of what consumers may depend on. This pins the
// public surface so an accidental drop from `index.ts` is a failing test, not a
// silent break at a consumer.
test("re-exports the single-shot extractor, the OpenAI-compatible transport, and the typed error", () => {
  expect(typeof api.singleShotExtractor).toBe("function");
  expect(typeof api.openAiChat).toBe("function");
  // ChatError is a VALUE export (a class), not just a type — without it the typed
  // errors are unreachable from outside the package.
  expect(typeof api.ChatError).toBe("function");
});
