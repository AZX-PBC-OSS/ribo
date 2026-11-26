import { expect, test } from "vitest";

import { inspectSchema } from "./index.js";
import { renderHumanReport } from "./render-human.js";

/**
 * @file The human rendering's title line. The renderer pushes an empty spacer
 * after the title, but joins with `""` — the spacer contributes nothing — so
 * the title runs straight into the first labelled line ("schema fingerprint")
 * on one line. The title is a heading: it ends its own line.
 */

test("the title line ends with a line break before the first labelled row", () => {
  const report = inspectSchema({
    type: "object",
    properties: { address: { type: "string", description: "Street address" } },
    required: ["address"],
  });
  const rendered = renderHumanReport(report);

  expect(rendered).toMatch(/^ribo schema inspect — sizing report\n/);
  // The first labelled row starts on its own line, not glued to the title.
  expect(rendered).toContain("\n  schema fingerprint");
});

test("thresholds label rule-based and shared layouts", () => {
  const report = inspectSchema(
    {
      type: "object",
      properties: { address: { type: "string", description: "Street address" } },
      required: ["address"],
    },
    { maxDepth: 50, maxPieceChars: 100_000 },
  );
  const rendered = renderHumanReport(report);

  expect(rendered).toContain("threshold depth (shared)");
  expect(rendered).toContain("threshold pieceChars (rule-based)");
});

test("planned rendering names the exact judged packed call and its semantic layout", () => {
  const base = inspectSchema({
    type: "object",
    properties: { address: { type: "string", description: "Street address" } },
    required: ["address"],
  });
  const rendered = renderHumanReport({
    ...base,
    planFingerprint: "b".repeat(64),
    planned: {
      semanticPieces: [
        {
          name: "Home details",
          key: "home",
          paths: ["home.address"],
          packedCount: 3,
          nullableUnions: 2,
          serializedChars: 500,
          depth: 4,
        },
      ],
      packedCalls: [
        {
          semantic: "Home details",
          key: "home",
          requestName: "ribo-inspect-0-home-1",
          paths: ["home.address"],
          callIndex: 2,
          callCount: 3,
          nullableUnions: 2,
          serializedChars: 180,
          depth: 4,
        },
      ],
      totals: { semanticPieces: 1, packedCalls: 3 },
      notes: [],
    },
    thresholds: [
      {
        measure: "depth",
        layout: "shared",
        limit: 3,
        measured: 4,
        breached: true,
      },
      {
        measure: "pieceChars",
        layout: "planned",
        limit: 100,
        measured: 180,
        breached: true,
        piece: "Home details — call 2 of 3",
      },
    ],
  });

  expect(rendered).toContain("threshold depth (shared)");
  expect(rendered).toContain("threshold pieceChars (planned)");
  expect(rendered).toContain("piece Home details — call 2 of 3");
  expect(rendered).toContain("planned totals");
  expect(rendered).toContain("1 semantic piece(s), 3 packed call(s)");
  expect(rendered).toContain("Home details — call 2 of 3");
  expect(rendered).toContain("ribo-inspect-0-home-1");
});

test("the granularity violations line points at the shipped doc section that explains it", () => {
  const report = inspectSchema({
    type: "object",
    properties: { address: { type: "string", description: "Street address" } },
    required: ["address"],
  });
  const rendered = renderHumanReport(report);

  // Must-fail: a bare count explains nothing to a reader with only the
  // installed package; the line names the shipped page and its anchor.
  expect(rendered).toMatch(
    /granularity violations\s+\d+ — see node_modules\/@azx\/ribo-cli\/docs\/cli\/schema\.md#granularity-violations/u,
  );
});
