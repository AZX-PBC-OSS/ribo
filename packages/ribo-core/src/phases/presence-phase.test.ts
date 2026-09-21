import { z } from "zod";
import { describe, expect, test } from "vitest";
import { emptyDraft } from "./phase-draft.js";
import type { PhaseDraft } from "./phase-draft.js";
import { enveloped } from "../provenance/enveloped.js";
import type { ExtractionTarget } from "../extraction/extractor.js";
import type { PhaseContext } from "./phase.js";

import { extractGroups, presenceNoteKey, presencePhase } from "./presence-phase.js";
import { fakeChat } from "../test-support/fake-chat.js";

/**
 * Phase-level tests for the presence phase, against hand-built drafts — the
 * engine is not involved, so `plan`/`run`/`merge` are driven directly through
 * the phase's `with` (the same fold `fill-phase.test.ts` uses in the openai
 * package).
 */

/** A two-group flat extraction target, the same shape the preset suite uses. */
const patchSchema = z.strictObject({
  hvac: z
    .strictObject({
      fuel: z.enum(["Oil", "Gas"]).nullable().optional(),
      efficiency: z.number().nullable().optional(),
      notes: z.string().nullable().optional(),
    })
    .optional(),
  site: z
    .strictObject({
      yearBuilt: z.number().nullable().optional(),
    })
    .optional(),
});

const extractionSchema = enveloped(patchSchema);
type Values = z.infer<typeof patchSchema>;

const target: ExtractionTarget<Values> = {
  name: "presence-test",
  extractionSchema,
  instructions: "Extract the fields from the transcript.",
  examples: [],
};

function walkedGroups(schema: z.ZodType) {
  return extractGroups(z.toJSONSchema(schema, { target: "draft-2020-12" }));
}

const groups = walkedGroups(extractionSchema);

const ctx: PhaseContext<Values> = {
  transcript: { text: "the system is gas", annotations: {} },
  target,
};

const json = (value: unknown): string => JSON.stringify(value);

describe("presencePhase — plan", () => {
  test("returns one item per group, regardless of the draft", () => {
    const { chat } = fakeChat(() => json({}));
    const phase = presencePhase<Values>({ groups, chat, model: chat.engine });
    // A draft that already holds fields — plan ignores it: presence is the pass
    // that decides what everything else looks at, so it has nothing to narrow against.
    const draft = {
      ...emptyDraft<Values>(),
      fields: { site: { yearBuilt: { value: 1950, confidence: 1, sourceSpan: "1950" } } },
    };
    phase.with((def) => {
      const items = def.plan(draft, ctx);
      expect(items).toHaveLength(2);
      expect(items.map((item) => def.describeItem?.(item))).toEqual([
        { key: "hvac" },
        { key: "site" },
      ]);
    });
  });
});

describe("presencePhase — run", () => {
  test("makes one call under the group's presence name and stamps the engine", async () => {
    const { chat, requests } = fakeChat((name) =>
      name === "hvac-presence" ? json({ fuel: true, efficiency: false, notes: false }) : json({}),
    );
    const phase = presencePhase<Values>({ groups, chat, model: chat.engine });
    await phase.with(async (def) => {
      const [item] = def.plan(emptyDraft<Values>(), ctx);
      const output = await def.run(item!, emptyDraft<Values>(), ctx);

      expect(requests).toHaveLength(1);
      expect(requests[0]!.response_format.json_schema.name).toBe("hvac-presence");
      // The presence schema: one boolean property per leaf, all required.
      const schema = requests[0]!.response_format.json_schema.schema;
      expect(schema).toEqual({
        type: "object",
        properties: {
          fuel: { type: "boolean" },
          efficiency: { type: "boolean" },
          notes: { type: "boolean" },
        },
        required: ["fuel", "efficiency", "notes"],
        additionalProperties: false,
      });

      // The `engine` stamp matters: the result's usage.engine comes from the
      // first phase output that reports one, and a review card reads it.
      expect(output.usage).toEqual({ calls: 1, engine: "fake-chat" });
      expect(output.value).toEqual({ fuel: true, efficiency: false, notes: false });
    });
  });
});

