import { z } from "zod";
import { describe, expect, test } from "vitest";
import { emptyDraft } from "./phase-draft.js";
import type { PhaseDraft } from "./phase-draft.js";
import { emptyNotes } from "./phase-notes.js";
import { enveloped } from "./enveloped.js";
import type { ExtractionTarget } from "./extractor.js";
import type { PhaseContext } from "./phase.js";

import { extractGroups, nullEnvelope, presenceNoteKey, wrapGroupEntry } from "./presence-phase.js";
import type { Group, Leaf, LeafEnvelope, PresenceMaps } from "./presence-phase.js";
import { spansNoteKey, spanPhase } from "./span-phase.js";
import { fakeChat } from "./test-support/fake-chat.js";

/**
 * Phase-level tests for the span phase, against hand-built drafts — the engine
 * is not involved, so `plan`/`run`/`merge` are driven directly through the
 * phase's `with` (the same fold the presence suite uses).
 */

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
  name: "span-test",
  extractionSchema,
  instructions: "Extract the fields from the transcript.",
  examples: [],
};

const groups = extractGroups(z.toJSONSchema(extractionSchema, { target: "draft-2020-12" }));

const ctx: PhaseContext<Values> = {
  transcript: { text: "the system is gas and the efficiency is 82 percent", annotations: {} },
  target,
};

const json = (value: unknown): string => JSON.stringify(value);

/**
 * The draft the presence phase's merge would have left: every group seeded with
 * its full null envelope, the presence maps in notes.
 */
function seededDraft(maps: PresenceMaps): PhaseDraft<Values> {
  const fields: Record<string, unknown> = {};
  for (const group of groups) {
    const entry: Record<string, LeafEnvelope> = {};
    for (const leaf of group.leaves) entry[leaf.key] = nullEnvelope();
    fields[group.key] = wrapGroupEntry(group, entry);
  }
  return {
    ...emptyDraft<Values>(),
    fields: fields,
    notes: emptyNotes().set(presenceNoteKey, maps),
  };
}

/** The item type is existentially hidden; recover what the encoding hides for assertions. */
const itemOf = (item: unknown) => item as { group: Group; activeLeaves: readonly Leaf[] };

describe("spanPhase — plan", () => {
  test("yields nothing for a group with no present leaves and one item for a group with some", () => {
    const { chat } = fakeChat(() => json({}));
    const phase = spanPhase<Values>({ groups, chat, model: chat.engine });
    phase.with((def) => {
      // hvac has a present leaf; site's map is all false.
      const draft = seededDraft({
        hvac: { fuel: true, efficiency: false, notes: false },
        site: { yearBuilt: false },
      });
      const items = def.plan(draft, ctx);
      expect(items.map((item) => def.describeItem?.(item))).toEqual([{ key: "hvac" }]);

      // Every leaf false everywhere: no items at all — the engine treats an
      // empty plan as a no-op, which is today's `activeLeaves.length === 0`
      // early-out expressed as planning rather than as a branch.
      const quiet = seededDraft({
        hvac: { fuel: false, efficiency: false, notes: false },
        site: { yearBuilt: false },
      });
      expect(def.plan(quiet, ctx)).toHaveLength(0);
    });
  });

  test("the item carries only the active leaves", () => {
    const { chat } = fakeChat(() => json({}));
    const phase = spanPhase<Values>({ groups, chat, model: chat.engine });
    phase.with((def) => {
      const draft = seededDraft({
        hvac: { fuel: true, efficiency: true, notes: false },
        site: { yearBuilt: false },
      });
      const [item] = def.plan(draft, ctx);
      expect(itemOf(item).activeLeaves.map((leaf) => leaf.key)).toEqual(["fuel", "efficiency"]);
    });
  });
});

