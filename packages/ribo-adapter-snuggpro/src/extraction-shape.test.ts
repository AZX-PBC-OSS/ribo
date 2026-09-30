import { expect, test } from "vitest";

import type { ChatClient, ChatRequest, ExtractionTarget } from "@azx/ribo-core";
import { singleShotExtractor, stripJsonSchemaDescriptions } from "@azx/ribo-core";

import { snuggProAdapter } from "./adapter.js";
import type { SnuggValues } from "./schema.js";
// JSON import rather than `node:fs`: this package carries no Node types, and a JSON
// import resolves identically under `tsc` and Vite/Vitest.
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
 * The fixture has been re-captured several times, always for a deliberate FIELD-SET
 * change and never for a derivation change: the spec-derived `schema.ts` rebuild, the
 * move of the per-instance groups to arrays, the basedata capture-surface expansion,
 * the health-endpoint completion, the concern, incentive and stage job-collection
 * tranches, the attic-remainder + vault tranche, the window remainder tranche
 * (doc 20 §5.5's verdicted capture surface — the diff confined to the window group's
 * properties and required list), the hvac remainder tranche (doc 20 §5.4 — the
 * diff confined to the hvac group's properties and required list), the
 * wall-remainder + door tranche (doc 20 §5.5 — the diff confined to the wall group's
 * properties and required list plus the new door group), the dhw remainder
 * tranche (doc 20 §5.4 — the diff confined to the dhw group's properties and
 * required list), the job singleton tranche (doc 20 §5.1's `POST /jobs` +
 * `PUT /jobs/{jobId}` capture surface — the diff confined to the new job group
 * and the top-level required list), the report authored-text tranche (doc 20
 * §5.3 (a1)+(a2) — a new top-level `report` singleton group), the utilities
 * core tranche (doc 20 §5.2 3.1–3.6 — the diff confined to the utilities
 * group's properties and the root required list), and the appliances-and-PV
 * tranche (doc 20 §5.6 — five new top-level groups, `clothesDryer`, `freezer`,
 * `range`, `refrigerator` and `pv`, each an array of per-instance records), and
 * the job update-surface trim (the field set narrowed to the `PUT /jobs/{jobId}`
 * parameter list, job creation being out of scope — the diff confined to the job
 * group's properties and required list), and the two enforced-but-unpublished
 * lists (`hvacDuctLocation` and `wallExteriorWallConstruction` turned from free
 * text into enums — the diff confined to those two leaves).
 * Any *future* unexplained movement is a regression.
 *
 * Why capture via the real extractor, not `z.toJSONSchema(snuggExtractionSchema, ...)`
 * inline: `singleShotExtractor` (`@azx/ribo-core`'s `extraction/single-shot.ts`) is the ONLY
 * code path that produces the object landing in `response_format.json_schema.schema`.
 * Re-deriving that call by hand would silently stop catching it the day single-shot.ts
 * adds post-processing; running the real extractor against a fake `ChatClient`
 * (network-free, no key) captures whatever single-shot.ts actually builds.
 *
 * Why a committed JSON file instead of `expect(...).toMatchSnapshot()`: Vitest
 * snapshots are one `vitest -u` away from being silently regenerated into agreement
 * with a broken derivation — the exact failure mode this fixture exists to prevent. A
 * file the test only ever READS cannot be updated by accident.
 *
 * Why STRING equality, not `toEqual`: `openai-chat.ts` does `body:
 * JSON.stringify(request)`, so key order is part of the bytes on the wire; `toEqual` is
 * blind to reordering. Both sides are re-serialized compactly (`JSON.stringify`, no
 * indentation) before comparing, because the repo's format gate reflows the fixture's
 * on-disk layout without changing its meaning. `JSON.stringify` preserves
 * property-insertion order for ordinary string keys and a JSON import preserves it too,
 * so canonicalizing this way changes nothing the comparison can detect.
 *
 * CAVEAT: JS sorts canonical-integer-string keys ("0", "1", "23", ...) before all
 * others regardless of insertion order. That is safe here only because no
 * numeric-looking string is ever an OBJECT KEY in this schema — such tokens appear
 * only as `enum` ARRAY ELEMENTS, which the sort rule never touches. A future field
 * keyed by a numeric-looking string would silently make this comparison
 * order-insensitive for that key, and nothing else here would flag it.
 */

// Canonical (compact) form of the fixture — still an order-sensitive STRING comparison.
const fixtureCanonical = JSON.stringify(fixtureSchema);

/** A ChatClient double that records every request and returns a canned body. */
function fakeChat(): { chat: ChatClient; requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  const chat: ChatClient = {
    complete: (request) => {
      requests.push(request);
      // The body need not satisfy the schema — we only need the REQUEST, captured
      // before the response is parsed; the later rejection is swallowed below.
      return Promise.resolve({ content: "{}" });
    },
  };
  return { chat, requests };
}

/** Drive the real singleShotExtractor + real adapter wiring, capture the request sent. */
async function captureRequest(fieldDescriptions?: "prompt" | "schema"): Promise<ChatRequest> {
  const { chat, requests } = fakeChat();
  // The real adapter, composed exactly as a real caller would — not a hand-rolled
  // stand-in. The type argument is the VALUES type; the target exposes the enveloped one.
  const target: ExtractionTarget<SnuggValues> = snuggProAdapter;
  const extractor = singleShotExtractor({ target, chat, model: "gpt-test", fieldDescriptions });

  try {
    await extractor.extract({
      text: "A dictated audit transcript, contents irrelevant here.",
      annotations: {},
    });
  } catch {
    // Expected: the canned "{}" response fails the schema; the request was already captured.
  }

  expect(requests).toHaveLength(1);
  return requests[0]!;
}

/**
 * Recursively assert the structural properties OpenAI strict mode requires: every object
 * closed, every declared property required, no numeric/string constraint keyword anywhere.
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

test("the JSON Schema the derivation produces matches the frozen fixture, byte for byte", async () => {
  // Captured in the "schema" mode — descriptions included — because the fixture
  // pins what `enveloped()` DERIVES from the patch, and the descriptions are part
  // of that derivation. The default ("prompt") wire rendering is pinned against
  // this same fixture by the next test.
  const request = await captureRequest();
  const actual = JSON.stringify(request.response_format.json_schema.schema); // canonical (compact) — see file-level comment

  // A MISMATCH HERE MEANS THE DERIVATION CHANGED WHAT IS SENT TO THE MODEL. Fix the
  // derivation; do not edit the fixture to silence this test.
  expect(actual).toBe(fixtureCanonical);
});

test('the "prompt" wire schema is the fixture with field descriptions stripped', async () => {
  // The "prompt" mode strips the descriptions from
  // `response_format` and carries the same text in the system message instead —
  // the guidance moves budgets, it does not disappear. The wire bytes are the
  // frozen fixture through `stripJsonSchemaDescriptions`, so this pin cannot
  // drift from the derivation pin above.
  const request = await captureRequest("prompt");
  expect(JSON.stringify(request.response_format.json_schema.schema)).toBe(
    JSON.stringify(stripJsonSchemaDescriptions(fixtureSchema)),
  );
});

test("the fixture itself is well-formed strict-mode JSON Schema", () => {
  assertStrictModeCompatible(fixtureSchema, "$");
});

test("the live schema is well-formed strict-mode JSON Schema (closed objects, no bare optionals)", async () => {
  const schema = (await captureRequest()).response_format.json_schema.schema;
  assertStrictModeCompatible(schema, "$");
});

test("the live schema sits inside OpenAI's structured-output limits, with room to grow", async () => {
  // Doc 16 (`docs/implementation/16-extraction-schema-scale.md`) closed whole-spec
  // extraction on OpenAI's structured-output ceilings (properties, enum values, nesting
  // depth). This asserts the margin rather than assuming it — the field set has grown
  // several times, and growing past a ceiling fails as an API rejection at extraction
  // time, on a real recording, in the field.
  const schema = (await captureRequest()).response_format.json_schema.schema;

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
    if (obj.properties) properties += Object.keys(obj.properties).length;
    if (Array.isArray(obj.enum)) enumValues += obj.enum.length;
    for (const [key, child] of Object.entries(obj)) {
      walk(child, key === "properties" ? depth + 1 : depth);
    }
  };
  walk(schema, 0);

  // Pinned as ranges, not exact counts: an exact count would fail on every honest field
  // addition and get bumped without thought. The lower bounds still catch a derivation
  // that collapsed the tree.
  expect(properties).toBeGreaterThan(200);
  expect(properties).toBeLessThan(5_000);
  expect(enumValues).toBeGreaterThan(200);
  expect(enumValues).toBeLessThan(1_000);
  expect(deepest).toBeLessThan(10);
});

/**
 * Walk the emitted JSON Schema and return every leaf's description, keyed by dotted path.
 *
 * Reads the SCHEMA, not the zod object: a description only matters if it lands in the bytes
 * the model receives. A `.describe()` on the `.nullable().optional()` wrapper used to be
 * discarded on the way through — a zod-side assertion would not have caught that.
 */
function collectLeafDescriptions(schema: Record<string, unknown>): Map<string, string> {
  const found = new Map<string, string>();
  const groups = schema.properties as Record<
    string,
    {
      type?: string;
      items?: { properties: Record<string, unknown> };
      properties?: Record<string, unknown>;
    }
  >;
  for (const [group, groupSchema] of Object.entries(groups)) {
    // Collection groups are arrays; the per-leaf schema is under `items.properties`.
    const leafContainer = groupSchema.type === "array" ? groupSchema.items : groupSchema;
    if (!leafContainer?.properties) continue;
    for (const [leaf, leafSchema] of Object.entries(leafContainer.properties)) {
      const value = (
        leafSchema as { properties: { value: { anyOf?: { description?: string }[] } } }
      ).properties.value;
      found.set(`${group}.${leaf}`, value.anyOf?.[0]?.description ?? "");
    }
  }
  return found;
}

test("every leaf reaches the model with the vendor's description and our prohibition", async () => {
  const descs = collectLeafDescriptions(
    (await captureRequest()).response_format.json_schema.schema,
  );

  // Every leaf, not a subset: the vendor supplies authoritative text for each (or our own
  // note stands in where the vendor publishes none or junk), so none is deliberately bare.
  expect(descs.size).toBe(441);
  expect([...descs.values()].filter((d) => d.length > 0)).toHaveLength(441);

  // The VENDOR half is really there: without this, a generated module that failed to
  // import — or regenerated to an empty map — would still pass a bare "is it described?"
  // check on our own notes alone.
  const blower = descs.get("basedata.blowerDoorReading") ?? "";
  expect(blower).toContain("cubic feet per minute");
  expect(blower).toContain("50 Pascals");

  // OUR half survives being composed around: a description that lost its prohibition is
  // worse than a missing one — it looks informative while omitting the hazard.
  expect(descs.get("hvac.hvacSystemEquipmentType") ?? "").toContain("never a fused token");
  expect(blower).toContain("Never ACH50");

  // Order matters: the vendor definition orients the model before our prohibition
  // constrains it; reversed, the prohibition reads as a correction rather than a rule.
  expect(blower.indexOf("cubic feet per minute")).toBeLessThan(blower.indexOf("Never ACH50"));
});

test('under "prompt", every leaf description moves from the wire schema into the system message', async () => {
  const request = await captureRequest("prompt");
  const system = request.messages[0]!;
  expect(system.role).toBe("system");
  expect(system.content).toContain("### Field guidance");
  const wire = collectLeafDescriptions(request.response_format.json_schema.schema);
  expect(wire.size).toBe(441);
  expect([...wire.values()].filter((d) => d.length > 0)).toHaveLength(0);

  const descs = collectLeafDescriptions(fixtureSchema);
  expect(descs.size).toBe(441);
  for (const [path, description] of descs) {
    expect(system.content.includes(description), `the guidance must carry ${path}'s`).toBe(true);
  }
});
