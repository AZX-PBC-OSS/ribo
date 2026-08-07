import { expect, test } from "vitest";

import type { ExtractionTarget } from "@azx/ribo-core";
import { singleShotExtractor } from "@azx/ribo-extractor-openai";
import type { ChatClient, ChatRequest } from "@azx/ribo-extractor-openai";

import { snuggProAdapter } from "./adapter.js";
import type { SnuggValues } from "./schema.js";
// A plain JSON import (resolveJsonModule, set in @azx/tsconfig/base.json) rather
// than `node:fs` — this package's tsconfig has no Node types (AGENTS.md §4/§6:
// "headless" means no React/DOM rendering, not "no Node", but the package still
// targets the browser lib surface and does not carry `"types": ["node"]`), and a
// JSON import is resolved identically by both `tsc` and Vite/Vitest, with no
// Node-specific API at all.
import fixtureSchema from "./__fixtures__/snugg-fields-json-schema.json" with { type: "json" };

/**
 * Pin the JSON Schema the model is actually asked for.
 *
 * ============================================================================
 * IF THIS TEST FAILS: the derivation changed what is sent to the model. Go fix
 * the derivation. Do NOT regenerate `__fixtures__/snugg-fields-json-schema.json`
 * to make the test pass — that would delete the only evidence this file exists
 * to produce. The fixture is a FROZEN, hand-reviewed artifact, not a snapshot to
 * refresh. Re-capturing it is legitimate only when the FIELD SET itself was
 * deliberately changed, and then the diff must say so.
 * ============================================================================
 *
 * ## Provenance: what this fixture pinned, and what it pins now
 *
 * The original capture was taken BEFORE R1.5 split the old single
 * `SnuggFieldsSchema` into the hand-written writable patch (`snuggValuesSchema`)
 * plus the schema derived from it (`snuggExtractionSchema =
 * enveloped(snuggValuesSchema)`). R1.5 claimed that split changed the types and
 * not the wire artifact, and this file was the evidence: Task 3 moved the types
 * and the test kept passing against an untouched fixture. **That claim was
 * established and is now history.**
 *
 * The fixture was re-captured when `schema.ts` was rebuilt from Snugg Pro's
 * machine-readable spec — new wire field names, the API's literal enum strings,
 * and nesting by resource endpoint. That is a deliberate change to the field set,
 * not a change to the derivation, so the wire artifact moved on purpose and the
 * fixture moved with it. Everything the fixture still guards is unchanged: it is
 * the byte-for-byte record of what leaves for the model, and any *future*
 * unexplained movement is a regression.
 *
 * Why capture it this way, not by calling `z.toJSONSchema(snuggExtractionSchema, ...)`
 * inline: `singleShotExtractor` (packages/ribo-extractor-openai/src/single-shot.ts)
 * is the ONLY code path that produces the object that actually lands in
 * `response_format.json_schema.schema` — today that is exactly
 * `z.toJSONSchema(target.extractionSchema, { target: "draft-2020-12" })` with no
 * post-processing, but re-deriving the call by hand here would silently stop
 * catching it the day someone adds post-processing in single-shot.ts. Running the
 * real extractor against a fake `ChatClient` (network-free, no key) captures
 * whatever single-shot.ts actually builds, whatever that turns out to be.
 *
 * Why a plain committed JSON file instead of `expect(...).toMatchSnapshot()`:
 * Vitest's own snapshot files are one `vitest -u` away from being silently
 * regenerated into agreement with a broken derivation — which is precisely the
 * failure mode this fixture exists to prevent. A file the test only ever READS,
 * with no built-in "accept the new output" command, cannot be updated by
 * accident; changing it requires deliberately editing tracked source and stating
 * why in the diff.
 *
 * Why STRING equality, not `toEqual`: `openai-chat.ts` does
 * `body: JSON.stringify(request)`, so key order is part of the bytes sent over
 * the wire. `toEqual` is a structural/deep-equality match and is blind to key
 * reordering; two objects with the same keys in a different order are `toEqual`
 * but serialize to different strings, which is a different request.
 *
 * The fixture is committed as pretty-printed JSON so a real change shows up as a
 * readable `git diff` — but this repo's format gate (`pnpm format`/`format:check`,
 * AGENTS.md §4) reformats committed JSON on every run (it re-wraps short arrays
 * onto one line), so the fixture's byte layout on disk is NOT stable across a
 * `pnpm format` pass even with nothing semantically changed, and importing it as
 * a JSON module (rather than reading the raw text) sidesteps that entirely: both
 * `actual` and the fixture below are re-serialized with `JSON.stringify` — NO
 * indentation — before comparing as strings. This is still a strict,
 * order-sensitive STRING comparison, not `toEqual`: `JSON.stringify`'s key order
 * depends on each object's own property-insertion order for ordinary string
 * keys, and a JSON importer/parser preserves that order exactly like
 * `JSON.parse` does, so canonicalizing this way changes nothing about what the
 * comparison can detect. (Verified by hand: `pnpm format` reflows this fixture
 * file's arrays onto fewer lines, and the compact re-serialization is
 * byte-identical before and after.)
 *
 * CAVEAT this canonicalization relies on: JS object key order is NOT purely
 * insertion order in general — every object, however constructed, sorts
 * canonical-integer-string keys ("0", "1", "23", ...) ascending and places them
 * BEFORE all other keys, regardless of insertion order (e.g.
 * `JSON.stringify(JSON.parse('{"2":1,"10":2,"1":3,"a":4}'))` →
 * `{"1":3,"2":1,"10":2,"a":4}`). Canonicalizing away whitespace is only safe
 * here because no numeric-looking string is ever an OBJECT KEY anywhere in this
 * schema — the numeric-looking tokens that do appear ("0", "1-3", "0-5", the
 * attic/DHW band values) are only `enum` ARRAY ELEMENTS, and array order is
 * never touched by the integer-key sort rule. If a future field ever introduces
 * an object keyed by a numeric-looking string, this canonicalization would
 * silently stop being order-sensitive for that key — the test would keep
 * passing while no longer detecting a reordering there, exactly the failure
 * mode this fixture exists to catch. Nothing else in this file would flag that;
 * it is a property of the fixture's current shape, not an invariant this test
 * enforces.
 */

