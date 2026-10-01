import { z } from "zod";
import { describe, expect, test } from "vitest";

import { appliedTags, renderLeafInventory, walkLeafInventory } from "./leaf-inventory.js";
import { deriveExtractionShape } from "./shape-operations.js";
import type { ShapeOperation } from "./shape-operation.js";

/**
 * @file The field list's applied tags: what the committed operations did to
 * each original leaf, shown on a resume turn so the model does not re-propose
 * locked work. `appliedTags` reads the derived artifact's mapping — never
 * re-applies operations — and the renderer gains an optional third parameter
 * that must leave today's two-argument output byte-identical.
 */

const schema = z.object({
  vessel: z.object({
    name: z.string(),
    buildYear: z.string(),
    notes: z.string(),
  }),
  engines: z.array(
    z.object({
      make: z.string().describe("The engine manufacturer."),
      ratingKw: z.string(),
    }),
  ),
  surveyor: z.string(),
});

const render = (
  operations: readonly ShapeOperation[],
  declarations: Parameters<typeof renderLeafInventory>[1] = {},
): string =>
  renderLeafInventory(
    walkLeafInventory(schema),
    declarations,
    appliedTags(schema, deriveExtractionShape(schema, { ...declarations, operations })),
  );

describe("the field list shows what committed operations did", () => {
  test("2.1 — a dropped leaf's line carries [dropped] and stays in the list", () => {
    const applied = appliedTags(
      schema,
      deriveExtractionShape(schema, { operations: [{ op: "drop", path: "vessel.notes" }] }),
    );
    expect(applied.get("vessel.notes")).toEqual(["[dropped]"]);
    const text = render([{ op: "drop", path: "vessel.notes" }]);
    expect(text).toContain("    - notes (string) [dropped]");
    // Stays in the list — the line is tagged, not removed.
    expect(text).toContain("- vessel (object)\n    - name (string)");
  });

  test("2.2 — a dropped group tags every leaf of the group [dropped]", () => {
    const text = render([{ op: "drop", path: "vessel" }]);
    expect(text).toContain("    - name (string) [dropped]");
    expect(text).toContain("    - buildYear (string) [dropped]");
    expect(text).toContain("    - notes (string) [dropped]");
  });

  test("2.3 — a retyped leaf carries [retyped → number]", () => {
    const text = render([{ op: "retype", path: "engines.ratingKw", to: "number" }]);
    expect(text).toContain("    - ratingKw (string) [retyped → number]");
  });

  test("2.4 — moved leaves carry [moved → …]; a retyped-and-moved leaf carries both", () => {
    const operations: ShapeOperation[] = [
      {
        op: "regroup",
        group: "vessel",
        moves: { name: "identity.name", buildYear: "identity.buildYear" },
      },
      { op: "retype", path: "vessel.buildYear", to: "number" },
      { op: "nest", group: "surveyorDetails", moves: { surveyor: "who" } },
    ];
    const applied = appliedTags(schema, deriveExtractionShape(schema, { operations }));
    expect(applied.get("vessel.name")).toEqual(["[moved → vessel.identity.name]"]);
    expect(applied.get("vessel.buildYear")).toEqual([
      "[retyped → number]",
      "[moved → vessel.identity.buildYear]",
    ]);
    expect(applied.get("surveyor")).toEqual(["[moved → surveyorDetails.who]"]);
    const text = renderLeafInventory(walkLeafInventory(schema), {}, applied);
    expect(text).toContain("    - name (string) [moved → vessel.identity.name]");
    expect(text).toContain(
      "    - buildYear (string) [retyped → number] [moved → vessel.identity.buildYear]",
    );
    expect(text).toContain("- surveyor (string) [moved → surveyorDetails.who]");
  });

  test("2.5 — declaration tags first, then applied tags, then the description", () => {
    const declarations = { requiredOnCreate: { engines: ["make"] } };
    const text = render(
      [
        { op: "drop", path: "engines.ratingKw" },
        { op: "retype", path: "engines.make", to: "number" },
      ],
      declarations,
    );
    expect(text).toContain(
      '    - make (string) [required on create] [retyped → number] — "The engine manufacturer."',
    );
    expect(text).toContain("    - ratingKw (string) [dropped]");
  });

  test("2.6 — no third argument: byte-identical to today's rendering", () => {
    const entries = walkLeafInventory(schema);
    const declarations = { requiredOnCreate: { engines: ["make"] } };
    const expected = [
      "- surveyor (string)",
      "- vessel (object)",
      "    - name (string)",
      "    - buildYear (string)",
      "    - notes (string)",
      "- engines (array)",
      '    - make (string) [required on create] — "The engine manufacturer."',
      "    - ratingKw (string)",
    ].join("\n");
    expect(renderLeafInventory(entries, declarations)).toBe(expected);
  });

  test("2.7 — no operations: appliedTags returns an empty map", () => {
    expect(appliedTags(schema, deriveExtractionShape(schema, {})).size).toBe(0);
  });
});
