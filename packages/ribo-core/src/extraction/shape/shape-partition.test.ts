import { z } from "zod";
import { describe, expect, test } from "vitest";

import type { ShapeOperation } from "./shape-operation.js";
import { deriveExtractionShape, deriveExtractionShapePartially } from "./shape-operations.js";

/**
 * @file The `partition` operation: it names a group's parts for the extraction
 * split, changing how a group is cut into calls and nothing else — the
 * extraction schema, the patch and the mapping are the partition-free
 * derivation's, and the artifact carries the parts in `partitions` (group key
 * → label → the group's direct field paths, `remainder` last).
 */

const surveySchema = z.object({
  // The object group of six string leaves most tests partition.
  basedata: z.object({
    yearBuilt: z.string().nullable().optional(),
    storeys: z.string().nullable().optional(),
    externalWall: z.string().nullable().optional(),
    floorType: z.string().nullable().optional(),
    glazing: z.string().nullable().optional(),
    dwellingType: z.string().nullable().optional(),
  }),
  // The collection: a partition's fields are its element's own properties.
  systems: z.array(
    z.object({
      make: z.string().nullable().optional(),
      fuel: z.string().nullable().optional(),
      ratingKw: z.string().nullable().optional(),
      location: z.string().nullable().optional(),
    }),
  ),
  // A top-level leaf — a partition's group may not be one.
  notes: z.string().nullable().optional(),
  // The group test 1.10 declares "row".
  quotes: z.array(
    z.object({
      text: z.string().nullable().optional(),
      page: z.string().nullable().optional(),
    }),
  ),
});

