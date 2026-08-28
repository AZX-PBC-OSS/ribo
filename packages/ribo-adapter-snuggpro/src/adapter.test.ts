import { isSpanGrounded, stripOptionalNullable } from "@azx/ribo-core";
import type { ExistingRecord } from "@azx/ribo-core";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { rankCandidates, SNUGGPRO_ADAPTER_NAME, snuggProAdapter } from "./adapter.js";
import type { SnuggWriteContext } from "./context.js";
import { snuggValuesSchema } from "./schema.js";
import type { SnuggValues } from "./schema.js";

test("carries a stable name, instructions and a parsing schema", () => {
  expect(snuggProAdapter.name).toBe(SNUGGPRO_ADAPTER_NAME);
  expect(snuggProAdapter.name).toBe("snuggpro-bounded");
  // The instructions carry the normalization intent, not just a field list.
  expect(snuggProAdapter.instructions).toContain("energy auditor");
  expect(snuggProAdapter.instructions).toContain("SEPARATE axis");
});

// The adapter's own few-shot example, resolved ONCE and non-optionally. Written
// this way rather than as `examples?.[0]` at each use because the assertions below
// are negative ones: `safeParse(undefined).success` is also `false`, so an
// `examples` that went missing would leave them passing while asserting nothing.
// Throwing at module scope fails the whole file loudly instead.
const example = snuggProAdapter.examples?.[0];
if (!example) throw new Error("expected the Snugg Pro adapter to carry a few-shot example");

/** Collect the leaf names inside one group's schema, recursing into arrays and nested objects. */
function leafNames(schema: z.ZodType): string[] {
  const stripped = stripOptionalNullable(schema);
  if (stripped instanceof z.ZodArray) {
    return leafNames(stripped.element as z.ZodType);
  }
  if (stripped instanceof z.ZodObject) {
    const names: string[] = [];
    for (const [key, child] of Object.entries(stripped.shape)) {
      const childNames = leafNames(child);
      if (childNames.length === 0) {
        names.push(key);
      } else {
        for (const leaf of childNames) {
          names.push(`${key}.${leaf}`);
        }
      }
    }
    return names;
  }
  return [];
}

/** Map each top-level group of `snuggValuesSchema` to the leaf names declared inside it. */
function groupLeafNames(schema: z.ZodType): Record<string, string[]> {
  const stripped = stripOptionalNullable(schema);
  if (!(stripped instanceof z.ZodObject)) return {};
  const result: Record<string, string[]> = {};
  for (const [key, child] of Object.entries(stripped.shape)) {
    result[key] = leafNames(child);
  }
  return result;
}

test("the EXTRACTION schema parses the adapter's own few-shot examples", () => {
  // A few-shot example's `fields` become the ASSISTANT turn the model imitates,
  // so they are the enveloped shape and it is `extractionSchema` — not `schema` —
  // that must accept them. This assertion moved rather than weakened: before the
  // split there was one schema and it was the enveloped one.
  expect(() => snuggProAdapter.extractionSchema.parse(example.fields)).not.toThrow();
});

test("the PATCH schema rejects those same examples — the two schemas are not interchangeable", () => {
  // What keeps the assertion above from being satisfied by an adapter that simply
  // pointed `extractionSchema` back at `schema`: the patch is plain values and a
  // model response is envelopes, so exactly one of the two can parse this.
  expect(snuggProAdapter.schema.safeParse(example.fields).success).toBe(false);
});

test("every example sourceSpan is verbatim in its transcript (grounding holds)", () => {
  // Pinned non-empty: an empty `examples` would make the loop below a no-op and
  // this test green without checking a single span.
  expect(snuggProAdapter.examples ?? []).not.toHaveLength(0);
  for (const example of snuggProAdapter.examples ?? []) {
    // Recurses, because the field set nests by resource group now. Counting the
    // envelopes it reaches is the guard against the recursion silently bottoming
    // out at the seven group objects and checking nothing.
    let checked = 0;
    const walk = (node: unknown): void => {
      if (typeof node !== "object" || node === null) return;
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }
      if ("sourceSpan" in node) {
        const { sourceSpan } = node as { sourceSpan: string | null };
        checked += 1;
        if (sourceSpan !== null) {
          expect(isSpanGrounded(sourceSpan, example.transcript)).toBe(true);
        }
        return;
      }
      for (const child of Object.values(node)) walk(child);
    };
    walk(example.fields);
    expect(checked).toBe(51);
  }
});

