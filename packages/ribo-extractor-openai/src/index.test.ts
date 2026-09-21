import { expect, test } from "vitest";
import * as api from "./index.js";

// The barrel is the contract of what consumers may depend on. This pins the
// public surface so an accidental drop from `index.ts` is a failing test, not a
// silent break at a consumer.
test("re-exports both extractors, the schema split, the OpenAI-compatible transport, and the typed error", () => {
  expect(typeof api.singleShotExtractor).toBe("function");
  expect(typeof api.schemaRetryExtractor).toBe("function");
  expect(typeof api.perGroupExtractor).toBe("function");
  expect(typeof api.schemaExtractor).toBe("function");
  expect(typeof api.splitExtractionSchema).toBe("function");
  expect(typeof api.openAiChat).toBe("function");
  // ChatError is a VALUE export (a class), not just a type — without it the typed
  // errors are unreachable from outside the package.
  expect(typeof api.ChatError).toBe("function");
});

test("re-exports the extraction-common trust-boundary helpers from the barrel", () => {
  expect(typeof api.assertStopFinishReason).toBe("function");
  expect(typeof api.assertWireSafeSchemaName).toBe("function");
  expect(typeof api.completeOrClassify).toBe("function");
  expect(typeof api.parseWithSchema).toBe("function");
  expect(typeof api.parseJsonContent).toBe("function");
  expect(typeof api.buildMessages).toBe("function");
});

test("re-exports the prepared-groups builder — the one PreparedGroup construction site", () => {
  expect(typeof api.prepareGroups).toBe("function");
});
