/**
 * The runnable example behind docs/api/snuggpro-adapter.html.
 *
 * Every export is a zero-argument function ending in `node:assert/strict`
 * assertions on exactly what the page prose claims. The runner
 * (`run-examples.test.ts`) executes each export in the Vitest `unit` project,
 * so a source change that breaks what the page says breaks the `test` stage.
 * Runs with no credentials and no network — and no Snugg Pro credential: the
 * published adapter's write rejects naming the factory as the fix.
 */

import assert from "node:assert/strict";
import type { z } from "zod";
import {
  createSnuggProAdapter,
  SNUGGPRO_ADAPTER_NAME,
  snuggExtractionSchema,
  snuggProAdapter,
  snuggValuesSchema,
} from "@azx/ribo-adapter-snuggpro";

export async function thePublishedAdapterIsTheFactoryCalledWithNoTransport(): Promise<void> {
  // #region usage
  const adapter = snuggProAdapter;
  // #endregion usage

  // The name is the exported constant, so a source change that moved it fails
  // here; the page quotes the value next to this region.
  assert.equal(adapter.name, SNUGGPRO_ADAPTER_NAME);
  assert.equal(SNUGGPRO_ADAPTER_NAME, "snuggpro-bounded");
  // Everything but `write` works off the published adapter.
  assert.equal(adapter.schema, snuggValuesSchema);
  assert.equal(adapter.extractionSchema, snuggExtractionSchema);
}

export async function theWriteRejectsNamingTheFactoryAsTheFix(): Promise<void> {
  await assert.rejects(
    snuggProAdapter.write({}, {} as never, { idempotencyKey: "idem-1" }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      // The message names the fix: build with the host's transport.
      assert.match(error.message, /createSnuggProAdapter\(\{ fetchImpl \}\)/);
      return true;
    },
  );

  // The factory's product is the same adapter with a real write over the
  // supplied transport. Never called with a credential here — the transport is
  // the host's, and the example asserts wiring, not egress.
  const wired = createSnuggProAdapter({
    fetchImpl: () => Promise.reject(new Error("unreachable")),
  });
  assert.equal(wired.name, SNUGGPRO_ADAPTER_NAME);
}

export async function thePatchIsAllOptionalAndTheExtractionSchemaIsEnveloped(): Promise<void> {
  // The patch tolerates an empty submission — every leaf optional, every group
  // absent-able.
  assert.equal(snuggValuesSchema.safeParse({}).success, true);

  // The extraction schema is DERIVED from the patch with `enveloped()`: same
  // groups, every leaf a `{ value, confidence, sourceSpan }` envelope.
  const hvac = snuggExtractionSchema.shape.hvac as z.ZodArray;
  const leaf = (hvac.element as z.ZodObject).shape.hvacSystemEquipmentType as z.ZodObject;
  assert.deepEqual(Object.keys(leaf.shape).sort(), ["confidence", "sourceSpan", "value"]);
}

// #region defaults
export async function theDefaultsThePageQuotesComeFromTheSource(): Promise<void> {
  // The adapter name is the exported constant, so a source change that moved
  // it fails here; the page quotes the value next to this region.
  assert.equal(SNUGGPRO_ADAPTER_NAME, "snuggpro-bounded");
}
// #endregion defaults