// Canonical (compact, no whitespace) form of the fixture — see the comment above
// for why this is still a byte-for-byte, order-sensitive STRING comparison.
const fixtureCanonical = JSON.stringify(fixtureSchema);

/** A ChatClient double that records every request and returns a canned body. */
function fakeChat(): { chat: ChatClient; requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  const chat: ChatClient = {
    complete: (request) => {
      requests.push(request);
      // The body need not satisfy snuggExtractionSchema — we only need the REQUEST,
      // which is captured before the response is parsed. `extract` is allowed to
      // reject afterwards; that rejection is swallowed by the caller below.
      return Promise.resolve({ content: "{}" });
    },
  };
  return { chat, requests };
}

/** Drive the real singleShotExtractor + real adapter wiring, capture the request sent. */
async function captureJsonSchema(): Promise<Record<string, unknown>> {
  const { chat, requests } = fakeChat();
  // `snuggProAdapter` satisfies ExtractionTarget<SnuggValues> structurally (a Pick
  // of name/extractionSchema/instructions/examples) — this is exactly how a real
  // caller composes the extractor (see src/index.ts's closing comment), not a
  // hand-rolled stand-in target. Note the argument is the VALUES type: the target
  // exposes `ZodType<Enveloped<SnuggValues>>`, so both sides name the same `V`.
  const target: ExtractionTarget<SnuggValues> = snuggProAdapter;
  const extractor = singleShotExtractor({ target, chat, model: "gpt-test" });

  try {
    await extractor.extract("A dictated audit transcript, contents irrelevant here.");
  } catch {
    // Expected: the canned "{}" response does not satisfy snuggExtractionSchema. The
    // request was already captured by the fake ChatClient before this throws.
  }

  expect(requests).toHaveLength(1);
  return requests[0]!.response_format.json_schema.schema;
}

