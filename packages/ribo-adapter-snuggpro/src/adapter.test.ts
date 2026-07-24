import { isSpanGrounded } from "@azx/ribo-core";
import { expect, test } from "vitest";
import { SNUGGPRO_ADAPTER_NAME, snuggProAdapter } from "./adapter.js";
import type { SnuggWriteContext } from "./context.js";
import type { SnuggFields } from "./schema.js";

test("carries a stable name, instructions and a parsing schema", () => {
  expect(snuggProAdapter.name).toBe(SNUGGPRO_ADAPTER_NAME);
  expect(snuggProAdapter.name).toBe("snuggpro-bounded");
  // The instructions carry the normalization intent, not just a field list.
  expect(snuggProAdapter.instructions).toContain("energy auditor");
  expect(snuggProAdapter.instructions).toContain("SEPARATE axis");
});

test("the schema parses the adapter's own few-shot examples", () => {
  const example = snuggProAdapter.examples?.[0];
  expect(example).toBeDefined();
  expect(() => snuggProAdapter.schema.parse(example?.fields)).not.toThrow();
});

test("every example sourceSpan is verbatim in its transcript (grounding holds)", () => {
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

test("write is scaffolded, not faked: it rejects rather than silently succeeding", async () => {
  const fixture = snuggProAdapter.examples?.[0];
  if (!fixture) throw new Error("expected a Snugg Pro few-shot example fixture");
  const fields = structuredClone(fixture.fields);
  const ctx: SnuggWriteContext = {
    assessmentId: "assessment-1",
    companyId: "company-1",
    apiBaseUrl: "https://api.snuggpro.com",
  };
  await expect(snuggProAdapter.write(fields, ctx)).rejects.toThrow(/Task 6|not implemented/);
});

// --- Type-level checks (enforced by tsc, not the Vitest run) ----------------
// The adapter's `C` is a real `SnuggWriteContext`, never `unknown`. These pin
// that: a foreign ctx and a missing ctx must both fail to compile. If `C` were
// loosened to `unknown` the expected errors vanish and this file stops compiling.
async function _ctxIsReal(fields: SnuggFields): Promise<void> {
  // @ts-expect-error - ctx must be a SnuggWriteContext; a foreign shape is rejected.
  await snuggProAdapter.write(fields, { jobId: "job-7" });

  // @ts-expect-error - ctx is required and typed; it cannot be omitted.
  await snuggProAdapter.write(fields);
}
