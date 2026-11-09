/**
 * The runnable example behind docs/api/provenance.html.
 *
 * Every export is a zero-argument function ending in `node:assert/strict`
 * assertions on exactly what the page prose claims. The runner
 * (`run-examples.test.ts`) executes each export in the Vitest `unit` project,
 * so a source change that breaks what the page says breaks the `test` stage.
 * Runs with no credentials and no network: everything here is a pure zod
 * derivation and pure predicates.
 */

import assert from "node:assert/strict";
import { z } from "zod";
import {
  enveloped,
  groundingCensus,
  isSpanGrounded,
  ROW_SOURCE_SPAN_KEY,
  spanGroundedness,
} from "@azx/ribo-core";

// A patch — open and optional everywhere, because a rejected leaf is absent
// from the patch and a null is a meaningful written value.
const auditPatch = z.object({
  attic: z.object({
    depthInches: z.number().nullable().optional(),
  }),
  rooms: z
    .array(z.object({ label: z.string().nullable().optional() }))
    .nullable()
    .optional(),
});

const TRANSCRIPT = "Attic depth about twelve inches. Bill: $       5,250.00. No rooms mentioned.";

export async function envelopedDerivesTheExtractionSchemaFromThePatch(): Promise<void> {
  // #region usage
  const extractionSchema = enveloped(auditPatch);
  const fields = extractionSchema.parse({
    attic: {
      depthInches: { value: 12, confidence: 0.94, sourceSpan: "about twelve inches" },
    },
    rooms: [{ label: { value: null, confidence: 1, sourceSpan: null } }],
  });
  // #endregion usage

  // Every leaf is an envelope: explicit nulls, never an omitted key.
  assert.equal(fields.attic.depthInches.value, 12);
  assert.equal(fields.attic.depthInches.sourceSpan, "about twelve inches");
  assert.equal(fields.rooms[0]?.label.value, null);
}

export async function granularityPerGroupLeafRowNone(): Promise<void> {
  const rowSchema = enveloped(auditPatch, { provenance: { rooms: "row" } });
  const rowFields = rowSchema.parse({
    attic: {
      depthInches: { value: 12, confidence: 0.94, sourceSpan: "about twelve inches" },
    },
    // One span per row — the row's own `sourceSpan`, appended after its leaves.
    rooms: [{ label: null, sourceSpan: "No rooms mentioned." }],
  });
  assert.equal(rowFields.rooms[0]?.sourceSpan, "No rooms mentioned.");

  const plainSchema = enveloped(auditPatch, { provenance: { attic: "none", rooms: "row" } });
  const plainFields = plainSchema.parse({
    attic: { depthInches: null },
    rooms: [{ label: null, sourceSpan: "No rooms mentioned." }],
  });
  assert.equal(plainFields.attic.depthInches, null);
}

export async function theSpanCheckHasThreeTiers(): Promise<void> {
  // #region usage
  assert.equal(isSpanGrounded("about twelve inches", TRANSCRIPT), true);
  const tier = spanGroundedness("Bill: $ 5,250.00.", TRANSCRIPT);
  // #endregion usage

  assert.equal(tier, "near-miss");
  assert.equal(spanGroundedness("forty inches", TRANSCRIPT), "ungrounded");
  assert.equal(spanGroundedness(null, TRANSCRIPT), "ungrounded");
}

export async function theCensusTalliesCommittedCitedAndGrounded(): Promise<void> {
  const fields = {
    attic: { depthInches: { value: 12, confidence: 0.94, sourceSpan: "about twelve inches" } },
    rooms: [{ label: { value: null, confidence: 1, sourceSpan: null } }],
  };

  const census = groundingCensus(fields, { rooms: "No rooms mentioned." }, TRANSCRIPT);

  assert.equal(census.counts.leaves, 2);
  // The committed, cited leaf; the honest abstention is neither.
  assert.equal(census.counts.committed, 1);
  assert.equal(census.counts.cited, 1);
  assert.equal(census.counts.grounded, 1);
  // An abstention's groundedness is null, never "ungrounded" — the two stay
  // distinguishable.
  const abstention = census.leaves.find((leaf) => leaf.path.join(".") === "rooms.0.label");
  assert.equal(abstention?.committed, false);
  assert.equal(abstention?.groundedness, null);
  // Stated-empty groups are covered too — a fabricated "none of these" quote is
  // exactly the failure a leaf-only census cannot see.
  assert.equal(census.counts.emptyGroups, 1);
  assert.equal(census.emptyGroups[0]?.groundedness, "grounded");
}

// #region defaults
export async function theDefaultsThePageQuotesComeFromTheSource(): Promise<void> {
  // The row-span key is the exported constant, so a source change that moved it
  // fails here; the page quotes the value next to this region.
  assert.equal(ROW_SOURCE_SPAN_KEY, "sourceSpan");

  // The default granularity is "leaf", observed: a group the provenance map
  // omits gets per-leaf envelopes, not plain leaves and not a row span.
  const defaultSchema = enveloped(auditPatch);
  const rooms = (defaultSchema.shape as z.ZodObject["shape"]).rooms as z.ZodArray;
  const leaf = (rooms.element as z.ZodObject).shape.label as z.ZodObject;
  assert.deepEqual(Object.keys(leaf.shape).sort(), ["confidence", "sourceSpan", "value"]);
}
// #endregion defaults
