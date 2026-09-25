import { z } from "zod";
import { describe, expect, test } from "vitest";

import { enveloped } from "../../provenance/enveloped.js";
import { stripJsonSchemaDescriptions, toJsonSchemaForWire } from "./wire-schema.js";

/**
 * @file The wire render's strip: `description` keywords leave the schema ONLY
 * at schema positions. The caution this suite exists for is the naive strip —
 * a key-name filter over the whole tree also deletes a field genuinely NAMED
 * `description`, leaves it behind in `required`, and produces an invalid
 * schema whose 400 is very hard to trace. Every test here bites on that line.
 */

/** A property named `description`, beside an ordinary sibling — the trap. */
const withDescriptionProperty = z
  .object({
    description: z.string().describe("the free-text description field"),
    name: z.string(),
  })
  .strict();

const render = (schema: z.ZodType): Record<string, unknown> =>
  z.toJSONSchema(schema, { target: "draft-2020-12" });

describe("stripJsonSchemaDescriptions", () => {
  test("a field genuinely named `description` survives, with its required entry", () => {
    const stripped = stripJsonSchemaDescriptions(render(withDescriptionProperty)) as {
      required: string[];
      properties: Record<string, { type: string; description?: string }>;
    };
    expect(Object.keys(stripped.properties)).toEqual(["description", "name"]);
    expect(stripped.properties.description!.type).toBe("string");
    expect(stripped.required).toContain("description");
  });

  test("a description KEYWORD at a schema position is removed", () => {
    const described = z.string().describe("guidance for the model");
    const stripped = stripJsonSchemaDescriptions(render(described)) as Record<string, unknown>;
    expect(stripped.type).toBe("string");
    expect(Object.hasOwn(stripped, "description")).toBe(false);
  });

  test("the description inside an enveloped leaf's `value` arm is removed — the adapter shape", () => {
    const schema = enveloped(
      z.object({ rValue: z.number().describe("a stated R-value, never a depth band") }).strict(),
    );
    const full = render(schema) as { properties: Record<string, unknown> };
    const stripped = stripJsonSchemaDescriptions(full) as typeof full;
    expect(JSON.stringify(stripped)).not.toContain("a stated R-value");
    // Everything but descriptions is untouched: same keys at every level.
    expect(Object.keys(stripped)).toEqual(Object.keys(full));
  });

  test("enum members and other DATA positions are never descended into", () => {
    const schema = z
      .object({
        state: z.enum(["Passed", "Failed"]),
      })
      .strict();
    const rendered = render(schema) as {
      properties: Record<string, { enum: unknown[] }>;
    };
    // Simulate a schema an exotic source produced: an object-valued enum
    // member carrying a `description` key. It is DATA, not a keyword.
    const state = rendered.properties.state!;
    state.enum = [{ description: "a member that IS an object", code: 1 }, "Passed"];
    const stripped = stripJsonSchemaDescriptions(rendered) as typeof rendered;
    expect(stripped.properties.state!.enum).toEqual(state.enum);
  });

  test("descriptions inside anyOf arms, items and $defs are all removed", () => {
    const rendered = {
      $defs: { leaf: { type: "string", description: "def text" } },
      anyOf: [{ type: "null" }, { type: "string", description: "arm text" }],
      items: { type: "object", properties: { a: { type: "number", description: "item text" } } },
      type: "object",
    };
    const stripped = stripJsonSchemaDescriptions(rendered) as Record<string, unknown>;
    expect(JSON.stringify(stripped)).not.toContain("def text");
    expect(JSON.stringify(stripped)).not.toContain("arm text");
    expect(JSON.stringify(stripped)).not.toContain("item text");
    expect(stripped.type).toBe("object");
  });

  test("required arrays and property keys are never modified", () => {
    const rendered = render(withDescriptionProperty) as {
      required: unknown[];
      properties: Record<string, unknown>;
    };
    const stripped = stripJsonSchemaDescriptions(rendered) as typeof rendered;
    expect(stripped.required).toEqual(rendered.required);
    expect(Object.keys(stripped.properties)).toEqual(Object.keys(rendered.properties));
  });
});

describe("toJsonSchemaForWire", () => {
  const schema = enveloped(
    z.object({ rValue: z.number().describe("a stated R-value, never a depth band") }).strict(),
  );

  test("default: the wire render carries no descriptions", () => {
    const wire = toJsonSchemaForWire(schema);
    expect(JSON.stringify(wire)).not.toContain("a stated R-value");
  });

  test("keepDescriptions: the historical rendering, descriptions included", () => {
    const wire = toJsonSchemaForWire(schema, { keepDescriptions: true });
    expect(wire).toEqual(z.toJSONSchema(schema, { target: "draft-2020-12" }));
  });
});