describe("spanPhase — run", () => {
  test("makes the span call over the active leaves only, and reports one call", async () => {
    const { chat, requests } = fakeChat(() => json({ fuel: "the system is gas" }));
    const phase = spanPhase<Values>({ groups, chat, model: "fake-model" });
    const draft = seededDraft({ hvac: { fuel: true, efficiency: false, notes: false } });
    await phase.with(async (def) => {
      const [item] = def.plan(draft, ctx);
      const output = await def.run(item!, draft, ctx);

      expect(requests).toHaveLength(1);
      expect(requests[0]!.response_format.json_schema.name).toBe("hvac-spans");
      const schema = requests[0]!.response_format.json_schema.schema;
      // Only the ACTIVE leaf is asked about — the false leaves are not in the schema.
      expect(schema).toEqual({
        type: "object",
        properties: { fuel: { anyOf: [{ type: "string" }, { type: "null" }] } },
        required: ["fuel"],
        additionalProperties: false,
      });
      expect(output.value).toEqual({ fuel: "the system is gas" });
      expect(output.usage).toEqual({ calls: 1 });
    });
  });
});

describe("spanPhase — merge", () => {
  /** Fold one span outcome for the hvac item of `maps`, over the seeded draft. */
  async function foldHvac(
    maps: PresenceMaps,
    respond: (name: string) => string,
    outcome: "result" | "error",
  ): Promise<PhaseDraft<Values>> {
    const { chat } = fakeChat(() => respond("hvac-spans"));
    const phase = spanPhase<Values>({ groups, chat, model: chat.engine });
    const draft = seededDraft(maps);
    return phase.with(async (def) => {
      const [item] = def.plan(draft, ctx);
      const outcomes =
        outcome === "error"
          ? [{ outcome: "error" as const, item: item!, error: new Error("span failed") }]
          : [
              {
                outcome: "result" as const,
                item: item!,
                output: await def.run(item!, draft, ctx),
              },
            ];
      return def.merge(draft, outcomes);
    });
  }

  test("keeps a grounded span in the notes and writes it into the leaf", async () => {
    const merged = await foldHvac(
      { hvac: { fuel: true, efficiency: false, notes: false } },
      () => json({ fuel: "the system is gas" }),
      "result",
    );
    expect(merged.notes.get(spansNoteKey)).toEqual({
      hvac: { fuel: "the system is gas" },
    });
    expect(merged.fields.hvac?.fuel).toEqual({
      value: null,
      confidence: 0,
      sourceSpan: "the system is gas",
    });
    // The inactive leaves keep the seed.
    expect(merged.fields.hvac?.efficiency).toEqual(nullEnvelope());
  });

  test("drops an ungrounded span and nulls that leaf", async () => {
    // The quote is not a verbatim substring of the transcript — today's
    // unconditional grounding drop, which the measurement credits with taking
    // source-span fidelity to 100%.
    const merged = await foldHvac(
      { hvac: { fuel: true, efficiency: false, notes: false } },
      () => json({ fuel: "this invented quote never appears" }),
      "result",
    );
    expect(merged.notes.get(spansNoteKey)).toEqual({ hvac: {} });
    expect(merged.fields.hvac?.fuel).toEqual(nullEnvelope());
  });

  test("a failed item nulls the group's leaves — spans included", async () => {
    const merged = await foldHvac(
      { hvac: { fuel: true, efficiency: false, notes: false } },
      () => json({ fuel: "the system is gas" }),
      "error",
    );
    expect(merged.fields.hvac?.fuel).toEqual(nullEnvelope());
    expect(merged.fields.hvac?.efficiency).toEqual(nullEnvelope());
    expect(merged.fields.hvac?.notes).toEqual(nullEnvelope());
    // No surviving spans for the failed group: classify plans nothing for it.
    expect(merged.notes.get(spansNoteKey)).toEqual({ hvac: {} });
  });
});

describe("spanPhase — id", () => {
  test('defaults to "span" and honours an explicit id', () => {
    const { chat } = fakeChat(() => json({}));
    const defaults = spanPhase<Values>({ groups, chat, model: chat.engine });
    expect(defaults.id).toBe("span");
    const renamed = spanPhase<Values>({ groups, chat, model: chat.engine, id: "span-2" });
    expect(renamed.id).toBe("span-2");
  });
});
