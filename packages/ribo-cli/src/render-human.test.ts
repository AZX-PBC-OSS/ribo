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
