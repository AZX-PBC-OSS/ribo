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

// Resolved ONCE and non-optionally: the assertions below are negative ones, and
// `safeParse(undefined)` also fails — a missing `examples` would leave them passing while
// asserting nothing. Throwing at module scope fails the whole file loudly instead.
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
  // A few-shot example's `fields` become the ASSISTANT turn the model imitates, so they
  // are the enveloped shape and it is `extractionSchema` — not `schema` — that must
  // accept them.
  expect(() => snuggProAdapter.extractionSchema.parse(example.fields)).not.toThrow();
});

test("the PATCH schema rejects those same examples — the two schemas are not interchangeable", () => {
  // Keeps the assertion above honest: the patch is plain values and a model response is
  // envelopes, so exactly one of the two can parse this.
  expect(snuggProAdapter.schema.safeParse(example.fields).success).toBe(false);
});

test("every example sourceSpan is verbatim in its transcript (grounding holds)", () => {
  // Pinned non-empty: an empty `examples` would make the loop below a no-op and this
  // test green without checking a single span.
  expect(snuggProAdapter.examples ?? []).not.toHaveLength(0);
  for (const example of snuggProAdapter.examples ?? []) {
    // Recurses, because the field set nests by resource group. Counting the envelopes
    // reached guards against the recursion silently bottoming out at the group objects
    // and checking nothing. The count exceeds the schema's leaf count because the
    // fixture carries two hvac instances and no concern/incentive/vault/door instances.
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
    expect(checked).toBe(415);
  }
});

// --- The context schema -----------------------------------------------------
// `Recording.ctx` comes back out of IndexedDB, so the DESTINATION of a write crosses a
// trust boundary and a type alone cannot parse it. These pin a real parser, not a
// rubber stamp.

const validCtx = {
  assessmentId: "assessment-1",
  companyId: "company-1",
  apiBaseUrl: "https://api.snuggpro.com",
};

test("ctxSchema parses a well-formed write context", () => {
  expect(snuggProAdapter.ctxSchema.parse(validCtx)).toEqual(validCtx);
});

test("ctxSchema rejects a context that would target nowhere", () => {
  // Each would otherwise sail through as a string and produce a write aimed at the
  // collection, at no tenant, or at a URL built by concatenation.
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
  // metadata in it. Zod strips extras rather than failing the write.
  const parsed = snuggProAdapter.ctxSchema.parse({ ...validCtx, hostBookkeeping: { seen: true } });
  expect(parsed).toEqual(validCtx);
});

test("write is scaffolded, not faked: it rejects rather than silently succeeding", async () => {
  // `write` takes the PATCH: a rejected leaf is absent, an accepted null is present.
  const fields: SnuggValues = {
    hvac: [{ hvacSystemEquipmentType: "Boiler", hvacHeatingEnergySource: null }],
  };
  const ctx = snuggProAdapter.ctxSchema.parse(validCtx);
  await expect(snuggProAdapter.write(fields, ctx, { idempotencyKey: "write-1" })).rejects.toThrow(
    /Task 6|not implemented/,
  );
});

// --- Type-level checks (enforced by tsc, not the Vitest run) ----------------
// The adapter's `C` is a real `SnuggWriteContext`, never `unknown`: a foreign ctx and a
// missing ctx must both fail to compile. Each call supplies a VALID `meta`, so the only
// thing wrong with it is the thing the directive names — an error from a missing third
// argument would satisfy `@ts-expect-error` just as well and stop testing `C` at all.
async function _ctxIsReal(fields: SnuggValues): Promise<void> {
  const meta = { idempotencyKey: "write-1" };

  // @ts-expect-error - ctx must be a SnuggWriteContext; a foreign shape is rejected.
  await snuggProAdapter.write(fields, { jobId: "job-7" }, meta);

  // @ts-expect-error - ctx is required and typed: `undefined` is not a
  // SnuggWriteContext. All three arguments PRESENT on purpose — `write(fields)` would
  // also error, but as TS2554 (argument count), which says nothing about `C` and would
  // keep this directive satisfied even if `C` were loosened to `unknown`.
  await snuggProAdapter.write(fields, undefined, meta);
}

