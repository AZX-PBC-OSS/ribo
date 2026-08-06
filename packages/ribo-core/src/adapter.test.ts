import { expect, test } from "vitest";
import { z } from "zod";
import { enveloped } from "./enveloped.js";
import type { ToolAdapter, ToolAdapterExample, WriteMetadata } from "./adapter.js";

// The fields one adapter writes, and the host context it needs to write them.
// `atticSchema` is the PATCH — the source of truth for `V` — and the extraction
// schema is DERIVED from it rather than declared beside it.
const atticSchema = z.object({
  rValue: z.number().nullable().optional(),
  area: z.number().nullable().optional(),
});
type AtticFields = z.infer<typeof atticSchema>;

const atticExtractionSchema = enveloped(atticSchema);

interface JobContext {
  jobId: string;
}
const jobContextSchema = z.object({ jobId: z.string().min(1) });

interface Written {
  fields: AtticFields;
  ctx: JobContext;
  meta: WriteMetadata;
}

const makeAdapter = (sink: Written[]): ToolAdapter<AtticFields, JobContext> => ({
  name: "attic-insulation",
  schema: atticSchema,
  extractionSchema: atticExtractionSchema,
  ctxSchema: jobContextSchema,
  instructions: "Extract the attic insulation R-value and area in square feet.",
  examples: [
    {
      transcript: "attic is R-13 over about four hundred square feet",
      // Enveloped, because an example's fields are the ASSISTANT turn the model
      // imitates — not the values a write eventually receives.
      fields: {
        rValue: { value: 13, confidence: 1, sourceSpan: "attic is R-13" },
        area: { value: 400, confidence: 1, sourceSpan: "about four hundred square feet" },
      },
    },
  ],
  write: async (fields, ctx, meta) => {
    sink.push({ fields, ctx, meta });
  },
});

test("an adapter carries a name, instructions and a schema for its fields", () => {
  const adapter = makeAdapter([]);

  expect(adapter.name).toBe("attic-insulation");
  expect(adapter.instructions).toContain("R-value");
  expect(adapter.schema.parse({ rValue: 13, area: 400 })).toEqual({ rValue: 13, area: 400 });
});

test("the schema rejects fields that do not match", () => {
  const adapter = makeAdapter([]);

  expect(() => adapter.schema.parse({ rValue: "thirteen", area: 400 })).toThrow();
});

// --- The two field shapes ---------------------------------------------------

test("`schema` is a patch: a rejected field is an absent key, an accepted null is a present one", () => {
  const adapter = makeAdapter([]);

  // `rValue` rejected at review: absent, so the write leaves it alone.
  expect(adapter.schema.parse({ area: 400 })).toEqual({ area: 400 });
  // `rValue` accepted as null: present, so the write blanks it. Two different
  // instructions, and the patch is what lets them be told apart.
  const blanked = adapter.schema.parse({ rValue: null, area: 400 });
  expect("rValue" in blanked).toBe(true);
  expect(blanked.rValue).toBeNull();
});

test("`extractionSchema` is not the patch: it requires every key and takes envelopes", () => {
  const adapter = makeAdapter([]);
  const draft = adapter.examples?.[0]?.fields;

  // The enveloped example parses as extraction and NOT as a patch, and the plain
  // values parse as a patch and NOT as extraction. If one schema could stand in
  // for the other, `ToolAdapter` would not need two.
  expect(adapter.extractionSchema.safeParse(draft).success).toBe(true);
  expect(adapter.schema.safeParse(draft).success).toBe(false);
  expect(adapter.extractionSchema.safeParse({ rValue: 13, area: 400 }).success).toBe(false);

  // The patch's optionality does not survive: an omitted key is legal there and
  // illegal here, because the model must say `null` rather than stay silent.
  expect(adapter.extractionSchema.safeParse({ rValue: draft?.rValue }).success).toBe(false);
});

test("ctxSchema parses a host context — a type cannot do this off a persisted row", () => {
  const adapter = makeAdapter([]);

  expect(adapter.ctxSchema.parse({ jobId: "job-7" })).toEqual({ jobId: "job-7" });
  expect(adapter.ctxSchema.safeParse({ jobId: "" }).success).toBe(false);
  expect(adapter.ctxSchema.safeParse({}).success).toBe(false);
});

test("write receives the parsed fields, the host context and the per-attempt metadata", async () => {
  const sink: Written[] = [];
  const adapter = makeAdapter(sink);

  await adapter.write({ rValue: 13, area: 400 }, { jobId: "job-7" }, { idempotencyKey: "item-1" });

  expect(sink).toEqual([
    {
      fields: { rValue: 13, area: 400 },
      ctx: { jobId: "job-7" },
      meta: { idempotencyKey: "item-1" },
    },
  ]);
  // `meta` arrives BESIDE `ctx`, never inside it: `ctx` travels with the recording
  // and `meta` comes from the queue, so a host must not be able to persist an
  // idempotency key into a recording's context.
  expect(sink[0]!.ctx).toEqual({ jobId: "job-7" });
});