describe("presencePhase — merge", () => {
  /** Plan, run every item against a name-dispatched response, fold through merge. */
  async function fold(respond: (name: string) => string): Promise<PhaseDraft<Values>> {
    const { chat } = fakeChat((name) => respond(name));
    const phase = presencePhase<Values>({ groups, chat, model: chat.engine });
    const draft = emptyDraft<Values>();
    return phase.with(async (def) => {
      const outcomes = [];
      for (const item of def.plan(draft, ctx)) {
        outcomes.push({
          outcome: "result" as const,
          item,
          output: await def.run(item, draft, ctx),
        });
      }
      return def.merge(draft, outcomes);
    });
  }

  test("stores each group's boolean map under the note key", async () => {
    const merged = await fold((name) =>
      name === "hvac-presence"
        ? json({ fuel: true, efficiency: false, notes: false })
        : json({ yearBuilt: false }),
    );
    expect(merged.notes.get(presenceNoteKey)).toEqual({
      hvac: { fuel: true, efficiency: false, notes: false },
      site: { yearBuilt: false },
    });
  });

  test("seeds EVERY group with a complete null-filled entry — failed and absent groups included", async () => {
    // The load-bearing detail: a group whose presence map ends up all false has
    // no item in any later phase, and the engine skips `merge` on an empty plan
    // — so presence is the only phase that can write this group at all. Without
    // the seed its key would go missing from `fields`, and the closing parse
    // would reject it — `enveloped()` strips top-level `.optional()` and rebuilds
    // with `z.strictObject`, so every group key is required (`enveloped.test.ts`
    // pins that) — after every other group's model calls had been spent.
    // Here hvac's item FAILED (no outcome at all) and site's succeeded all-false;
    // the seed must cover both.
    const { chat } = fakeChat((name) =>
      name === "site-presence" ? json({ yearBuilt: false }) : json({}),
    );
    const phase = presencePhase<Values>({ groups, chat, model: chat.engine });
    const draft = emptyDraft<Values>();
    const merged = await phase.with(async (def) => {
      const outcomes = [];
      for (const item of def.plan(draft, ctx)) {
        if (def.describeItem?.(item)?.key === "hvac") continue;
        outcomes.push({
          outcome: "result" as const,
          item,
          output: await def.run(item, draft, ctx),
        });
      }
      return def.merge(draft, outcomes);
    });

    expect(merged.fields.hvac?.fuel).toEqual({ value: null, confidence: 0, sourceSpan: null });
    expect(merged.fields.hvac?.efficiency).toEqual({
      value: null,
      confidence: 0,
      sourceSpan: null,
    });
    expect(merged.fields.hvac?.notes).toEqual({ value: null, confidence: 0, sourceSpan: null });
    expect(merged.fields.site?.yearBuilt).toEqual({
      value: null,
      confidence: 0,
      sourceSpan: null,
    });
  });

  test("a failed item nulls that group's leaves INCLUDING their spans", async () => {
    const { chat } = fakeChat((name) =>
      name === "site-presence" ? json({ yearBuilt: false }) : json({}),
    );
    const phase = presencePhase<Values>({ groups, chat, model: chat.engine });
    phase.with((def) => {
      const items = def.plan(emptyDraft<Values>(), ctx);
      // Pre-existing envelopes with spans — the merge must overwrite them.
      const draft = {
        ...emptyDraft<Values>(),
        fields: {
          hvac: {
            fuel: { value: "Gas", confidence: 1, sourceSpan: "the system is gas" },
          },
        },
      } as PhaseDraft<Values>;
      const outcomes = [
        { outcome: "error" as const, item: items[0]!, error: new Error("presence failed") },
      ];
      const merged = def.merge(draft, outcomes);
      expect(merged.fields.hvac?.fuel).toEqual({ value: null, confidence: 0, sourceSpan: null });
    });
  });

  test("a collection group's entry is a one-element array; a flat group's is the bare map", async () => {
    // R1.6 instance modeling: a collection group's value is the leaf-envelope
    // map wrapped in a one-element array — the wrap every merge that writes a
    // group entry applies through one shared helper.
    const instancePatch = z.strictObject({
      hvac: z
        .array(z.strictObject({ fuel: z.enum(["Oil", "Gas"]).nullable().optional() }))
        .optional(),
      site: z.strictObject({ yearBuilt: z.number().nullable().optional() }).optional(),
    });
    const instanceGroups = walkedGroups(enveloped(instancePatch));
    expect(instanceGroups.map((group) => group.isArray)).toEqual([true, false]);

    const instanceSchema = enveloped(instancePatch);
    type InstanceValues = z.infer<typeof instancePatch>;
    const instanceTarget: ExtractionTarget<InstanceValues> = {
      name: "instance-presence-test",
      extractionSchema: instanceSchema,
      instructions: "Extract the fields from the transcript.",
      examples: [],
    };
    const instanceCtx: PhaseContext<InstanceValues> = {
      transcript: { text: "the system is gas", annotations: {} },
      target: instanceTarget,
    };

    const { chat } = fakeChat((name) =>
      name === "hvac-presence" ? json({ fuel: true }) : json({ yearBuilt: false }),
    );
    const phase = presencePhase<InstanceValues>({
      groups: instanceGroups,
      chat,
      model: chat.engine,
    });
    const draft = emptyDraft<InstanceValues>();
    const merged = await phase.with(async (def) => {
      const outcomes = [];
      for (const item of def.plan(draft, instanceCtx)) {
        outcomes.push({
          outcome: "result" as const,
          item,
          output: await def.run(item, draft, instanceCtx),
        });
      }
      return def.merge(draft, outcomes);
    });

    expect(merged.fields.hvac).toEqual([
      { fuel: { value: null, confidence: 0, sourceSpan: null } },
    ]);
    expect(merged.fields.site).toEqual({
      yearBuilt: { value: null, confidence: 0, sourceSpan: null },
    });
  });
});

