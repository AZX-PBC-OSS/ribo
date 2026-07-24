import { expect, test } from "vitest";
import * as api from "./index.js";

// The barrel is the contract of what consumers may depend on. This pins the
// public surface so an accidental drop from `index.ts` is a failing test, not a
// silent break at a consumer.
test("re-exports the single-shot extractor and the OpenAI-compatible transport", () => {
  expect(typeof api.singleShotExtractor).toBe("function");
  expect(typeof api.openAiChat).toBe("function");
});
