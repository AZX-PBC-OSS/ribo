import { expect, test } from "vitest";
import * as api from "./index.js";

// The barrel is the contract of what consumers may depend on. This pins the
// public surface so an accidental drop from `index.ts` is a failing test, not a
// silent break at a consumer, and so an internal leaking back in is one too.
test("re-exports the pdfjs transcriber class, the engine id, the threshold, and the page marker", () => {
  expect(typeof api.PdfjsTranscriber).toBe("function");
  expect(typeof api.PDFJS_ENGINE).toBe("string");
  expect(typeof api.DEFAULT_NO_TEXT_LAYER_THRESHOLD).toBe("number");
  expect(typeof api.PAGE_MARKER).toBe("string");
  expect(typeof api.layoutPageText).toBe("function");
});

test("does not re-export the internal text-reading helpers or layout tuning constants", () => {
  expect(api).not.toHaveProperty("openDocument");
  expect(api).not.toHaveProperty("readDocumentText");
  expect(api).not.toHaveProperty("resetPdfjsCache");
  expect(api).not.toHaveProperty("isPdfTextItem");
  expect(api).not.toHaveProperty("COLUMN_SEPARATOR");
  expect(api).not.toHaveProperty("DEFAULT_COLUMN_GAP_PT");
  expect(api).not.toHaveProperty("DEFAULT_ROW_TOLERANCE_PT");
  expect(api).not.toHaveProperty("DEFAULT_WORD_GAP_PT");
});
