import { z } from "zod";
import { describe, expect, test } from "vitest";

import { emptyDraft } from "./phase-draft.js";
import type { PhaseDraft } from "./phase-draft.js";
import { emptyNotes } from "./phase-notes.js";
import { enveloped } from "../provenance/enveloped.js";
import type { ExtractionTarget } from "../extraction/extractor.js";
import { extractGroups, nullEnvelope, presenceNoteKey, wrapGroupEntry } from "./presence-phase.js";
import type { Group, Leaf, PresenceMaps } from "./presence-phase.js";
import type { PhaseContext } from "./phase.js";
import type { ChatClient, ChatRequest } from "./chat-client.js";

import { presenceFillPhase } from "./presence-fill-phase.js";

/**
 * Phase-level tests for the presence-narrowed fill phase.
 *
 * The phase-level tests drive `plan`/`run`/`merge` directly through the phase's
 * `with`, over hand-seeded drafts (the span-phase suite's fold). The
 * composition tests live with the preset in
 * `extraction/strategies/presence-narrowed.test.ts`: they run core's REAL
 * `presencePhase` ahead of this phase, because the seed is the
 * invariant under test, so a hand-built stub presence phase would let the
 * ADR 0009 pin pass for the wrong reason — the test would be seeding the draft
 * itself, which is the thing that must be pinned as the presence phase's job.
 *
 * One chat stands in for the transport, dispatching on the request name: fill
 * calls are `<target.name>-<group>`.
 */

const patchSchema = z.strictObject({
  // A collection group: the fill's singleton projection and the seeded
  // one-element array wrap both get exercised through it.
  hvac: z
    .array(
      z.strictObject({
        fuel: z.enum(["Oil", "Gas"]).nullable().optional(),
        efficiency: z.number().nullable().optional(),
        notes: z.string().nullable().optional(),
      }),
    )
    .optional(),
  site: z
    .strictObject({
      yearBuilt: z.number().nullable().optional(),
      orientation: z.string().nullable().optional(),
    })
    .optional(),
});
type Values = z.infer<typeof patchSchema>;

const target: ExtractionTarget<Values> = {
  name: "pf-demo",
  extractionSchema: enveloped(patchSchema),
  instructions: "Extract the fields from the transcript.",
  examples: [],
};

const groups = extractGroups(z.toJSONSchema(target.extractionSchema, { target: "draft-2020-12" }));

const ctx: PhaseContext<Values> = {
  transcript: { text: "the system is gas and the efficiency is 82 percent", annotations: {} },
  target,
};

/** Read a loose JSON Schema node — the request's schema is `Record<string, unknown>`. */
const node = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;

/** One committed leaf envelope, as a fill response carries. */
const envelope = (value: unknown, span: string): Record<string, unknown> => ({
  value,
  confidence: 0.9,
  sourceSpan: span,
});

/**
 * The draft the presence phase's merge would have left: every group seeded
 * with its full null envelope, the presence maps in notes — built the same way
 * the span-phase suite builds it.
 */
function seededDraft(maps: PresenceMaps): PhaseDraft<Values> {
  const fields: Record<string, unknown> = {};
  for (const group of groups) {
    const entry: Record<string, ReturnType<typeof nullEnvelope>> = {};
    for (const leaf of group.leaves) entry[leaf.key] = nullEnvelope();
    fields[group.key] = wrapGroupEntry(group, entry);
  }
  return {
    ...emptyDraft<Values>(),
    fields,
    notes: emptyNotes().set(presenceNoteKey, maps),
  };
}

/** The item type is existentially hidden; recover what the encoding hides for assertions. */
const itemOf = (item: unknown) => item as { group: Group; activeLeaves: readonly Leaf[] };

/** A ChatClient dispatching on the request name, recording every request. */
function fakeChat(respond: (requestName: string) => unknown): {
  chat: ChatClient;
  requests: ChatRequest[];
} {
  const requests: ChatRequest[] = [];
  return {
    chat: {
      complete: async (request) => {
        requests.push(request);
        return {
          content: JSON.stringify(respond(request.response_format.json_schema.name)),
          finishReason: "stop",
        };
      },
    },
    requests,
  };
}

/** hvac partially present (2 of 3 leaves), site entirely absent. */
const partialMaps: PresenceMaps = {
  hvac: { fuel: true, efficiency: true, notes: false },
  site: { yearBuilt: false, orientation: false },
};

/** The fill response for a narrowed hvac call — exactly the active leaves. */
const hvacFill = {
  fuel: envelope("Gas", "the system is gas"),
  efficiency: envelope(82, "efficiency is 82 percent"),
};

