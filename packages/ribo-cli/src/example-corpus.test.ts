import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseSchemaPlan, planFingerprint } from "@azx/ribo-core";
import { expect, test } from "vitest";

import { inspectSchema, loadCorpus, resolveExpectation } from "./index.js";
import { inspectSchemaWithPlan } from "./inspect-schema.js";
import { convertDocument } from "./inspect/convert.js";

/**
 * @file The committed worked example the README and the docs site's CLI
 * section walk through, held to the loader and the inspector it teaches:
 * the corpus loads with no error, and its schema inspects with every leaf
 * described — the example's guidance coverage is the property the docs
 * claim, so it is pinned here rather than restated in prose.
 *
 * Nothing here makes a model call; the eval-over-the-example suite lives in
 * `bin-example-eval.test.ts`.
 */

const EXAMPLE = fileURLToPath(new URL("../examples/basic-corpus", import.meta.url));

test("the worked example corpus loads through loadCorpus with no error", () => {
  const corpus = loadCorpus(EXAMPLE);

  expect(corpus.manifest.name).toBe("energy-visit-notes");
  expect(corpus.cases.map((entry) => entry.id)).toEqual([
    "follow-up-letter",
    "morning-visit",
    "service-sheet",
    "voicemail",
  ]);

  // The features the docs name are really in it: one group (more, in fact),
  // one collection leaf, one enum leaf, one nullable-by-omission leaf, one
  // asserted expectation with alternatives, and one declared-absent
  // expectation carrying a source span.
  expect(corpus.groupKeys).toContain("upgrades");
  expect(corpus.leafInventory.some((leaf) => leaf.inArray)).toBe(true);
  expect(corpus.leafInventory.some((leaf) => leaf.kind === "enum")).toBe(true);
  const morning = corpus.cases.find((entry) => entry.id === "morning-visit")!;
  expect(
    Object.values(morning.expected).some(
      (expectation) =>
        expectation.status === "asserted" && (expectation.alternatives?.length ?? 0) > 0,
    ),
  ).toBe(true);
  const absent = morning.expected["heating.servicedAt"];
  expect(absent?.status).toBe("declared-absent");
  expect(absent?.sourceSpan).not.toBeUndefined();
});

test("the worked example covers a document case: it loads with its capture block and its expectations", () => {
  const corpus = loadCorpus(EXAMPLE);
  const sheet = corpus.cases.find((entry) => entry.id === "service-sheet");

  // Must-fail: without the document input this find comes back undefined.
  expect(sheet?.inputs).toHaveLength(2);
  const [pdf, note] = sheet?.inputs ?? [];
  if (pdf?.kind !== "document") throw new Error("service-sheet's first input is not a document");

  // The capture block the case declares, assembled into core's capture
  // record beside the PDF's bytes.
  expect(pdf.file).toBe("input.pdf");
  expect(pdf.capture.capturedAt).toBe("2026-02-11T08:15:00Z");
  expect(pdf.capture.pageCount).toBe(1);
  expect(pdf.bytes.byteLength).toBeGreaterThan(0);

  // The second input: a text note, read after the PDF in list order.
  expect(note?.kind).toBe("text");
  if (note?.kind !== "text") throw new Error("service-sheet's second input is not a text input");
  expect(note.file).toBe("site-note.txt");
  expect(note.text).toBe("No additional observations.\n");
  if (sheet === undefined) throw new Error("service-sheet did not load");

  // The sheet says nothing the schema asks about, so the case declares the
  // leaves absent: `heating.servicedAt` explicitly, the rest through the
  // "*" default.
  expect(resolveExpectation(sheet, "heating.servicedAt")).toMatchObject({
    status: "declared-absent",
    origin: "explicit",
  });
  expect(resolveExpectation(sheet, "home.address")).toMatchObject({
    status: "declared-absent",
    origin: "default",
  });
  expect(resolveExpectation(sheet, "upgrades.measure")).toMatchObject({
    status: "declared-absent",
    origin: "default",
  });
});

test("inspectSchema over the example's schema reports every leaf described", () => {
  const corpus = loadCorpus(EXAMPLE);
  const report = inspectSchema(corpus.schemaDocument);

  expect(report.leafCount).toBe(6);
  expect(report.guidanceCoverage.total).toBe(report.leafCount);
  expect(report.guidanceCoverage.described).toBe(report.guidanceCoverage.total);
  expect(report.guidanceCoverage.ratio).toBe(1);
  expect(report.refusal).toBeUndefined();
});

test("the committed example plan exactly covers its schema and produces a planned report", async () => {
  const corpus = loadCorpus(EXAMPLE);
  const value = JSON.parse(readFileSync(join(EXAMPLE, "plan.json"), "utf8")) as unknown;
  const plan = parseSchemaPlan(value, convertDocument(corpus.schemaDocument));

  expect(plan.fieldPaths).toEqual(corpus.leafInventory.map((leaf) => leaf.path));
  const report = await inspectSchemaWithPlan(corpus.schemaDocument, { plan });
  expect(report.planFingerprint).toBe(await planFingerprint(plan));
  expect(report.planned?.semanticPieces.map((piece) => piece.name)).toEqual(
    plan.pieces.map((piece) => piece.name),
  );
  expect(report.planned?.packedCalls.flatMap((call) => call.paths).sort()).toEqual(
    [...plan.fieldPaths].sort(),
  );
  expect(report.refusal).toBeUndefined();
});