describe("presencePhase — the construction-time provenance refusal", () => {
  // A group derived at "row" or "none" granularity has no per-leaf envelope, and
  // this strategy asks for one verbatim span PER LEAF, so it cannot extract that
  // group. The refusal keeps today's message and stays at construction — before
  // any call is made. (The preset walks at ITS construction; the walk lives here.)
  const rowPatch = z.strictObject({
    rooms: z.array(z.strictObject({ name: z.string().nullable().optional() })).optional(),
  });

  test('a "row" group throws, naming the group and the leaf', () => {
    const rowSchema = enveloped(rowPatch, { provenance: { rooms: "row" } });
    expect(() =>
      extractGroups(
        z.toJSONSchema(rowSchema, { target: "draft-2020-12" }) as Record<string, unknown>,
      ),
    ).toThrow(/"rooms"/);
  });

  test('a "none" group throws too — there is no span for the span phase to ask for', () => {
    const noneSchema = enveloped(rowPatch, { provenance: { rooms: "none" } });
    expect(() =>
      extractGroups(
        z.toJSONSchema(noneSchema, { target: "draft-2020-12" }) as Record<string, unknown>,
      ),
    ).toThrow(/"rooms"/);
  });

  test("the default leaf derivation is untouched — it still walks", () => {
    expect(() => walkedGroups(extractionSchema)).not.toThrow();
  });
});

describe("presencePhase — metadata", () => {
  test("its merge writes the presence note unconditionally — the span phase's plan demands it", async () => {
    const { chat } = fakeChat((name) =>
      json(
        name === "hvac-presence"
          ? { fuel: true, efficiency: false, notes: false }
          : { yearBuilt: false },
      ),
    );
    const phase = presencePhase<Values>({ groups, chat, model: chat.engine });
    const draft0 = emptyDraft<Values>();
    const merged = await phase.with(async (def) => {
      const outcomes = [];
      for (const item of def.plan(draft0, ctx)) {
        outcomes.push({
          outcome: "result" as const,
          item,
          output: await def.run(item, draft0, ctx),
        });
      }
      return def.merge(draft0, outcomes);
    });
    // Even an all-false (or all-failed) presence pass writes the key: the span
    // phase's plan throws when it is missing, so the note is the runtime
    // channel's contract, not a declaration.
    expect(merged.notes.get(presenceNoteKey)).toEqual({
      hvac: { fuel: true, efficiency: false, notes: false },
      site: { yearBuilt: false },
    });
  });
});

describe("presencePhase — requires", () => {
  test("declares none of its own, and the option absent leaves it undefined", () => {
    const { chat } = fakeChat(() => json({}));
    const phase = presencePhase<Values>({ groups, chat, model: chat.engine });
    expect(phase.requires).toBeUndefined();
  });

  test("a caller's requires is taken as the requires — the phase has no default to replace", () => {
    const { chat } = fakeChat(() => json({}));
    const phase = presencePhase<Values>({ groups, chat, model: chat.engine, requires: ["mine"] });
    expect(phase.requires).toEqual(["mine"]);
  });
});

describe("presencePhase — id", () => {
  test('defaults to "presence" and honours an explicit id', () => {
    const { chat } = fakeChat(() => json({}));
    const defaults = presencePhase<Values>({ groups, chat, model: chat.engine });
    expect(defaults.id).toBe("presence");
    const renamed = presencePhase<Values>({ groups, chat, model: chat.engine, id: "presence-2" });
    expect(renamed.id).toBe("presence-2");
  });
});