describe("presenceFillPhase — plan", () => {
  test("one item per group with at least one present leaf; none for an all-false group", () => {
    const { chat } = fakeChat(() => ({}));
    const phase = presenceFillPhase<Values>({ target, groups, chat, model: "m" });
    phase.with((def) => {
      const items = def.plan(seededDraft(partialMaps), ctx);
      expect(items.map((item) => def.describeItem?.(item))).toEqual([{ key: "hvac" }]);

      // Every leaf false everywhere: no items at all — the engine treats an
      // empty plan as a no-op, so an all-absent transcript makes no fill call.
      const quiet = seededDraft({
        hvac: { fuel: false, efficiency: false, notes: false },
        site: { yearBuilt: false, orientation: false },
      });
      expect(def.plan(quiet, ctx)).toHaveLength(0);
    });
  });

  test("the item carries only the active leaves", () => {
    const { chat } = fakeChat(() => ({}));
    const phase = presenceFillPhase<Values>({ target, groups, chat, model: "m" });
    phase.with((def) => {
      const [item] = def.plan(seededDraft(partialMaps), ctx);
      expect(itemOf(item).activeLeaves.map((leaf) => leaf.key)).toEqual(["fuel", "efficiency"]);
    });
  });

  test("a dropped dependency is loud, not silent: plan throws naming the presence note", () => {
    // The most important consequence of the seeding contract: a list whose
    // earlier phases never wrote the presence note must not become a silent
    // all-null run — demandNote throws before any call is made.
    const { chat } = fakeChat(() => ({}));
    const phase = presenceFillPhase<Values>({ target, groups, chat, model: "m" });
    expect(() => phase.with((def) => def.plan(emptyDraft<Values>(), ctx))).toThrow(
      new RegExp(presenceNoteKey),
    );
  });
});

describe("presenceFillPhase — run", () => {
  test("one call whose projected schema carries exactly the active leaves — not the group's full set", async () => {
    const { chat, requests } = fakeChat((name) => {
      if (name === "pf-demo-hvac") return { hvac: hvacFill };
      throw new Error(`unexpected request ${name}`);
    });
    const phase = presenceFillPhase<Values>({ target, groups, chat, model: "fake-model" });
    const draft = seededDraft(partialMaps);
    await phase.with(async (def) => {
      const [item] = def.plan(draft, ctx);
      const output = await def.run(item!, draft, ctx);

      expect(requests).toHaveLength(1);
      const request = requests[0]!;
      expect(request.response_format.json_schema.name).toBe("pf-demo-hvac");
      const properties = node(node(request.response_format.json_schema.schema)["properties"]);
      // THE narrowing pin, on the actual request: the collection group is asked
      // for ONE instance (the element object — the singleton projection, not
      // the array the full schema carries), carrying exactly the active leaves.
      const hvac = node(properties["hvac"]);
      expect(hvac["type"]).toBe("object");
      expect(Object.keys(node(hvac["properties"]))).toEqual(["fuel", "efficiency"]);
      expect(hvac["required"]).toEqual(["fuel", "efficiency"]);
      expect(Object.keys(properties)).toEqual(["hvac"]);

      expect(output.value).toEqual(hvacFill);
      expect(output.usage?.calls).toBe(1);
    });
  });

  test("a flat group narrows the same way — its own leaf subset", async () => {
    const maps: PresenceMaps = { site: { yearBuilt: true, orientation: false } };
    const { chat, requests } = fakeChat((name) => {
      if (name === "pf-demo-site") return { site: { yearBuilt: envelope(1950, "built in 1950") } };
      throw new Error(`unexpected request ${name}`);
    });
    const phase = presenceFillPhase<Values>({ target, groups, chat, model: "m" });
    const draft = seededDraft(maps);
    await phase.with(async (def) => {
      const [item] = def.plan(draft, ctx);
      await def.run(item!, draft, ctx);
      expect(itemOf(item).group.key).toBe("site");
      const properties = node(node(requests[0]!.response_format.json_schema.schema)["properties"]);
      expect(Object.keys(node(node(properties["site"])["properties"]))).toEqual(["yearBuilt"]);
    });
  });

  test("groupInstructions supplies the call's system prompt; without it the target's instructions ride", async () => {
    // `perGroupPlan`'s two modes, pinned on the wire: the group's own
    // instructions when the option is provided, the target's unprojected ones
    // when it is not.
    const draft = seededDraft(partialMaps);

    const plain = fakeChat((name) => {
      if (name === "pf-demo-hvac") return { hvac: hvacFill };
      throw new Error(`unexpected request ${name}`);
    });
    await presenceFillPhase<Values>({ target, groups, chat: plain.chat, model: "m" }).with(
      async (def) => {
        const [item] = def.plan(draft, ctx);
        await def.run(item!, draft, ctx);
        expect(plain.requests[0]!.messages[0]).toEqual({
          role: "system",
          content: "Extract the fields from the transcript.",
        });
      },
    );

    const scoped = fakeChat((name) => {
      if (name === "pf-demo-hvac") return { hvac: hvacFill };
      throw new Error(`unexpected request ${name}`);
    });
    await presenceFillPhase<Values>({
      target,
      groups,
      chat: scoped.chat,
      model: "m",
      groupInstructions: (groupKey) => `Fill the ${groupKey} group.`,
    }).with(async (def) => {
      const [item] = def.plan(draft, ctx);
      await def.run(item!, draft, ctx);
      expect(scoped.requests[0]!.messages[0]).toEqual({
        role: "system",
        content: "Fill the hvac group.",
      });
    });
  });
});

describe("presenceFillPhase — id and requires", () => {
  test('defaults to id "fill" and requires ["presence"]', () => {
    const { chat } = fakeChat(() => ({}));
    const phase = presenceFillPhase<Values>({ target, groups, chat, model: "m" });
    expect(phase.id).toBe("fill");
    expect(phase.requires).toEqual(["presence"]);
  });

  test("a caller's requires REPLACES the default — the complete list, not an addition", () => {
    const { chat } = fakeChat(() => ({}));
    const phase = presenceFillPhase<Values>({
      target,
      groups,
      chat,
      model: "m",
      requires: ["presence", "mine"],
    });
    expect(phase.requires).toEqual(["presence", "mine"]);
  });
});
