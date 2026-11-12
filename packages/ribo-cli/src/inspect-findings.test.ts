import { assertLeafGranularity, enveloped } from "@azx/ribo-core";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { expect, test } from "vitest";

import { SchemaInspectError, inspectSchema } from "./index.js";
import { collectGranularityViolations } from "./inspect/granularity.js";

/**
 * @file The report's findings: the reformat-description lint, the
 * leaf-granularity violation list (collected through core's own
 * `assertLeafGranularity`, with the agreement test holding the collected list
 * against a whole-schema run of the same assert), the loud draft-2020-12
 * refusal, the not-visible honesty rule, and the canonical fingerprint.
 */

// --- The reformat lint (criterion 3) ----------------------------------------------

const lintDocument = (description: string) => ({
  type: "object",
  properties: {
    audit: {
      type: "object",
      properties: { auditDate: { type: "string", description, nullable: true } },
      required: ["auditDate"],
    },
  },
  required: ["audit"],
});

test("the lint fires on a format-pattern description", () => {
  const report = inspectSchema(lintDocument("The audit date, formatted as YYYY-MM-DD"));
  expect(report.reformatFindings).toEqual([
    {
      path: "audit.auditDate",
      description: "The audit date, formatted as YYYY-MM-DD",
      directive: "YYYY",
    },
  ]);
});

test("the lint stays silent on 'as written' and on plain descriptive text", () => {
  const asWritten = inspectSchema(lintDocument("Use the audit date exactly as written"));
  expect(asWritten.reformatFindings).toEqual([]);
  const plain = inspectSchema(lintDocument("Street address"));
  expect(plain.reformatFindings).toEqual([]);
});

// --- The granularity violations list (criterion 4) ---------------------------------

// The corpus is derived at each provenance granularity through the
// package-internal seam that takes a converted-or-derived zod schema — the one
// internal zod seam the task's invariant licenses. Through the PUBLIC document
// entry, every group reports as apparent granularity "none" (Decision 3).

const leaf = () => z.string().nullable().optional();

const corpus: Record<string, z.ZodType> = {
  leafGranular: enveloped(
    z.object({ hvac: z.object({ fuel: leaf(), notes: leaf() }).strict().optional() }).strict(),
  ),
  rowGroup: enveloped(z.object({ hvac: z.object({ fuel: leaf() }).strict().optional() }).strict(), {
    provenance: { hvac: "row" },
  }),
  noneGroup: enveloped(
    z.object({ hvac: z.object({ fuel: leaf() }).strict().optional() }).strict(),
    { provenance: { hvac: "none" } },
  ),
  mixedOffenders: enveloped(
    z
      .object({
        row: z.object({ fuel: leaf() }).strict().optional(),
        none: z.object({ fuel: leaf() }).strict().optional(),
        good: z.object({ fuel: leaf() }).strict().optional(),
      })
      .strict(),
    { provenance: { row: "row", none: "none" } },
  ),
};

test("the violations list discriminates row from none over the granularity corpus", () => {
  expect(collectGranularityViolations(corpus.leafGranular!)).toEqual([]);
  expect(collectGranularityViolations(corpus.rowGroup!)).toEqual([
    { group: "hvac", granularity: "row" },
  ]);
  expect(collectGranularityViolations(corpus.noneGroup!)).toEqual([
    { group: "hvac", granularity: "none" },
  ]);
  // Every offending group, collected, not first-only.
  expect(collectGranularityViolations(corpus.mixedOffenders!)).toEqual([
    { group: "row", granularity: "row" },
    { group: "none", granularity: "none" },
  ]);
});

test("the CLI's list agrees with what core's assertLeafGranularity refuses", () => {
  for (const [name, schema] of Object.entries(corpus)) {
    const violations = collectGranularityViolations(schema);

    // Every group the CLI names is one the assert throws on: the assert
    // refuses the schema when the list is non-empty, and its first-offender
    // message names a group from the list, with the same granularity.
    if (violations.length > 0) {
      let message = "";
      try {
        assertLeafGranularity(schema, { combinator: "agreement" });
        expect.unreachable(`${name}: the assert accepted a schema the list refuses`);
      } catch (error) {
        message = (error as Error).message;
      }
      const named = violations.some(
        (violation) =>
          message.includes(`"${violation.group}"`) &&
          message.includes(`"${violation.granularity}" provenance granularity`),
      );
      expect(named, `${name}: the assert's first offender must be in the list`).toBe(true);
    } else {
      expect(() => assertLeafGranularity(schema, { combinator: "agreement" })).not.toThrow();
    }

    // Removing every named group leaves a schema the assert accepts.
    const stripped = schema as z.ZodObject;
    const shape: Record<string, z.ZodType> = {};
    for (const [key, property] of Object.entries(stripped.shape)) {
      if (!violations.some((violation) => violation.group === key)) {
        shape[key] = property as z.ZodType;
      }
    }
    expect(
      () => assertLeafGranularity(z.strictObject(shape), { combinator: "agreement" }),
      `${name}: the assert must accept the schema with every named group removed`,
    ).not.toThrow();
  }
});

