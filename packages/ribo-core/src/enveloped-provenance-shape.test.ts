import { expect, test } from "vitest";
import { z } from "zod";

import { enveloped } from "./enveloped.js";
// JSON import rather than `node:fs`: this package carries no Node types, and a JSON import
// resolves identically under `tsc` and Vitest.
import fixtureSchema from "./__fixtures__/provenance-granularity-json-schema.json" with { type: "json" };

/**
 * Pin the JSON Schema the `"row"` and `"none"` granularities derive.
 *
 * ============================================================================
 * IF THIS TEST FAILS: the derivation changed what a row-provenance group asks the model for.
 * Go fix the derivation. Do NOT regenerate
 * `__fixtures__/provenance-granularity-json-schema.json` to make the test pass — that would
 * delete the only evidence this file exists to produce. The fixture is a FROZEN, hand-reviewed
 * artifact, not a snapshot to refresh.
 * ============================================================================
 *
 * The sibling of `ribo-adapter-snuggpro`'s `extraction-shape.test.ts`, which does the same job for
 * the default `"leaf"` derivation against the real Snugg field set — and which must keep passing
 * against its own untouched fixture, since `"leaf"` is what every existing caller gets. This one
 * covers the two derivations that fixture cannot: a fixture over a real adapter can only pin the
 * granularity that adapter declared, and no adapter in this repo declares a coarser one.
 *
 * The schema below is synthetic and deliberately small, but it is not arbitrary. It carries one
 * group of each kind — a `"row"` collection (the measured case: a wide table, one citation per
 * row), a `"row"` singleton (one citation for the whole group object), a `"none"` group, and a
 * group left at the default — so the fixture shows all four side by side and a derivation that
 * confused any two of them moves the bytes.
 *
 * Captured with `z.toJSONSchema` rather than through a real extractor: `ribo-core` sits below
 * every extractor and cannot import one. What `single-shot.ts` puts on the wire is that same call
 * on the same schema — `extraction-shape.test.ts` is the test that pins the extractor's own
 * assembly, and it does so through the real code path.
 *
 * Why a committed JSON file instead of `toMatchSnapshot()`: a Vitest snapshot is one `vitest -u`
 * away from being regenerated into agreement with a broken derivation, which is the exact failure
 * mode a frozen fixture exists to prevent. A file the test only ever READS cannot be updated by
 * accident.
 *
 * Why STRING equality, not `toEqual`: key order is part of the bytes a model receives, and
 * `toEqual` is blind to reordering. A row's `sourceSpan` coming FIRST rather than last is a real
 * change to what the model is asked to emit and must fail here.
 */

const leaf = () => z.number().nullable().optional();

const valuesSchema = z.object({
  /** A wide collection: plain leaves, one citation per row. */
  rooms: z.array(z.object({ name: z.string().nullable().optional(), heatingLoad: leaf() })),
  /** A singleton group: one citation for the whole object. */
  report: z.object({ summary: z.string().nullable().optional() }).optional(),
  /** No provenance at all. */
  utilities: z.array(z.object({ account: z.string().nullable().optional() })).optional(),
  /** Left at the default — every leaf still its own envelope. */
  basedata: z.object({ yearBuilt: leaf() }).optional(),
});

const provenance = { rooms: "row", report: "row", utilities: "none" } as const;

test("the JSON Schema a mixed-provenance derivation produces matches the frozen fixture", () => {
  const derived = z.toJSONSchema(enveloped(valuesSchema, { provenance }), {
    target: "draft-2020-12",
  });

  // A MISMATCH HERE MEANS THE DERIVATION CHANGED WHAT IS SENT TO THE MODEL. Fix the
  // derivation; do not edit the fixture to silence this test.
  expect(JSON.stringify(derived)).toBe(JSON.stringify(fixtureSchema));
});

test("the fixture is closed and fully required at every level, like the leaf derivation", () => {
  // Coarser provenance changes WHERE the citation sits. It does not relax `provenance.ts`'s
  // anti-hallucination rule: every key is still present and still nullable, so "not stated" is
  // an explicit `null` rather than an omitted key, at every granularity.
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, `${path}[${i}]`));
      return;
    }
    if (node === null || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    if (obj.type === "object") {
      expect(obj.additionalProperties, `${path}.additionalProperties`).toBe(false);
      expect(
        [...((obj.required as string[] | undefined) ?? [])].sort(),
        `${path}.required`,
      ).toEqual(Object.keys((obj.properties as Record<string, unknown> | undefined) ?? {}).sort());
    }
    for (const [key, child] of Object.entries(obj)) walk(child, `${path}.${key}`);
  };

  walk(fixtureSchema, "$");
});
