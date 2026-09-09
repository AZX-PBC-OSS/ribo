import { expect, test } from "vitest";
import * as api from "./index.js";

// The barrel is the contract of what consumers may depend on. This pins the
// public surface so an accidental drop from `index.ts` is a failing test, not a
// silent break at a consumer.
test("re-exports the pdfjs transcriber class, the engine id, and the threshold constant", () => {
  expect(typeof api.PdfjsTranscriber).toBe("function");
  expect(typeof api.PDFJS_ENGINE).toBe("string");
  expect(typeof api.DEFAULT_NO_TEXT_LAYER_THRESHOLD).toBe("number");
});