// --- The context schema -----------------------------------------------------
// `ctxSchema` is new in R1.5: `Recording.ctx` comes back out of IndexedDB, so the
// DESTINATION of a write crosses a trust boundary and a type alone cannot parse
// it. These pin that the adapter declares a real parser, not a rubber stamp.

const validCtx = {
  assessmentId: "assessment-1",
  companyId: "company-1",
  apiBaseUrl: "https://api.snuggpro.com",
};

test("ctxSchema parses a well-formed write context", () => {
  expect(snuggProAdapter.ctxSchema.parse(validCtx)).toEqual(validCtx);
});

test("ctxSchema rejects a context that would target nowhere", () => {
  // Each of these would otherwise sail through as a string and produce a write
  // aimed at the collection, at no tenant, or at a URL built by concatenation.
  expect(snuggProAdapter.ctxSchema.safeParse({ ...validCtx, assessmentId: "" }).success).toBe(
    false,
  );
  expect(snuggProAdapter.ctxSchema.safeParse({ ...validCtx, companyId: "" }).success).toBe(false);
  expect(
    snuggProAdapter.ctxSchema.safeParse({ ...validCtx, apiBaseUrl: "api.snuggpro.com" }).success,
  ).toBe(false);
  expect(snuggProAdapter.ctxSchema.safeParse({ assessmentId: "a-1" }).success).toBe(false);
});

test("ctxSchema tolerates host extras — a Recording.ctx may carry more than this adapter needs", () => {
  // Deliberately not `.strict()`: a host owns `Recording.ctx` and may keep its own
  // job metadata in it. Zod strips the extras rather than failing the write.
  const parsed = snuggProAdapter.ctxSchema.parse({ ...validCtx, hostBookkeeping: { seen: true } });
  expect(parsed).toEqual(validCtx);
});

test("write is scaffolded, not faked: it rejects rather than silently succeeding", async () => {
  // `write` takes the PATCH now, not the enveloped example — a rejected leaf is
  // absent, an accepted null is present.
  const fields: SnuggValues = {
    hvac: [{ hvacSystemEquipmentType: "Boiler", hvacHeatingEnergySource: null }],
  };
  const ctx = snuggProAdapter.ctxSchema.parse(validCtx);
  await expect(snuggProAdapter.write(fields, ctx, { idempotencyKey: "write-1" })).rejects.toThrow(
    /Task 6|not implemented/,
  );
});

// --- Type-level checks (enforced by tsc, not the Vitest run) ----------------
// The adapter's `C` is a real `SnuggWriteContext`, never `unknown`. These pin
// that: a foreign ctx and a missing ctx must both fail to compile. If `C` were
// loosened to `unknown` the expected errors vanish and this file stops compiling.
// Each call supplies a VALID `meta`, so the only thing wrong with it is the thing
// the directive names — an error from a missing third argument would satisfy
// `@ts-expect-error` just as well and quietly stop testing `C` at all.
async function _ctxIsReal(fields: SnuggValues): Promise<void> {
  const meta = { idempotencyKey: "write-1" };

  // @ts-expect-error - ctx must be a SnuggWriteContext; a foreign shape is rejected.
  await snuggProAdapter.write(fields, { jobId: "job-7" }, meta);

  // @ts-expect-error - ctx is required and typed: `undefined` is not a
  // SnuggWriteContext. Written with all three arguments PRESENT on purpose —
  // `write(fields)` would also error, but as `TS2554: Expected 3 arguments, but
  // got 1`, which says nothing about `C` and would keep this directive satisfied
  // even if `C` were loosened to `unknown`.
  await snuggProAdapter.write(fields, undefined, meta);
}

/**
 * `SnuggWriteContext` is `readonly`, and nothing else can pin that: TypeScript's
 * `extends` relation ignores the modifier entirely, so no assignability check sees
 * it. Same reason `enveloped.test.ts` carries a narrow reassignment probe for
 * `Enveloped<V>` — a write's destination should not be mutable in place.
 */
function _ctxIsReadonly(ctx: SnuggWriteContext): void {
  // @ts-expect-error - assessmentId is readonly; a caller cannot retarget the write.
  ctx.assessmentId = "somewhere-else";
}

test("every requiredOnCreate group and leaf is declared in the values schema", () => {
  // The drift guard, and the reason a parallel declaration is acceptable at all
  // rather than metadata on the schema. A typo in a group, a renamed field, or a leaf
  // moved to another group must fail HERE, loudly, instead of silently marking nothing
  // required and letting a write die at the host that evening. Walking the values
  // schema directly rather than through `buildReviewRequest` keeps the test independent
  // of the per-instance path logic it exists to pin.
  const groupLeaves = groupLeafNames(snuggValuesSchema);
  for (const [group, leaves] of Object.entries(snuggProAdapter.requiredOnCreate ?? {})) {
    const available = groupLeaves[group];
    expect(available, `group "${group}" is not in the values schema`).toBeDefined();
    for (const leaf of leaves) {
      expect(available, `leaf "${leaf}" not in group "${group}"`).toContain(leaf);
    }
  }
});

