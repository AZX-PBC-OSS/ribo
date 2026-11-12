import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

import { SchemaInspectError, inspectSchema } from "./index.js";

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
) as { version: string };
const coreManifest = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../node_modules/@azx/ribo-core/package.json", import.meta.url)),
    "utf8",
  ),
) as { version: string };

// OpenAPI 3.0 form (ADR 0038): nullability as `nullable: true`, not an anyOf
// with a null arm. One nested group, two described leaves, one nullable leaf.
const document = {
  type: "object",
  properties: {
    home: {
      type: "object",
      description: "Home overview",
      properties: {
        address: { type: "string", description: "Street address" },
        yearBuilt: { type: "number", description: "Year built" },
        completed: { type: "boolean", description: "Audit completed", nullable: true },
      },
      required: ["address", "yearBuilt", "completed"],
    },
    notes: { type: "string", description: "Freeform notes", nullable: true },
  },
  required: ["home", "notes"],
};

test("inspectSchema returns the versioned report for an OpenAPI-3.0-form document", () => {
  const report = inspectSchema(document);
  expect(report.contractVersion).toBe(1);
  expect(report.cliVersion).toBe(manifest.version);
  expect(report.coreVersion).toBe(coreManifest.version);
  // Four leaves under the fixture shape: address, yearBuilt, completed, notes.
  expect(report.leafCount).toBe(4);
  expect(report.leafCount).toBeGreaterThanOrEqual(1);
});

test("inspectSchema rejects an empty document", () => {
  expect(() => inspectSchema({})).toThrow(SchemaInspectError);
});

test("inspectSchema rejects a non-schema JSON value", () => {
  expect(() => inspectSchema("just a string")).toThrow(SchemaInspectError);
  expect(() => inspectSchema([1, 2, 3])).toThrow(SchemaInspectError);
  expect(() => inspectSchema({ hello: "world" })).toThrow(SchemaInspectError);
});
