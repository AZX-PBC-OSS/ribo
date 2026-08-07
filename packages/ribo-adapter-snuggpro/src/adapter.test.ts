import { buildReviewRequest, isSpanGrounded } from "@azx/ribo-core";
import { expect, test } from "vitest";
import { SNUGGPRO_ADAPTER_NAME, snuggProAdapter } from "./adapter.js";
import type { SnuggWriteContext } from "./context.js";
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
    const walk = (envelope: { value: unknown; sourceSpan: string | null }) => {
      if (envelope.sourceSpan !== null) {
        expect(isSpanGrounded(envelope.sourceSpan, example.transcript)).toBe(true);
      }
    };
    const { healthSafety, ...top } = example.fields;
    for (const envelope of Object.values(top)) walk(envelope);
    for (const envelope of Object.values(healthSafety)) walk(envelope);
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
  const fields: SnuggValues = { heatingEquipmentType: "boiler", heatingFuel: null };
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

test("every requiredOnCreate path is a real leaf of the values schema", () => {
  // The drift guard, and the reason a parallel list is acceptable at all rather
  // than metadata on the schema. A typo or a renamed field must fail HERE, loudly,
  // instead of silently marking nothing required and letting a write die at the
  // host that evening. Uses the same walk a review card sees, so it cannot drift
  // from what buildReviewRequest actually enumerates.
  const leaves = Object.keys(
    buildReviewRequest({}, { recordingId: "r", text: "", engine: "fake" }, snuggProAdapter.schema)
      .fields,
  );
  for (const path of snuggProAdapter.requiredOnCreate ?? []) {
    expect(leaves).toContain(path);
  }
});

test("the one required leaf is the HVAC equipment type", () => {
  // Snugg Pro's ONLY component endpoint with required capture fields is
  // POST /jobs/{jobId}/hvac, and it wants two. `hvacUpgradeAction` is the other
  // and is not extracted yet, so this list is deliberately one entry — see the
  // comment on `requiredOnCreate`.
  expect(snuggProAdapter.requiredOnCreate).toEqual(["heatingEquipmentType"]);
});
