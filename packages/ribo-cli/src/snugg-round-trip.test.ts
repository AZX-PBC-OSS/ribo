import { snuggExtractionSchema } from "@azx/ribo-adapter-snuggpro";
import { z } from "zod";
import { expect, test } from "vitest";

/**
 * @file The Snugg round-trip guard (design §6). The inspect conversion rests on
 * `z.fromJSONSchema`, and zod's own declaration of that function reads, in the
 * pinned version: "This function should be considered semi-experimental. It's
 * behavior is liable to change." That warning is the entire premise of the
 * guard: the conversion's behaviour may shift under us on a routine catalog
 * bump, and nothing else in the suite would notice until a user schema
 * misreads.
 *
 * The guard is the adapter's real extraction schema rendered with
 * `z.toJSONSchema` at the `openapi-3.0` target, re-read with `z.fromJSONSchema`
 * at `defaultTarget: "openapi-3.0"`, and asserted deep-equal to the original
 * rendering. The assertion is document-level — render, re-read, re-render,
 * compare documents — because zod schema instances carry no stable
 * deep-equality. It runs on every zod bump, which in this repo is always a
 * deliberate one-line catalog change, so the guard has a review to fail in.
 */

test("the Snugg extraction schema round-trips through the openapi-3.0 document form", () => {
  const document = z.toJSONSchema(snuggExtractionSchema, { target: "openapi-3.0" });
  const reRead = z.fromJSONSchema(document, { defaultTarget: "openapi-3.0" });
  const reRendered = z.toJSONSchema(reRead, { target: "openapi-3.0" });
  expect(reRendered).toEqual(document);
});