describe("the partition operation", () => {
  test("1.1 a partition on the object group: the record holds exactly the labels and fields given, and the schemas and mapping are untouched", () => {
    const partition: ShapeOperation = {
      op: "partition",
      group: "basedata",
      parts: {
        envelope: ["yearBuilt", "storeys", "externalWall"],
        comfort: ["floorType", "glazing", "dwellingType"],
      },
    };

    const { shape, refusals } = deriveExtractionShapePartially(surveySchema, {
      operations: [partition],
    });

    expect(refusals).toEqual([]);
    expect(shape.partitions).toEqual({
      basedata: {
        envelope: ["yearBuilt", "storeys", "externalWall"],
        comfort: ["floorType", "glazing", "dwellingType"],
      },
    });
    const plain = deriveExtractionShape(surveySchema);
    expect(z.toJSONSchema(shape.extractionSchema)).toEqual(z.toJSONSchema(plain.extractionSchema));
    expect(shape.mapping).toEqual(plain.mapping);
  });

  test("1.2 unnamed fields form a remainder part, in declaration order", () => {
    const partition: ShapeOperation = {
      op: "partition",
      group: "basedata",
      parts: { envelope: ["yearBuilt", "externalWall"] },
    };

    const { shape, refusals } = deriveExtractionShapePartially(surveySchema, {
      operations: [partition],
    });

    expect(refusals).toEqual([]);
    expect(shape.partitions).toEqual({
      basedata: {
        envelope: ["yearBuilt", "externalWall"],
        remainder: ["storeys", "floorType", "glazing", "dwellingType"],
      },
    });
  });

  test("1.3 a partition on the collection: fields are element-relative, and the record matches", () => {
    const partition: ShapeOperation = {
      op: "partition",
      group: "systems",
      parts: { identity: ["make", "fuel"], output: ["ratingKw"] },
    };

    const { shape, refusals } = deriveExtractionShapePartially(surveySchema, {
      operations: [partition],
    });

    expect(refusals).toEqual([]);
    expect(shape.partitions).toEqual({
      systems: {
        identity: ["make", "fuel"],
        output: ["ratingKw"],
        remainder: ["location"],
      },
    });
  });

  test("1.4 a field in two parts: refused local", () => {
    const partition: ShapeOperation = {
      op: "partition",
      group: "basedata",
      parts: { first: ["yearBuilt"], second: ["yearBuilt", "storeys"] },
    };

    const { shape, refusals } = deriveExtractionShapePartially(surveySchema, {
      operations: [partition],
    });

    expect(refusals).toHaveLength(1);
    expect(refusals[0]!.class).toBe("local");
    expect(refusals[0]!.operation).toEqual(partition);
    expect(shape.partitions).toEqual({});
  });

  test("1.5 a field removed by a drop in the same list: refused consequential, the cause is the drop, and the drop still applies", () => {
    const drop: ShapeOperation = { op: "drop", path: "basedata.glazing" };
    const partition: ShapeOperation = {
      op: "partition",
      group: "basedata",
      parts: { envelope: ["yearBuilt", "glazing"], comfort: ["storeys"] },
    };

    const { shape, refusals } = deriveExtractionShapePartially(surveySchema, {
      operations: [drop, partition],
    });

    expect(refusals).toHaveLength(1);
    const refusal = refusals[0]!;
    expect(refusal.class).toBe("consequential");
    expect(refusal.operation).toEqual(partition);
    expect(refusal.cause).toEqual({ kind: "operation", operation: drop, index: 0 });
    // The drop applied, and the refused partition wrote nothing: the mapping is
    // the drop-only derivation's (which also pins that glazing is gone — the
    // drop-only mapping is not empty).
    expect(shape.mapping).toEqual(
      deriveExtractionShape(surveySchema, { operations: [drop] }).mapping,
    );
    expect(shape.partitions).toEqual({});
  });

  test("1.6 a top-level-leaf group, an empty parts record, and a part with no fields: each refused local", () => {
    const onLeaf = deriveExtractionShapePartially(surveySchema, {
      operations: [{ op: "partition", group: "notes", parts: { all: ["notes"] } }],
    });
    expect(onLeaf.refusals).toHaveLength(1);
    expect(onLeaf.refusals[0]!.class).toBe("local");
    expect(onLeaf.shape.partitions).toEqual({});

    const emptyParts = deriveExtractionShapePartially(surveySchema, {
      operations: [{ op: "partition", group: "basedata", parts: {} }],
    });
    expect(emptyParts.refusals).toHaveLength(1);
    expect(emptyParts.refusals[0]!.class).toBe("local");
    expect(emptyParts.shape.partitions).toEqual({});

    const emptyFields = deriveExtractionShapePartially(surveySchema, {
      operations: [{ op: "partition", group: "basedata", parts: { heating: [] } }],
    });
    expect(emptyFields.refusals).toHaveLength(1);
    expect(emptyFields.refusals[0]!.class).toBe("local");
    expect(emptyFields.shape.partitions).toEqual({});
  });

  test("1.7 two partitions on one group: both refused set", () => {
    const first: ShapeOperation = {
      op: "partition",
      group: "basedata",
      parts: { envelope: ["yearBuilt"] },
    };
    const second: ShapeOperation = {
      op: "partition",
      group: "basedata",
      parts: { comfort: ["storeys"] },
    };

    const { shape, refusals } = deriveExtractionShapePartially(surveySchema, {
      operations: [first, second],
    });

    expect(refusals).toHaveLength(2);
    expect(refusals.map((refusal) => refusal.class)).toEqual(["set", "set"]);
    expect(refusals.map((refusal) => refusal.operation)).toEqual([first, second]);
    expect(shape.partitions).toEqual({});
  });

  test("1.8 a partition plus a regroup on the same group: both refused set, and neither applies", () => {
    const partition: ShapeOperation = {
      op: "partition",
      group: "basedata",
      parts: { envelope: ["yearBuilt", "storeys"] },
    };
    const regroup: ShapeOperation = {
      op: "regroup",
      group: "basedata",
      moves: { glazing: "fabric.glazing" },
    };

    const { shape, refusals } = deriveExtractionShapePartially(surveySchema, {
      operations: [partition, regroup],
    });

    expect(refusals).toHaveLength(2);
    expect(refusals.map((refusal) => refusal.class)).toEqual(["set", "set"]);
    expect(refusals.map((refusal) => refusal.operation)).toEqual([partition, regroup]);
    // The regroup did not apply and the partition did not write: the artifact
    // is the partition-free derivation's.
    expect(shape.mapping).toEqual(deriveExtractionShape(surveySchema).mapping);
    expect(shape.partitions).toEqual({});
  });

  test("1.9 a partition on a nest-created group: refused local", () => {
    const nest: ShapeOperation = { op: "nest", group: "era", moves: { notes: "captured" } };
    const partition: ShapeOperation = {
      op: "partition",
      group: "era",
      parts: { all: ["captured"] },
    };

    const { shape, refusals } = deriveExtractionShapePartially(surveySchema, {
      operations: [nest, partition],
    });

    expect(refusals).toHaveLength(1);
    expect(refusals[0]!.class).toBe("local");
    expect(refusals[0]!.operation).toEqual(partition);
    expect(shape.partitions).toEqual({});
  });

  test("1.10 a partition on the row group: refused consequential, with a declaration cause", () => {
    const partition: ShapeOperation = {
      op: "partition",
      group: "quotes",
      parts: { all: ["text"] },
    };

    const { refusals } = deriveExtractionShapePartially(surveySchema, {
      operations: [partition],
      provenance: { quotes: "row" },
    });

    expect(refusals).toHaveLength(1);
    expect(refusals[0]!.class).toBe("consequential");
    expect(refusals[0]!.operation).toEqual(partition);
    expect(refusals[0]!.cause).toEqual({
      kind: "declaration",
      declaration: "provenance",
      group: "quotes",
    });
  });

  test("1.11 an empty label and the reserved label remainder: each refused local", () => {
    // A parts RECORD cannot carry a duplicate label — an object literal or any
    // runtime construction collapses it to one key — so only the empty and
    // reserved labels are constructible here; the applier's duplicate-label
    // branch is defensive for the record form.
    const emptyLabel = deriveExtractionShapePartially(surveySchema, {
      operations: [{ op: "partition", group: "basedata", parts: { "": ["yearBuilt"] } }],
    });
    expect(emptyLabel.refusals).toHaveLength(1);
    expect(emptyLabel.refusals[0]!.class).toBe("local");
    expect(emptyLabel.shape.partitions).toEqual({});

    const reserved = deriveExtractionShapePartially(surveySchema, {
      operations: [{ op: "partition", group: "basedata", parts: { remainder: ["yearBuilt"] } }],
    });
    expect(reserved.refusals).toHaveLength(1);
    expect(reserved.refusals[0]!.class).toBe("local");
    expect(reserved.refusals[0]!.reason).toContain("reserved");
    expect(reserved.shape.partitions).toEqual({});
  });

  test("1.12 a sub-object field, a nonexistent field, and a two-segment field: each refused local", () => {
    const nestedGroupSchema = z.object({
      hvac: z.object({
        system: z.object({ fuel: z.string().nullable().optional() }),
        make: z.string().nullable().optional(),
        model: z.string().nullable().optional(),
      }),
    });

    const subObject = deriveExtractionShapePartially(nestedGroupSchema, {
      operations: [{ op: "partition", group: "hvac", parts: { p: ["system"] } }],
    });
    expect(subObject.refusals).toHaveLength(1);
    expect(subObject.refusals[0]!.class).toBe("local");

    const nonexistent = deriveExtractionShapePartially(nestedGroupSchema, {
      operations: [{ op: "partition", group: "hvac", parts: { p: ["ghost"] } }],
    });
    expect(nonexistent.refusals).toHaveLength(1);
    expect(nonexistent.refusals[0]!.class).toBe("local");

    const twoSegments = deriveExtractionShapePartially(nestedGroupSchema, {
      operations: [{ op: "partition", group: "hvac", parts: { p: ["system.fuel"] } }],
    });
    expect(twoSegments.refusals).toHaveLength(1);
    expect(twoSegments.refusals[0]!.class).toBe("local");
  });

  test("1.13 no partition: partitions is an empty record", () => {
    const { shape } = deriveExtractionShapePartially(surveySchema, { operations: [] });

    expect(shape.partitions).toEqual({});
  });
});