/**
 * Recursively assert the structural properties OpenAI strict mode requires, so a
 * differently-derived-but-string-equal schema (or a future edit to this file's
 * fixture) still gets caught even if some day it happens to serialize
 * byte-for-byte to something else entirely: every object is closed, every
 * declared property is required, and no numeric/string constraint keyword sneaks
 * in anywhere in the tree.
 */
function assertStrictModeCompatible(node: unknown, path: string): void {
  if (Array.isArray(node)) {
    node.forEach((child, i) => assertStrictModeCompatible(child, `${path}[${i}]`));
    return;
  }
  if (node === null || typeof node !== "object") return;

  const obj = node as Record<string, unknown>;

  for (const forbidden of ["minimum", "maximum", "pattern"]) {
    expect(Object.hasOwn(obj, forbidden), `${path} must not carry "${forbidden}"`).toBe(false);
  }

  if (obj.type === "object") {
    expect(obj.additionalProperties, `${path}.additionalProperties must be false`).toBe(false);
    const properties = obj.properties as Record<string, unknown> | undefined;
    const required = obj.required as unknown[] | undefined;
    expect(Array.isArray(required), `${path}.required must be an array`).toBe(true);
    const propertyKeys = Object.keys(properties ?? {});
    expect(
      [...(required ?? [])].sort(),
      `${path}: every key in "properties" must appear in "required"`,
    ).toEqual([...propertyKeys].sort());
  }

  for (const [key, value] of Object.entries(obj)) {
    assertStrictModeCompatible(value, `${path}.${key}`);
  }
}

test("the JSON Schema sent to the model matches the frozen fixture, byte for byte", async () => {
  const schema = await captureJsonSchema();
  const actual = JSON.stringify(schema); // canonical (compact) — see file-level comment

  // STRING comparison, not toEqual — see the file-level comment on why, and on
  // why both sides are canonicalized to a compact string before the comparison.
  //
  // A MISMATCH HERE MEANS THE DERIVATION CHANGED WHAT IS SENT TO THE MODEL. Fix
  // the derivation; do not edit `__fixtures__/snugg-fields-json-schema.json` to
  // silence this test.
  expect(actual).toBe(fixtureCanonical);
});

test("the fixture itself is well-formed strict-mode JSON Schema", () => {
  assertStrictModeCompatible(fixtureSchema, "$");
});

test("the live schema is well-formed strict-mode JSON Schema (closed objects, no bare optionals)", async () => {
  const schema = await captureJsonSchema();
  assertStrictModeCompatible(schema, "$");
});

test("the live schema sits inside OpenAI's structured-output limits, with room to grow", async () => {
  // Doc 16 (`docs/implementation/16-extraction-schema-scale.md`) closed whole-spec
  // extraction on exactly these ceilings: 5,000 properties, 1,000 enum values, 10
  // levels of nesting. The bounded field set is meant to sit far inside them, and
  // this asserts the margin rather than assuming it — the field set is expected to
  // grow (doc 17 puts the honest capture surface at ~163 fields against today's 51),
  // and the failure mode of growing past a ceiling is an API rejection at extraction
  // time, on a real recording, in the field.
  const schema = await captureJsonSchema();

  let properties = 0;
  let enumValues = 0;
  let deepest = 0;
  const walk = (node: unknown, depth: number): void => {
    deepest = Math.max(deepest, depth);
    if (Array.isArray(node)) {
      for (const child of node) walk(child, depth);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    if (obj.properties) properties += Object.keys(obj.properties as object).length;
    if (Array.isArray(obj.enum)) enumValues += obj.enum.length;
    for (const [key, child] of Object.entries(obj)) {
      walk(child, key === "properties" ? depth + 1 : depth);
    }
  };
  walk(schema, 0);

  // Pinned as ranges, not exact counts: an exact count would fail on every honest
  // field addition and get bumped without thought, which is how a limit guard stops
  // being one. The lower bounds still catch a derivation that collapsed the tree.
  expect(properties).toBeGreaterThan(200);
  expect(properties).toBeLessThan(5_000);
  expect(enumValues).toBeGreaterThan(200);
  expect(enumValues).toBeLessThan(1_000);
  expect(deepest).toBeLessThan(10);
});
