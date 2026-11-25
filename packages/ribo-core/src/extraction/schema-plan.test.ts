import { expect, test } from "vitest";
import { z } from "zod";

import {
  enveloped,
  parseSchemaPlan,
  planFingerprint,
  SCHEMA_PLAN_CONTRACT_VERSION,
} from "../index.js";
import type { SchemaPlan } from "../index.js";

const valuesSchema = z.object({
  building: z.object({
    address: z.string().nullable().optional(),
    yearBuilt: z.number().nullable().optional(),
  }),
  systems: z.array(
    z.object({
      fuel: z.string().nullable().optional(),
    }),
  ),
});
const extractionSchema = enveloped(valuesSchema);

const plan = (): SchemaPlan => ({
  version: SCHEMA_PLAN_CONTRACT_VERSION,
  schemaFingerprint: "a".repeat(64),
  fieldPaths: ["building.address", "building.yearBuilt", "systems.fuel"],
  pieces: [
    {
      name: "building identity",
      description: "The building's address and construction year.",
      key: "building",
      paths: ["building.address", "building.yearBuilt"],
    },
    {
      name: "system fuel",
      description: "The fuel used by each system.",
      key: "systems",
      paths: ["systems.fuel"],
    },
  ],
  provenance: {
    model: "stub-model",
    backend: "stub-backend",
    createdAt: "2026-09-21T12:00:00.000Z",
  },
});

test("a complete plan round-trips its version and planning provenance", () => {
  const input = plan();
  const parsed = parseSchemaPlan(input, extractionSchema);

  expect(parsed).toEqual(input);
  expect(parsed.version).toBe(1);
  expect(parsed.provenance).toEqual(input.provenance);
  expect(parsed.fieldPaths).toEqual(["building.address", "building.yearBuilt", "systems.fuel"]);
});

test("strict parsing refuses unknown keys at every object level", () => {
  const withRootKey = { ...plan(), unexpected: true };
  const withPieceKey = {
    ...plan(),
    pieces: [{ ...plan().pieces[0]!, unexpected: true }, ...plan().pieces.slice(1)],
  };
  const withProvenanceKey = {
    ...plan(),
    provenance: { ...plan().provenance, unexpected: true },
  };

  for (const candidate of [withRootKey, withPieceKey, withProvenanceKey]) {
    expect(() => parseSchemaPlan(candidate, extractionSchema)).toThrow(/unrecognized|unexpected/iu);
  }
});

const invalidPlans: ReadonlyArray<{
  readonly name: string;
  readonly edit: (candidate: SchemaPlan) => void;
  readonly message: RegExp;
}> = [
  {
    name: "an omitted schema field",
    edit: (candidate) => {
      candidate.fieldPaths = candidate.fieldPaths.filter((path) => path !== "building.yearBuilt");
      candidate.pieces[0]!.paths = candidate.pieces[0]!.paths.filter(
        (path) => path !== "building.yearBuilt",
      );
    },
    message: /omitted|missing/iu,
  },
  {
    name: "a duplicate path within a piece",
    edit: (candidate) => {
      candidate.pieces[0]!.paths = ["building.address", "building.address"];
    },
    message: /duplicate/iu,
  },
  {
    name: "a duplicate path across pieces",
    edit: (candidate) => {
      candidate.pieces.push({
        name: "duplicate address",
        description: "An invalid second owner.",
        key: "building",
        paths: ["building.address"],
      });
    },
    message: /duplicate/iu,
  },
  {
    name: "a duplicate root path",
    edit: (candidate) => {
      candidate.fieldPaths.push("building.address");
    },
    message: /duplicate/iu,
  },
  {
    name: "an unknown schema field",
    edit: (candidate) => {
      candidate.fieldPaths = candidate.fieldPaths.map((path) =>
        path === "building.yearBuilt" ? "building.unknown" : path,
      );
      candidate.pieces[0]!.paths = candidate.pieces[0]!.paths.map((path) =>
        path === "building.yearBuilt" ? "building.unknown" : path,
      );
    },
    message: /unknown/iu,
  },
  {
    name: "a piece crossing its top-level key",
    edit: (candidate) => {
      candidate.pieces[1]!.key = "building";
    },
    message: /top-level|cross/iu,
  },
  {
    name: "duplicate piece names",
    edit: (candidate) => {
      candidate.pieces[1]!.name = candidate.pieces[0]!.name;
    },
    message: /duplicate.*name|name.*duplicate/iu,
  },
  {
    name: "an empty piece",
    edit: (candidate) => {
      candidate.pieces[0]!.paths = [];
    },
    message: /empty|at least|too_small/iu,
  },
  {
    name: "root and piece membership disagreement",
    edit: (candidate) => {
      candidate.fieldPaths = candidate.fieldPaths.filter((path) => path !== "building.yearBuilt");
    },
    message: /root|fieldPaths|membership/iu,
  },
];

for (const { name, edit, message } of invalidPlans) {
  test(`parseSchemaPlan rejects ${name}`, () => {
    const candidate = plan();
    edit(candidate);
    expect(() => parseSchemaPlan(candidate, extractionSchema)).toThrow(message);
  });
}

test("schema inventory order does not affect identity or mutate the stored order", async () => {
  const original = parseSchemaPlan(plan(), extractionSchema);
  const reordered = parseSchemaPlan(
    { ...plan(), fieldPaths: [...plan().fieldPaths].reverse() },
    extractionSchema,
  );

  expect(await planFingerprint(original)).toBe(await planFingerprint(reordered));
  expect(reordered.fieldPaths).toEqual([...original.fieldPaths].reverse());
  expect(await planFingerprint(original)).toMatch(/^[0-9a-f]{64}$/u);
});

test("stored schema fingerprint and planning provenance do not affect identity", async () => {
  const original = parseSchemaPlan(plan(), extractionSchema);
  const edited = plan();
  edited.schemaFingerprint = "b".repeat(64);
  edited.provenance = {
    model: "another-model",
    backend: "another-backend",
    createdAt: "2027-01-02T03:04:05.000Z",
  };

  expect(await planFingerprint(original)).toBe(await planFingerprint(edited));
});

const identityEdits: ReadonlyArray<{
  readonly name: string;
  readonly edit: (candidate: SchemaPlan) => void;
}> = [
  {
    name: "piece order",
    edit: (candidate) => {
      candidate.pieces.reverse();
    },
  },
  {
    name: "path order within a piece",
    edit: (candidate) => {
      candidate.pieces[0]!.paths.reverse();
    },
  },
  {
    name: "piece name",
    edit: (candidate) => {
      candidate.pieces[0]!.name = "renamed";
    },
  },
  {
    name: "piece description",
    edit: (candidate) => {
      candidate.pieces[0]!.description = "A different semantic description.";
    },
  },
  {
    name: "piece key",
    edit: (candidate) => {
      candidate.pieces[0]!.key = "different";
    },
  },
  {
    name: "piece membership",
    edit: (candidate) => {
      candidate.pieces[0]!.paths = ["building.address"];
      candidate.pieces.push({
        name: "construction year",
        description: "The construction year, planned separately.",
        key: "building",
        paths: ["building.yearBuilt"],
      });
    },
  },
];

for (const { name, edit } of identityEdits) {
  test(`${name} moves the plan fingerprint`, async () => {
    const original = plan();
    const edited = plan();
    edit(edited);

    expect(await planFingerprint(edited)).not.toBe(await planFingerprint(original));
  });
}
