import { expect, test } from "vitest";
import * as api from "./index.js";

// The barrel is the contract of what consumers may depend on. This pins the
// public surface so an accidental drop from `index.ts` is a failing test, not a
// silent break at a consumer.
test("re-exports the pdfjs transcriber class, the engine id, the threshold, and the text helpers", () => {
  expect(typeof api.PdfjsTranscriber).toBe("function");
  expect(typeof api.PDFJS_ENGINE).toBe("string");
  expect(typeof api.DEFAULT_NO_TEXT_LAYER_THRESHOLD).toBe("number");
  expect(typeof api.openDocument).toBe("function");
  expect(typeof api.readDocumentText).toBe("function");
  expect(typeof api.PAGE_MARKER).toBe("string");
  expect(typeof api.resetPdfjsCache).toBe("function");
});
