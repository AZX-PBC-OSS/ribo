import { expect, test } from "vitest";
import { z } from "zod";

import { enveloped } from "../provenance/enveloped.js";
import type { ProvenanceGranularity } from "../provenance/enveloped.js";
import { walkFieldInventory } from "./field-inventory.js";

const valuesSchema = z.object({
  building: z.object({
    address: z.string().nullable().optional().describe("Street address"),
    details: z.object({
      sourceSpan: z.string().nullable().optional().describe("A real field, not row metadata"),
    }),
  }),
  systems: z.array(
    z.object({
      fuel: z.string().nullable().optional(),
      components: z.array(
        z.object({
          name: z.string().nullable().optional(),
          note: z.string().nullable().optional(),
        }),
      ),
    }),
  ),
});

const expectedPaths = [
  "building.address",
  "building.details.sourceSpan",
  "systems.fuel",
  "systems.components.name",
  "systems.components.note",
];

for (const granularity of [
  "leaf",
  "row",
  "none",
] as const satisfies readonly ProvenanceGranularity[]) {
  test(`one element-relative path per real leaf under ${granularity} provenance`, () => {
    const schema = enveloped(valuesSchema, {
      provenance: { building: granularity, systems: granularity },
    });
    const inventory = walkFieldInventory(schema);

    expect(inventory.map((entry) => entry.path)).toEqual(expectedPaths);
    expect(inventory.find((entry) => entry.path === "building.address")?.description).toBe(
      "Street address",
    );
    expect(
      inventory
        .filter((entry) => entry.path.startsWith("systems."))
        .every((entry) => entry.inArray),
    ).toBe(true);
  });
}

test("envelope members and row citations are not fields, but a real sourceSpan leaf is", () => {
  const leafSchema = enveloped(valuesSchema);
  const rowSchema = enveloped(valuesSchema, {
    provenance: { building: "row", systems: "row" },
  });

  for (const schema of [leafSchema, rowSchema]) {
    const paths = walkFieldInventory(schema).map((entry) => entry.path);
    expect(paths).toContain("building.details.sourceSpan");
    expect(paths).not.toContain("building.address.value");
    expect(paths).not.toContain("building.address.confidence");
    expect(paths).not.toContain("building.address.sourceSpan");
    expect(paths).not.toContain("building.sourceSpan");
    expect(paths).not.toContain("systems.sourceSpan");
    expect(paths).not.toContain("systems.components.sourceSpan");
  }
});
