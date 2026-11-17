import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

import { inspectSchema } from "./index.js";

/**
 * @file Guidance coverage counts DESCRIBED fields — and a description only
 * counts when the walk can see it. `z.fromJSONSchema` renders a property that
 * is absent from its parent's `required` list, carries `"nullable": true` and
 * a `description` as `ZodOptional(ZodNullable(leaf))` with the text on the
 * MIDDLE `ZodNullable`; a walk that read only the outermost wrapper's
 * description counted every such field as undescribed. The fixture is that
 * shape throughout — no `required` key at all — so the coverage figure is the
 * whole story: every field described, or the carry-through is broken.
 */

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/inspect/nullable-described.schema.json", import.meta.url)),
    "utf8",
  ),
) as unknown;

test("a document whose leaves are all non-required, nullable and described reports every one described", () => {
  const report = inspectSchema(fixture);
  expect(report.guidanceCoverage.total).toBe(6);
  expect(report.guidanceCoverage.described).toBe(report.guidanceCoverage.total);
  expect(report.guidanceCoverage.ratio).toBe(1);
});
