import { describe, expect, test } from "vitest";
import { z } from "zod";

import { enveloped } from "@azx/ribo-core";

import { enumMembersAt } from "./enum-members.js";

// Built through `enveloped()` so the walk runs against the REAL extraction envelope —
// `{ value, confidence, sourceSpan }` with the enum under `value`, the value itself nullable —
// not a hand-rolled imitation that could agree with the walk and still disagree with core.
// The patch is shaped the way adapters declare theirs (every leaf `.nullable().optional()`).
const patch = z.strictObject({
  hvac: z.strictObject({
    systemType: z.enum(["furnace", "heat-pump"]).nullable().optional(),
    filterSize: z.string().nullable().optional(),
    filterMerv: z.number().nullable().optional(),
  }),
  windows: z.array(
    z.strictObject({
      glazing: z.enum(["single", "double", "triple"]).nullable().optional(),
      frame: z.string().nullable().optional(),
    }),
  ),
});

describe("enumMembersAt", () => {
  const schema = enveloped(patch);

  test("returns an enum leaf's members in declaration order", () => {
    expect(enumMembersAt(schema, ["hvac", "systemType"])).toEqual(["furnace", "heat-pump"]);
  });

  test("returns null for a string leaf", () => {
    expect(enumMembersAt(schema, ["hvac", "filterSize"])).toBeNull();
  });

  test("returns null for a number leaf", () => {
    expect(enumMembersAt(schema, ["hvac", "filterMerv"])).toBeNull();
  });

  test("steps through a collection's element schema — the index is not part of the address", () => {
    expect(enumMembersAt(schema, ["windows", 0, "glazing"])).toEqual([
      "single",
      "double",
      "triple",
    ]);
  });

  test("returns null for a path that does not resolve, rather than throwing", () => {
    expect(enumMembersAt(schema, ["no-such-group", "systemType"])).toBeNull();
    expect(enumMembersAt(schema, ["hvac", "no-such-leaf"])).toBeNull();
    expect(enumMembersAt(schema, ["hvac", "systemType", "deeper"])).toBeNull();
    expect(enumMembersAt(schema, ["hvac", 0, "systemType"])).toBeNull();
  });
});
