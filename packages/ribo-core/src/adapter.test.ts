import { expect, test } from "vitest";
import { z } from "zod";
import type { ToolAdapter, ToolAdapterExample } from "./adapter.js";

// The fields one adapter extracts, and the host context it needs to write them.
const atticSchema = z.object({
  rValue: z.number(),
  area: z.number(),
});
type AtticFields = z.infer<typeof atticSchema>;

interface JobContext {
  jobId: string;
}

interface Written {
  fields: AtticFields;
  ctx: JobContext;
}

const makeAdapter = (sink: Written[]): ToolAdapter<AtticFields, JobContext> => ({
  name: "attic-insulation",
  schema: atticSchema,
  instructions: "Extract the attic insulation R-value and area in square feet.",
  examples: [
    {
      transcript: "attic is R-13 over about four hundred square feet",
      fields: { rValue: 13, area: 400 },
    },
  ],
  write: async (fields, ctx) => {
    sink.push({ fields, ctx });
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

test("write receives the parsed fields and the host context", async () => {
  const sink: Written[] = [];
  const adapter = makeAdapter(sink);

  await adapter.write({ rValue: 13, area: 400 }, { jobId: "job-7" });

  expect(sink).toEqual([{ fields: { rValue: 13, area: 400 }, ctx: { jobId: "job-7" } }]);
});

test("examples are optional", () => {
  const minimal: ToolAdapter<AtticFields, JobContext> = {
    name: "minimal",
    schema: atticSchema,
    instructions: "Extract nothing in particular.",
    write: async () => {},
  };

  expect(minimal.examples).toBeUndefined();
});

test("examples pair a transcript with the fields it should yield", () => {
  const example: ToolAdapterExample<AtticFields> = {
    transcript: "attic is R-13 over about four hundred square feet",
    fields: { rValue: 13, area: 400 },
  };

  expect(atticSchema.parse(example.fields)).toEqual(example.fields);
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

  // @ts-expect-error - ctx must be JobContext; a foreign shape is not assignable.
  await adapter.write({ rValue: 13, area: 400 }, { assessmentId: "job-7" });

  // @ts-expect-error - ctx is required and typed, so it cannot be omitted.
  await adapter.write({ rValue: 13, area: 400 });

  // @ts-expect-error - a bare string is not a JobContext either.
  await adapter.write({ rValue: 13, area: 400 }, "job-7");

  // @ts-expect-error - fields are typed too: `rValue` is a number.
  await adapter.write({ rValue: "thirteen", area: 400 }, { jobId: "job-7" });

  expect(true).toBe(true);
});

test("a richer ctx cannot be silently narrowed away", () => {
  interface RichContext {
    jobId: string;
    userId: string;
  }

  const rich: ToolAdapter<AtticFields, RichContext> = {
    name: "rich",
    schema: atticSchema,
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

  // @ts-expect-error - ToolAdapter<F, JobContext> is not a ToolAdapter<F, OtherContext>.
  const misdeclared: ToolAdapter<AtticFields, OtherContext> = makeAdapter([]);

  expect(misdeclared.name).toBe("attic-insulation");
});
