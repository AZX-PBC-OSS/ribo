import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

import { inspectSchema, loadCorpus } from "./index.js";

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
    "voicemail",
  ]);
  for (const entry of corpus.cases) {
    expect(entry.input.kind).not.toBe("document");
  }

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

test("inspectSchema over the example's schema reports every leaf described", () => {
  const corpus = loadCorpus(EXAMPLE);
  const report = inspectSchema(corpus.schemaDocument);

  expect(report.leafCount).toBe(6);
  expect(report.guidanceCoverage.total).toBe(report.leafCount);
  expect(report.guidanceCoverage.described).toBe(report.guidanceCoverage.total);
  expect(report.guidanceCoverage.ratio).toBe(1);
  expect(report.refusal).toBeUndefined();
});
