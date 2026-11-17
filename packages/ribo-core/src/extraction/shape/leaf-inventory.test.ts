import { z } from "zod";
import { describe, expect, test } from "vitest";

import { walkLeafInventory } from "./leaf-inventory.js";

/**
 * @file The inventory's description carry-through. `z.fromJSONSchema` renders
 * a property that is absent from its parent's `required` list, carries
 * `"nullable": true` and a `description` as `ZodOptional(ZodNullable(leaf))`
 * with the text on the MIDDLE `ZodNullable` — the same conversion the CLI's
 * `convertDocument` performs, down to the `defaultTarget: "openapi-3.0"`
 * option. A walk that read only the outermost wrapper's description reported
 * those leaves as undescribed, and everything built from the walk (field
 * guidance, the inspect coverage figure) lost the text with it.
 */

/** The same conversion `convertDocument` runs, option for option. */
const converted = (document: unknown): z.ZodObject =>
  z.fromJSONSchema(document as Parameters<typeof z.fromJSONSchema>[0], {
    defaultTarget: "openapi-3.0",
  }) as z.ZodObject;

/** A document whose leaves are all non-required, nullable and described. */
const DESCRIBED_DOCUMENT = {
  type: "object",
  properties: {
    notes: { type: "string", nullable: true, description: "free-text notes" },
    yearBuilt: { type: "number", nullable: true, description: "year the home was built" },
  },
};

describe("walkLeafInventory descriptions", () => {
  test("returns the description of a non-required, nullable, described leaf", () => {
    const entries = walkLeafInventory(converted(DESCRIBED_DOCUMENT));
    const byPath = new Map(entries.map((entry) => [entry.path, entry]));
    expect(byPath.get("notes")?.description).toBe("free-text notes");
    expect(byPath.get("yearBuilt")?.description).toBe("year the home was built");
  });

  test("a required nullable leaf's description keeps surfacing from the outermost wrapper", () => {
    const schema = converted({
      type: "object",
      properties: {
        count: { type: "number", nullable: true, description: "a count" },
      },
      required: ["count"],
    });
    expect(walkLeafInventory(schema)[0]?.description).toBe("a count");
  });
});