test("through the public entry every group of a document reports as apparent 'none'", () => {
  const document = {
    type: "object",
    properties: {
      home: {
        type: "object",
        properties: { address: { type: "string", nullable: true } },
        required: ["address"],
      },
      site: {
        type: "object",
        properties: { orientation: { type: "string", nullable: true } },
        required: ["orientation"],
      },
      notes: { type: "string", nullable: true },
    },
    required: ["home", "site", "notes"],
  };
  const report = inspectSchema(document);
  expect(report.granularityViolations).toEqual([
    { group: "home", granularity: "none" },
    { group: "site", granularity: "none" },
    { group: "notes", granularity: "none" },
  ]);
});

// --- The loud draft-2020-12 refusal (criterion 6) -----------------------------------

const draftForm = {
  type: "object",
  properties: {
    atRoot: { anyOf: [{ type: "string" }, { type: "null" }] },
  },
  required: ["atRoot"],
};

const draftFormNested = {
  type: "object",
  properties: {
    home: {
      type: "object",
      properties: {
        underProperties: { anyOf: [{ type: "number" }, { type: "null" }] },
      },
      required: ["underProperties"],
    },
  },
  required: ["home"],
};

test.each([
  ["at the root", draftForm],
  ["nested under properties", draftFormNested],
])(
  "a draft-2020-12-form document (%s) is refused loudly, before any conversion",
  (_label, document) => {
    try {
      inspectSchema(document);
      expect.unreachable("the draft-form document was converted");
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaInspectError);
      const message = (error as Error).message;
      expect(message).toContain("draft-2020-12");
      expect(message).toContain('"nullable": true');
      expect(message).toContain("docs/guide/from-a-schema.md");
      expect(message).toContain("anyOf");
    }
  },
);

test("the refusal message's anchor exists: the docs page shows the export one-liner", () => {
  const guide = readFileSync(
    fileURLToPath(new URL("../../../docs/guide/from-a-schema.md", import.meta.url)),
    "utf8",
  );
  expect(guide).toContain('z.toJSONSchema(schema, { target: "openapi-3.0" })');
});

// --- Not-visible honesty (criterion 7) -----------------------------------------------

const refinedAndTransformed = z.object({
  audit: z
    .object({ auditDate: z.string().refine(() => true) })
    .refine(() => true)
    .transform((value) => value),
});

test("a refinement-and-transform fixture round-trips with both constructs named", () => {
  // `io: "input"` is the rendering that keeps the document convertible AND
  // walkable on the pinned zod: at the output side a transform renders as an
  // unrepresentable `{}` subtree, which the leaf inventory refuses (see the
  // could-not-run pin below). Either way the document cannot carry the
  // constructs — the report names both classes, statically and honestly.
  const document = z.toJSONSchema(refinedAndTransformed, {
    target: "openapi-3.0",
    io: "input",
    unrepresentable: "any",
  });
  const report = inspectSchema(document);
  const constructs = report.notVisible.map((row) => row.construct);
  expect(constructs).toContain("zod refinement");
  expect(constructs).toContain("zod transform");
  for (const row of report.notVisible) {
    expect(row.detail.length).toBeGreaterThan(0);
  }
});

test("an output-side transform rendering is could-not-run, never numbers invented", () => {
  const document = z.toJSONSchema(refinedAndTransformed, {
    target: "openapi-3.0",
    unrepresentable: "any",
  });
  expect(() => inspectSchema(document)).toThrow(SchemaInspectError);
});

// --- The canonical fingerprint (criterion 8) ------------------------------------------

test("reordering keys or reformatting whitespace leaves the fingerprint unchanged", () => {
  const reordered = {
    required: ["home", "notes"],
    properties: {
      notes: { type: "string", description: "Freeform notes", nullable: true },
      home: {
        required: ["address", "yearBuilt"],
        description: "Home",
        properties: {
          yearBuilt: { nullable: true, type: "number", description: "Year built" },
          address: { description: "Street address", type: "string" },
        },
        type: "object",
      },
    },
    type: "object",
    description: "Home overview",
  };
  const report = inspectSchema(groupedDocument);
  const reorderedReport = inspectSchema(reordered);
  expect(reorderedReport.schemaFingerprint).toBe(report.schemaFingerprint);
  expect(report.schemaFingerprint).toMatch(/^[0-9a-f]{64}$/);
});

test("a real schema change alters the fingerprint", () => {
  const report = inspectSchema(groupedDocument);
  const addedLeaf = {
    ...groupedDocument,
    properties: {
      ...groupedDocument.properties,
      extra: { type: "string", nullable: true },
    },
    required: [...groupedDocument.required, "extra"],
  };
  const changedDescription = {
    ...groupedDocument,
    properties: {
      ...groupedDocument.properties,
      notes: { type: "string", description: "Freeform notes, verbatim", nullable: true },
    },
  };
  expect(inspectSchema(addedLeaf).schemaFingerprint).not.toBe(report.schemaFingerprint);
  expect(inspectSchema(changedDescription).schemaFingerprint).not.toBe(report.schemaFingerprint);
});

const groupedDocument = {
  type: "object",
  description: "Home overview",
  properties: {
    home: {
      type: "object",
      description: "Home",
      properties: {
        address: { type: "string", description: "Street address" },
        yearBuilt: { type: "number", description: "Year built", nullable: true },
      },
      required: ["address", "yearBuilt"],
    },
    notes: { type: "string", description: "Freeform notes", nullable: true },
  },
  required: ["home", "notes"],
};
