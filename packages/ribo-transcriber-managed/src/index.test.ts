import { expect, test } from "vitest";
import * as api from "./index.js";

// The barrel is the contract of what consumers may depend on. This pins the
// public surface so an accidental drop from `index.ts` is a failing test, not a
// silent break at a consumer.
test("re-exports the managed transcriber class and the engine id constant", () => {
  expect(typeof api.ManagedTranscriber).toBe("function");
  expect(typeof api.MANAGED_AZURE_SPEECH_ENGINE).toBe("string");
});
