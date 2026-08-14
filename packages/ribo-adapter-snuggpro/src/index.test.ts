import { expect, test } from "vitest";
import * as api from "./index.js";

// The barrel is the contract of what consumers may depend on. This pins the
// public surface so an accidental drop from `index.ts` is a failing test, not a
// silent break at a consumer.
test("re-exports the adapter, both schemas, the ctx schema, instructions, examples and normalization", () => {
  expect(api.snuggProAdapter.name).toBe(api.SNUGGPRO_ADAPTER_NAME);
  // BOTH field schemas are public, and they are two different objects: the
  // hand-written patch and the schema derived from it. Naming only one here would
  // let the other silently fall out of the barrel.
  expect(typeof api.snuggValuesSchema.parse).toBe("function");
  expect(typeof api.snuggExtractionSchema.parse).toBe("function");
  expect(api.snuggExtractionSchema).not.toBe(api.snuggValuesSchema);
  // The write context is exported as a schema now, not only as a type — a type
  // cannot parse a `Recording.ctx` off a persisted row.
  expect(typeof api.snuggCtxSchema.parse).toBe("function");
  expect(typeof api.snuggProInstructions).toBe("string");
  expect(api.snuggExamples).toHaveLength(1);
  expect(typeof api.normalizeFields).toBe("function");
  expect(typeof api.clampConfidence).toBe("function");
  expect(typeof api.inchesToAtticDepthBand).toBe("function");
  expect(typeof api.yearsToDhwAgeBand).toBe("function");
  // A representative enum is exported as a runtime value (not just a type), and
  // its members are the API's literal wire strings — punctuation and all. A
  // snake_cased token here would mean the schema drifted back off the spec.
  expect(api.HvacDuctLeakage.options).toContain("6% - Well sealed");
  // A resource group is exported too: a UI rendering one endpoint's card needs the
  // group schema, not just the whole field set.
  expect(typeof api.HvacFields.parse).toBe("function");
  // The platform-route caps are exported as runtime constants so the per-group
  // cap test and any consumer can guard against the vendor's HTTP 400.
  expect(api.SCHEMA_SERIALIZED_CHAR_CAP).toBe(32_768);
  expect(api.SCHEMA_NESTING_DEPTH_CAP).toBe(12);
});