test("the same idempotency key can be replayed — it is stable across a retry, not per-call", async () => {
  const sink: Written[] = [];
  const adapter = makeAdapter(sink);
  const meta: WriteMetadata = { idempotencyKey: "item-1" };

  await adapter.write({ rValue: 13 }, { jobId: "job-7" }, meta);
  await adapter.write({ rValue: 13 }, { jobId: "job-7" }, meta);

  expect(sink.map((w) => w.meta.idempotencyKey)).toEqual(["item-1", "item-1"]);
});

test("examples are optional", () => {
  const minimal: ToolAdapter<AtticFields, JobContext> = {
    name: "minimal",
    schema: atticSchema,
    extractionSchema: atticExtractionSchema,
    ctxSchema: jobContextSchema,
    instructions: "Extract nothing in particular.",
    write: async () => {},
  };

  expect(minimal.examples).toBeUndefined();
});

test("examples pair a transcript with the ENVELOPED fields it should yield", () => {
  const example: ToolAdapterExample<z.infer<typeof atticExtractionSchema>> = {
    transcript: "attic is R-13 over about four hundred square feet",
    fields: {
      rValue: { value: 13, confidence: 1, sourceSpan: "attic is R-13" },
      area: { value: 400, confidence: 1, sourceSpan: "about four hundred square feet" },
    },
  };

  expect(atticExtractionSchema.parse(example.fields)).toEqual(example.fields);
});

// --- Type-level tests -------------------------------------------------------
//
// These are enforced by `tsc` (`pnpm --filter @azx/ribo-core typecheck`, which
// `./check.sh` runs), not by the Vitest run above — esbuild strips types without
// checking them. Each `@ts-expect-error` below is itself the assertion: if the
// error it expects ever stops happening, tsc fails with "Unused
// '@ts-expect-error' directive". In particular, loosening `C` back to `unknown`
// — the review finding this type parameter exists to prevent — makes any ctx
// assignable, the expected errors vanish, and this file stops compiling.

test("a mismatched ctx does not compile", async () => {
  const adapter = makeAdapter([]);
  const meta = { idempotencyKey: "item-1" };

  // @ts-expect-error - ctx must be JobContext; a foreign shape is not assignable.
  await adapter.write({ rValue: 13, area: 400 }, { assessmentId: "job-7" }, meta);

  // @ts-expect-error - ctx is required and typed, so it cannot be omitted.
  await adapter.write({ rValue: 13, area: 400 });

  // @ts-expect-error - a bare string is not a JobContext either.
  await adapter.write({ rValue: 13, area: 400 }, "job-7", meta);

  // @ts-expect-error - fields are typed too: `rValue` is a number.
  await adapter.write({ rValue: "thirteen", area: 400 }, { jobId: "job-7" }, meta);

  // @ts-expect-error - `meta` is required: a write with no idempotency key is not
  // a legal write, which is why it is a parameter rather than an option.
  await adapter.write({ rValue: 13, area: 400 }, { jobId: "job-7" });

  expect(true).toBe(true);
});

test("the extraction schema cannot be the patch schema", () => {
  // The type-level half of "derived, not hand-written": `Enveloped<V>` is not `V`,
  // so pointing `extractionSchema` back at the patch does not compile. Without
  // this the two members could be wired to the same object and only a runtime
  // test would notice.
  const misdeclared: ToolAdapter<AtticFields, JobContext> = {
    name: "misdeclared",
    schema: atticSchema,
    // @ts-expect-error - the patch is `ZodType<V>`, not `ZodType<Enveloped<V>>`.
    extractionSchema: atticSchema,
    ctxSchema: jobContextSchema,
    instructions: "Extract nothing in particular.",
    write: async () => {},
  };

  expect(misdeclared.name).toBe("misdeclared");
});

test("a richer ctx cannot be silently narrowed away", () => {
  interface RichContext {
    jobId: string;
    userId: string;
  }

  const rich: ToolAdapter<AtticFields, RichContext> = {
    name: "rich",
    schema: atticSchema,
    extractionSchema: atticExtractionSchema,
    ctxSchema: z.object({ jobId: z.string(), userId: z.string() }),
    instructions: "Needs a user as well as a job.",
    write: async () => {},
  };

  // @ts-expect-error - an adapter that needs `userId` cannot pose as one that
  // only gets `jobId`. This fails only because `write` is declared as a function
  // *property*: TypeScript checks method parameters bivariantly, which would let
  // this through and quietly reintroduce the untyped-ctx hole.
  const narrowed: ToolAdapter<AtticFields, JobContext> = rich;

  expect(narrowed.name).toBe("rich");
});

test("an adapter declared for one context is not assignable to another", () => {
  interface OtherContext {
    assessmentId: string;
  }

  // @ts-expect-error - ToolAdapter<V, JobContext> is not a ToolAdapter<V, OtherContext>.
  const misdeclared: ToolAdapter<AtticFields, OtherContext> = makeAdapter([]);

  expect(misdeclared.name).toBe("attic-insulation");
});
