import { expect, test } from "vitest";
import * as api from "./index.js";

test("re-exports the managed docs transcriber class and the engine id constant", () => {
  expect(typeof api.ManagedDocsTranscriber).toBe("function");
  expect(typeof api.MANAGED_DOCS_ENGINE).toBe("string");
});