/**
 * `SnuggWriteContext` is `readonly`, and nothing else can pin that: TypeScript's
 * `extends` relation ignores the modifier, so no assignability check sees it. A write's
 * destination should not be mutable in place.
 */
function _ctxIsReadonly(ctx: SnuggWriteContext): void {
  // @ts-expect-error - assessmentId is readonly; a caller cannot retarget the write.
  ctx.assessmentId = "somewhere-else";
}

test("every requiredOnCreate group and leaf is declared in the values schema", () => {
  // The drift guard that makes a parallel declaration acceptable: a typo'd group, a
  // renamed field, or a leaf moved to another group must fail HERE, loudly, instead of
  // silently marking nothing required and letting a write die at the host that evening.
  // Walking the values schema directly keeps this independent of the per-instance path
  // logic it exists to pin.
  const groupLeaves = groupLeafNames(snuggValuesSchema);
  for (const [group, leaves] of Object.entries(snuggProAdapter.requiredOnCreate ?? {})) {
    const available = groupLeaves[group];
    expect(available, `group "${group}" is not in the values schema`).toBeDefined();
    for (const leaf of leaves) {
      expect(available, `leaf "${leaf}" not in group "${group}"`).toContain(leaf);
    }
  }
});

test("the required leaves are exactly hvac's and job's, declared per group", () => {
  // POST /jobs/{jobId}/hvac is Snugg Pro's only COMPONENT endpoint with required capture
  // fields, and POST /jobs is the one singleton that genuinely refuses a create without
  // its required leaves (doc 20 §4.6). A leaf added here — or one from any other group —
  // means someone read the spec's `required` flags wrong. `companyId` is required on
  // POST /jobs but excluded from capture (tenancy fk), so it is deliberately absent.
  expect(snuggProAdapter.requiredOnCreate).toEqual({
    hvac: ["hvacSystemEquipmentType", "hvacUpgradeAction"],
    job: [
      "firstName",
      "lastName",
      "address1",
      "city",
      "state",
      "zip",
      "accountId",
      "stageId",
      "jobType",
      "programId",
    ],
  });
});

test("no other group declares a required leaf — a partial dictation writes cleanly", () => {
  // Every other endpoint accepts a create with nothing set, so an auditor who only did
  // the basement is never blocked on the attic.
  const groups = Object.keys(snuggProAdapter.requiredOnCreate ?? {});
  expect(groups.filter((g) => g !== "hvac" && g !== "job")).toEqual([]);
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
    // The record matches on every identifying field, but ranking must still produce a
    // create default; the first candidate is just pre-highlighted.
    const instance = {
      hvacSystemEquipmentType: "Boiler",
      hvacHeatingSystemManufacturer: "Burnham",
    };
    const ranked = rankCandidates("hvac", instance, [existing[0]!]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]).toMatchObject({ uuid: "a", contradicts: false });
  });

  test("a contradicting field demotes a candidate in the ordering", () => {
    // Record b is a Carrier furnace vs a dictated Burnham boiler: it contradicts on both
    // identifying fields and must rank after the non-contradicting candidates.
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
    // The instance states no manufacturer, so neither record has a captured value to
    // contradict there.
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
    // Attic declares no identifying fields, so nothing can contradict; host order is
    // preserved exactly.
    const atticExisting: ExistingRecord[] = [
      { uuid: "attic-1", fields: { atticInsulation: 30 } },
      { uuid: "attic-2", fields: { atticInsulation: 19 } },
    ];
    const ranked = rankCandidates("attic", { atticInsulation: 19 }, atticExisting);
    expect(ranked.map((c) => c.uuid)).toEqual(["attic-1", "attic-2"]);
    expect(ranked.every((c) => !c.contradicts)).toBe(true);
  });
});
