import { z } from "zod";
import { describe, expect, test } from "vitest";

import {
  emptyDraft,
  emptyNotes,
  enveloped,
  extractGroups,
  nullEnvelope,
  phasedExtractor,
  presenceNoteKey,
  presencePhase,
  wrapGroupEntry,
} from "@azx/ribo-core";
import type {
  CapableChatClient,
  ChatClient,
  ChatRequest,
  ExtractionTarget,
  Group,
  Leaf,
  PhaseContext,
  PhaseDraft,
  PresenceMaps,
} from "@azx/ribo-core";

import { presenceFillPhase, presenceNarrowedExtractor } from "./presence-fill-phase.js";

/**
 * Phase-level and composition tests for the presence-narrowed fill phase.
 *
 * The phase-level tests drive `plan`/`run`/`merge` directly through the phase's
 * `with`, over hand-seeded drafts (the span-phase suite's fold). The
 * composition tests run core's REAL `presencePhase` ahead of it, through the
 * preset: the seed is the invariant under test, so a hand-built stub presence
 * phase would let the ADR 0009 pin pass for the wrong reason — the test would
 * be seeding the draft itself, which is the thing that must be pinned as the
 * presence phase's job.
 *
 * One chat serves both phases, dispatching on the request name: presence calls
 * are `<group>-presence`, fill calls are `<target.name>-<group>`.
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

/** `presencePhase` speaks `CapableChatClient`; wrap the recording fake for it. */
const capable = (chat: ChatClient): CapableChatClient => ({
  ...chat,
  engine: "fake-engine",
  capability: () => Promise.resolve({ status: "ready" }),
});

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

/** One scripted chat answering presence for both groups and the hvac fill. */
function partialPresenceChat(): ReturnType<typeof fakeChat> {
  return fakeChat((name) => {
    if (name === "hvac-presence") return partialMaps.hvac;
    if (name === "site-presence") return partialMaps.site;
    if (name === "pf-demo-hvac") return { hvac: hvacFill };
    throw new Error(`unexpected request ${name}`);
  });
}

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

describe("presenceNarrowedExtractor — the composition", () => {
  test("a group with no present leaves produces no call", async () => {
    const { chat, requests } = partialPresenceChat();
    const extractor = presenceNarrowedExtractor(
      presencePhase<Values>({ groups, chat: capable(chat), model: "fake-model" }),
      { target, groups, chat, model: "fake-model" },
    );
    await extractor.extract(ctx.transcript);

    // Two presence calls (presence asks per group, always) plus ONE fill call:
    // site's map is all false, so no request ever carries its fill name.
    expect(requests.map((r) => r.response_format.json_schema.name).sort()).toEqual([
      "hvac-presence",
      "pf-demo-hvac",
      "site-presence",
    ]);
    expect(
      requests.filter((r) => r.response_format.json_schema.name === "pf-demo-site"),
    ).toHaveLength(0);
  });

  test("the absent group's key survives in the result with null envelopes — the seed's work, not the fill's", async () => {
    const { chat } = partialPresenceChat();
    const extractor = presenceNarrowedExtractor(
      presencePhase<Values>({ groups, chat: capable(chat), model: "fake-model" }),
      { target, groups, chat, model: "fake-model" },
    );
    const result = await extractor.extract(ctx.transcript);

    // `site` was never asked about, yet its key is present with every leaf at
    // the null floor — the presence phase's seed. Without the seed the closing
    // parse would reject the missing key (ADR 0009); this extract RESOLVING is
    // the pin. The inactive hvac leaf keeps its null seed the same way.
    expect(result.fields).toEqual({
      hvac: [{ fuel: hvacFill.fuel, efficiency: hvacFill.efficiency, notes: nullEnvelope() }],
      site: { yearBuilt: nullEnvelope(), orientation: nullEnvelope() },
    });
  });

  test("a failed fill item leaves that group's leaves null rather than dropping the key", async () => {
    const maps: PresenceMaps = {
      hvac: { fuel: true, efficiency: true, notes: false },
      site: { yearBuilt: true, orientation: false },
    };
    const { chat, requests } = fakeChat((name) => {
      if (name === "pf-demo-hvac") throw new Error("fill failed for hvac");
      if (name === "pf-demo-site") return { site: { yearBuilt: envelope(1950, "built in 1950") } };
      if (name === "hvac-presence") return maps.hvac;
      if (name === "site-presence") return maps.site;
      throw new Error(`unexpected request ${name}`);
    });
    // Hand-assembled rather than the preset, with `maxRetries` pinned to 0:
    // the preset exposes no engine knobs, and one attempt is the honest budget
    // for a double that always fails.
    const presence = presencePhase<Values>({ groups, chat: capable(chat), model: "fake-model" });
    const fill = presenceFillPhase<Values>({ target, groups, chat, model: "fake-model" });
    const extractor = phasedExtractor<Values>({ target, phases: [presence, fill], maxRetries: 0 });

    const result = await extractor.extract(ctx.transcript);

    // hvac's item failed under skip semantics: every leaf back at the null
    // floor, the key still present, the closing parse green — and the sibling
    // site call unaffected by the failure.
    expect(result.fields.hvac).toEqual([
      { fuel: nullEnvelope(), efficiency: nullEnvelope(), notes: nullEnvelope() },
    ]);
    expect(result.fields.site).toEqual({
      yearBuilt: envelope(1950, "built in 1950"),
      orientation: nullEnvelope(),
    });
    expect(
      requests.filter((r) => r.response_format.json_schema.name === "pf-demo-hvac"),
    ).toHaveLength(1);
    // The failed item's calls are not counted by the engine — usage sums
    // PhaseOutputs, and a failed item reports none.
    expect(result.usage.calls).toBe(3);
  });

  test("a misordered phase list is rejected at construction, naming the fill phase and its missing seeder", () => {
    const { chat } = fakeChat(() => ({}));
    const presence = presencePhase<Values>({ groups, chat: capable(chat), model: "m" });
    const fill = presenceFillPhase<Values>({ target, groups, chat, model: "m" });
    expect(() => phasedExtractor<Values>({ target, phases: [fill, presence] })).toThrow(
      /phase "fill" requires phase "presence"/,
    );

    // The preset's own construction validates the same way: a renamed presence
    // phase must be named through the fill's REPLACING requires option, or the
    // dangling default is the rejection.
    const renamed = presencePhase<Values>({
      groups,
      chat: capable(chat),
      model: "m",
      id: "presence-strict",
    });
    const options = { target, groups, chat, model: "m" };
    expect(() => presenceNarrowedExtractor(renamed, options)).toThrow(
      /phase "fill" requires phase "presence"/,
    );
    expect(() =>
      presenceNarrowedExtractor(renamed, { ...options, requires: ["presence-strict"] }),
    ).not.toThrow();
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