test("the required leaves are exactly HVAC's two, declared per group", () => {
  // Snugg Pro's ONLY component endpoint with required capture fields is
  // POST /jobs/{jobId}/hvac, and it wants two. Both are extracted now, so a third
  // leaf here — or a leaf from any other group — means someone read the spec's
  // `required` flags wrong.
  expect(snuggProAdapter.requiredOnCreate).toEqual({
    hvac: ["hvacSystemEquipmentType", "hvacUpgradeAction"],
  });
});

test("no other group declares a required leaf — a partial dictation writes cleanly", () => {
  // The claim that makes review-time requiredness cheap: every other endpoint
  // (basedata, attic, wall, window, dhw, health) accepts a create with nothing set,
  // so an auditor who only did the basement is never blocked on the attic.
  const groups = Object.keys(snuggProAdapter.requiredOnCreate ?? {});
  expect(groups.filter((g) => g !== "hvac")).toEqual([]);
});

describe("rankCandidates — contradiction check orders existing records", () => {
  const existing: ExistingRecord[] = [
    {
      uuid: "a",
      fields: { hvacSystemEquipmentType: "Boiler", hvacHeatingSystemManufacturer: "Burnham" },
    },
    {
      uuid: "b",
      fields: { hvacSystemEquipmentType: "Furnace", hvacHeatingSystemManufacturer: "Carrier" },
    },
    {
      uuid: "c",
      fields: { hvacSystemEquipmentType: "Boiler", hvacHeatingSystemManufacturer: "Burnham" },
    },
  ];

  test("a perfect match does not auto-link — it only ranks first", () => {
    // The single existing record matches the dictated instance on every identifying field.
    // The ranking must still produce a create default; the first candidate is just pre-highlighted.
    const instance = {
      hvacSystemEquipmentType: "Boiler",
      hvacHeatingSystemManufacturer: "Burnham",
    };
    const ranked = rankCandidates("hvac", instance, [existing[0]!]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]).toMatchObject({ uuid: "a", contradicts: false });
  });

  test("a contradicting field demotes a candidate in the ordering", () => {
    // The dictated instance is a Burnham boiler. Record b is a Carrier furnace, so it contradicts
    // on both identifying fields and must appear after the non-contradicting candidates.
    const instance = {
      hvacSystemEquipmentType: "Boiler",
      hvacHeatingSystemManufacturer: "Burnham",
    };
    const ranked = rankCandidates("hvac", instance, existing);
    expect(ranked.map((c) => c.uuid)).toEqual(["a", "c", "b"]);
    expect(ranked[0]?.contradicts).toBe(false);
    expect(ranked[1]?.contradicts).toBe(false);
    expect(ranked[2]?.contradicts).toBe(true);
  });

  test("a missing identifying field on one side does not count as a contradiction", () => {
    // The dictated instance matches both records on type. One record has no manufacturer and the
    // other has a different one; because the instance does not state a manufacturer, neither
    // side has a captured value there and no contradiction can be claimed.
    const instance = { hvacSystemEquipmentType: "Boiler" };
    const partialExisting: ExistingRecord[] = [
      {
        uuid: "a",
        fields: { hvacSystemEquipmentType: "Boiler", hvacHeatingSystemManufacturer: "Burnham" },
      },
      { uuid: "b", fields: { hvacSystemEquipmentType: "Boiler" } },
    ];
    const ranked = rankCandidates("hvac", instance, partialExisting);
    expect(ranked.map((c) => c.uuid)).toEqual(["a", "b"]);
    expect(ranked.every((c) => !c.contradicts)).toBe(true);
  });

  test("a group with no identifying fields leaves every record non-contradicted", () => {
    // Attic has no identifying-field declaration, so nothing can contradict it. The order is
    // preserved exactly as the host returned it.
    const atticExisting: ExistingRecord[] = [
      { uuid: "attic-1", fields: { atticInsulation: 30 } },
      { uuid: "attic-2", fields: { atticInsulation: 19 } },
    ];
    const ranked = rankCandidates("attic", { atticInsulation: 19 }, atticExisting);
    expect(ranked.map((c) => c.uuid)).toEqual(["attic-1", "attic-2"]);
    expect(ranked.every((c) => !c.contradicts)).toBe(true);
  });
});
