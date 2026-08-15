import { describe, expect, test } from "vitest";
import { z } from "zod";

import { HvacDuctInsulation, snuggExtractionSchema } from "./schema.js";
import {
  DUCT_INSULATION_VENDOR_LITERALS,
  resolveDuctInsulationVendorLiteral,
} from "./normalization.js";

/**
 * The platform's structured-output route (`POST <base>/_api/llm/chat`) rejects a
 * schema whose enum contains a double-quote character — verified in isolation
 * (`enum ["Duct Board 1.5\""]` → `400 validation_failed`). The failure reads
 * identically to an over-cap schema and cost an afternoon to bisect. These tests
 * guard against it recurring: no enum member anywhere in the extraction schema
 * may carry a quote, and the six `hvacDuctInsulation` members that used to must
 * still map back to their exact vendor wire strings.
 */

/**
 * Recursively collect every `enum` array in a JSON Schema tree, tagged with the
 * dotted path so a failure message names the offending field.
 */
function collectEnums(node: unknown, path: string): { path: string; values: unknown[] }[] {
  if (Array.isArray(node)) {
    return node.flatMap((child, i) => collectEnums(child, `${path}[${i}]`));
  }
  if (node === null || typeof node !== "object") return [];
  const obj = node as Record<string, unknown>;
  const found: { path: string; values: unknown[] }[] = [];
  if (Array.isArray(obj.enum)) {
    found.push({ path, values: obj.enum });
  }
  for (const [key, child] of Object.entries(obj)) {
    found.push(...collectEnums(child, `${path}.${key}`));
  }
  return found;
}

test("no enum member anywhere in the extraction schema contains a double quote", () => {
  const jsonSchema = z.toJSONSchema(snuggExtractionSchema, { target: "draft-2020-12" });
  const enums = collectEnums(jsonSchema, "$");

  // Assert at least one enum exists so this test does not vacuously pass because
  // the walker broke — the schema has 20+ enum-typed leaves.
  expect(enums.length, "expected enum arrays in the schema").toBeGreaterThan(0);

  for (const { path, values } of enums) {
    for (const value of values) {
      expect(
        typeof value === "string" && !value.includes('"'),
        `${path}: enum member "${value}" must not contain a double quote`,
      ).toBe(true);
    }
  }
});

describe("DUCT_INSULATION_VENDOR_LITERALS — alias to vendor-literal mapping", () => {
  test("every aliased member maps back to its exact vendor literal, character for character", () => {
    const expected: ReadonlyArray<readonly [string, string]> = [
      ["Duct Board 1 inch", 'Duct Board 1"'],
      ["Duct Board 1.5 inch", 'Duct Board 1.5"'],
      ["Duct Board 2 inch", 'Duct Board 2"'],
      ["Fiberglass 1.25 inch", 'Fiberglass 1.25"'],
      ["Fiberglass 2 inch", 'Fiberglass 2"'],
      ["Fiberglass 2.5 inch", 'Fiberglass 2.5"'],
    ];

    expect(DUCT_INSULATION_VENDOR_LITERALS.size).toBe(expected.length);

    for (const [alias, vendorLiteral] of expected) {
      // The alias is in the map and resolves to the exact vendor literal —
      // including the `.5` and `1.25` decimals and the trailing inch mark.
      expect(DUCT_INSULATION_VENDOR_LITERALS.get(alias)).toBe(vendorLiteral);
      expect(resolveDuctInsulationVendorLiteral(alias)).toBe(vendorLiteral);
      // The vendor literal carries a double quote — that is the whole reason
      // the alias exists, and a literal that lost its quote would be a wrong
      // value at write time for the opposite reason.
      expect(vendorLiteral).toContain('"');
    }
  });

  test("every alias is a real HvacDuctInsulation enum member", () => {
    const members = HvacDuctInsulation.options as readonly string[];
    for (const alias of DUCT_INSULATION_VENDOR_LITERALS.keys()) {
      expect(members, `alias "${alias}" must be a schema member`).toContain(alias);
    }
  });

  test("every vendor literal is NOT a schema member — the aliases replaced them", () => {
    const members = HvacDuctInsulation.options as readonly string[];
    for (const vendorLiteral of DUCT_INSULATION_VENDOR_LITERALS.values()) {
      expect(
        members,
        `vendor literal "${vendorLiteral}" must not remain in the schema`,
      ).not.toContain(vendorLiteral);
    }
  });

  test("the three unquoted members are unchanged and absent from the mapping", () => {
    const unquoted = ["No Insulation", "Reflective bubble wrap", "Measured (R Value)"];
    const members = HvacDuctInsulation.options as readonly string[];

    for (const member of unquoted) {
      // Still in the enum — not accidentally aliased or removed.
      expect(members).toContain(member);
      // Not in the lookup table — they need no translation.
      expect(DUCT_INSULATION_VENDOR_LITERALS.has(member)).toBe(false);
      // The resolver passes them through unchanged.
      expect(resolveDuctInsulationVendorLiteral(member)).toBe(member);
    }
  });

  test("resolveDuctInsulationVendorLiteral passes null through", () => {
    expect(resolveDuctInsulationVendorLiteral(null)).toBeNull();
  });
});
