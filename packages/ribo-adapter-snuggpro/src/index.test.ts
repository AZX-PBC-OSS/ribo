import { expect, test } from "vitest";
import * as api from "./index.js";

// The barrel is the contract of what consumers may depend on. This pins the
// public surface so an accidental drop from `index.ts` is a failing test, not a
// silent break at a consumer.
test("re-exports the adapter, schema, context, instructions, examples and normalization", () => {
  expect(api.snuggProAdapter.name).toBe(api.SNUGGPRO_ADAPTER_NAME);
  expect(typeof api.SnuggFieldsSchema.parse).toBe("function");
  expect(typeof api.snuggProInstructions).toBe("string");
  expect(api.snuggExamples).toHaveLength(1);
  expect(typeof api.normalizeFields).toBe("function");
  expect(typeof api.clampConfidence).toBe("function");
  expect(typeof api.inchesToAtticDepthBand).toBe("function");
  expect(typeof api.yearsToDhwAgeBand).toBe("function");
  // A representative enum is exported as a runtime value (not just a type).
  expect(api.HeatingFuel.options).toContain("fuel_oil");
});
