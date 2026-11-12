import { z } from "zod";
import { describe, expect, test } from "vitest";

import { enveloped } from "../../provenance/enveloped.js";
import { extractGroups, nullEnvelope, presencePhase } from "../../phases/presence-phase.js";
import { phasedExtractor } from "../../phases/phased-extractor.js";
import { presenceFillPhase } from "../../phases/presence-fill-phase.js";
import { perGroupPlan } from "./per-group.js";
import type { CapableChatClient, ChatClient, ChatRequest } from "../../phases/chat-client.js";
import type { ExtractionTarget } from "../extractor.js";
import type { PhaseContext } from "../../phases/phase.js";
import type { PresenceMaps } from "../../phases/presence-phase.js";

import { presenceNarrowedExtractor } from "./presence-narrowed.js";

/**
 * Composition tests for the presence-narrowed preset: `presenceNarrowedExtractor`
 * over core's REAL `presencePhase` — the seed is the invariant under test, so a
 * hand-built stub presence phase would let the ADR 0009 pin pass for the wrong
 * reason: the test would be seeding the draft itself, which is the thing that
 * must be pinned as the presence phase's job. The phase-level tests moved with
 * the phase into `@azx/ribo-core`.
 *
 * One chat serves both phases, dispatching on the request name: presence calls
 * are `<group>-presence`, fill calls are `<target.name>-<group>`.
 */

const patchSchema = z.strictObject({
  // A collection group: the fill's array projection and the seeded
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

/** One committed leaf envelope, as a fill response carries. */
const envelope = (value: unknown, span: string): Record<string, unknown> => ({
  value,
  confidence: 0.9,
  sourceSpan: span,
});

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
          content: JSON.stringify(respond(request.responseFormat.json_schema.name)),
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
    if (name === "pf-demo-hvac") return { hvac: [hvacFill] };
    throw new Error(`unexpected request ${name}`);
  });
}

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
    expect(requests.map((r) => r.responseFormat.json_schema.name).sort()).toEqual([
      "hvac-presence",
      "pf-demo-hvac",
      "site-presence",
    ]);
    expect(
      requests.filter((r) => r.responseFormat.json_schema.name === "pf-demo-site"),
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
      requests.filter((r) => r.responseFormat.json_schema.name === "pf-demo-hvac"),
    ).toHaveLength(1);
    // The failed item's calls are not counted by the engine — usage sums
    // PhaseOutputs, and a failed item reports none.
    expect(result.usage.calls).toBe(3);
    // And the skip is REPORTED, not just absorbed (ADR 0026). Without this the
    // test passes on a run that silently drops the item: the leaves are null
    // either way, and null is also what an honest "nobody said it" looks like.
    //
    // One entry, keyed by group. This phase plans one item per GROUP — one call
    // returns every instance, so an item has no instance or piece dimension —
    // which is why `key` alone is the item's whole coordinates here, where
    // `fillPhase` needs (group, instance, piece).
    expect(result.skippedItems).toEqual([{ phaseId: "fill", key: "hvac" }]);
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

/**
 * The split caps. `perGroupExtractor` partitions a group whose serialized
 * schema exceeds `maxSerializedCharsPerGroup` across several calls; the
 * presence-narrowed fill builds its narrowed target per item, AFTER presence
 * is known, and must partition THAT the same way — an over-cap narrowed group
 * is a call the per-group path would never send, and the route refuses it.
 * These tests run a collection group whose projected schema exceeds a small
 * byte cap, so the partition is observable on the stub's requests.
 */
const bigLeaf = () => z.string().describe("d".repeat(150)).nullable().optional();
const bigSchema = z.strictObject({
  rooms: z
    .array(
      z.strictObject({
        name: bigLeaf(),
        floor: bigLeaf(),
        volume: bigLeaf(),
        windows: bigLeaf(),
        door: bigLeaf(),
        trim: bigLeaf(),
        cove: bigLeaf(),
        crown: bigLeaf(),
        casing: bigLeaf(),
        apron: bigLeaf(),
        stool: bigLeaf(),
        jamb: bigLeaf(),
      }),
    )
    .optional(),
  other: z.strictObject({ note: bigLeaf() }).optional(),
});
type BigValues = z.infer<typeof bigSchema>;

const bigTarget: ExtractionTarget<BigValues> = {
  name: "big-demo",
  extractionSchema: enveloped(bigSchema),
  instructions: "Extract the fields from the transcript.",
  examples: [],
};

const bigGroups = extractGroups(
  z.toJSONSchema(bigTarget.extractionSchema, { target: "draft-2020-12" }),
);

const BIG_CAP = 2500;
const ROOM_LEAVES = [
  "name",
  "floor",
  "volume",
  "windows",
  "door",
  "trim",
  "cove",
  "crown",
  "casing",
  "apron",
  "stool",
  "jamb",
] as const;

/** How many pieces `perGroupPlan` splits one group into under the same caps. */
function perGroupPieceCount(groupKey: string): number {
  const plan = perGroupPlan({
    target: bigTarget,
    chat: { complete: () => Promise.reject(new Error("plan construction must not dial")) },
    model: "m",
    maxSerializedCharsPerGroup: BIG_CAP,
  });
  const entry = (plan.groups as Record<string, unknown>)[groupKey];
  return Array.isArray(entry) ? entry.length : 1;
}

/** The request's one group key and the leaf keys its schema asks for. */
function askedLeaves(request: ChatRequest): { key: string; leafKeys: readonly string[] } {
  const schema = request.responseFormat.json_schema.schema;
  const properties = schema["properties"] as Record<string, unknown>;
  const [key] = Object.keys(properties);
  const value = properties[key!] as Record<string, unknown>;
  const element = value["type"] === "array" ? (value["items"] as Record<string, unknown>) : value;
  return { key: key!, leafKeys: Object.keys(element["properties"] as Record<string, unknown>) };
}

describe("presenceNarrowedExtractor — the split caps", () => {
  test("every room leaf present: the fill partitions under the byte cap exactly as per-group does, and the pieces merge back", async () => {
    const maps: PresenceMaps = {
      rooms: Object.fromEntries(ROOM_LEAVES.map((leafKey) => [leafKey, true])),
      other: { note: false },
    };
    const { chat, requests } = fakeChat((name) => {
      if (name === "rooms-presence") return maps.rooms;
      if (name === "other-presence") return maps.other;
      throw new Error(`unexpected request ${name}`);
    });
    // The fill responses must carry exactly the leaves each request's own
    // schema asks for — the piece's subset — so the stub reads them off the
    // request rather than predicting the partition.
    const fillChat: ChatClient = {
      complete: async (request) => {
        requests.push(request);
        const { key, leafKeys } = askedLeaves(request);
        const leaves = Object.fromEntries(
          leafKeys.map((leafKey) => [leafKey, envelope("v", "said so")]),
        );
        return {
          content: JSON.stringify({ [key]: [leaves, leaves] }),
          finishReason: "stop",
        };
      },
    };

    const extractor = presenceNarrowedExtractor(
      presencePhase<BigValues>({ groups: bigGroups, chat: capable(chat), model: "fake-model" }),
      {
        target: bigTarget,
        groups: bigGroups,
        chat: fillChat,
        model: "fake-model",
        maxSerializedCharsPerGroup: BIG_CAP,
      },
    );
    const result = await extractor.extract(ctx.transcript);

    const fills = requests.filter((r) => !r.responseFormat.json_schema.name.endsWith("-presence"));
    // Only rooms was present, and it was partitioned exactly as per-group
    // would partition it under the same cap.
    expect(fills).toHaveLength(perGroupPieceCount("rooms"));
    for (const request of fills) {
      const size = JSON.stringify(request.responseFormat.json_schema.schema).length;
      expect(
        size,
        `fill call "${request.responseFormat.json_schema.name}" serializes to ${size} characters`,
      ).toBeLessThan(BIG_CAP);
    }
    // The pieces tile the group's leaves exactly.
    const asked = fills.flatMap((request) => askedLeaves(request).leafKeys);
    expect(new Set(asked).size).toBe(asked.length);
    expect([...asked].sort()).toEqual([...ROOM_LEAVES].sort());

    // And the merge is total: the piece answers zip back into TWO instances,
    // each carrying every leaf — presence decided which leaves, never how
    // many instances (spike 0012), so no instance is lost across pieces.
    expect(result.fields.rooms).toEqual([
      Object.fromEntries(ROOM_LEAVES.map((leafKey) => [leafKey, envelope("v", "said so")])),
      Object.fromEntries(ROOM_LEAVES.map((leafKey) => [leafKey, envelope("v", "said so")])),
    ]);
  });

  test("only a few room leaves present: narrowing happens first — rooms still costs exactly one call", async () => {
    const maps: PresenceMaps = {
      rooms: {
        name: true,
        floor: true,
        volume: false,
        windows: false,
        door: false,
        trim: false,
        cove: false,
        crown: false,
        casing: false,
        apron: false,
        stool: false,
        jamb: false,
      },
      other: { note: false },
    };
    const { chat, requests } = fakeChat((name) => {
      if (name === "rooms-presence") return maps.rooms;
      if (name === "other-presence") return maps.other;
      if (name === "big-demo-rooms") {
        return {
          rooms: [
            { name: envelope("kitchen", "the kitchen"), floor: envelope("tile", "tile floor") },
          ],
        };
      }
      throw new Error(`unexpected request ${name}`);
    });
    const extractor = presenceNarrowedExtractor(
      presencePhase<BigValues>({ groups: bigGroups, chat: capable(chat), model: "fake-model" }),
      {
        target: bigTarget,
        groups: bigGroups,
        chat,
        model: "fake-model",
        maxSerializedCharsPerGroup: BIG_CAP,
      },
    );
    const result = await extractor.extract(ctx.transcript);

    const fills = requests.filter((r) => !r.responseFormat.json_schema.name.endsWith("-presence"));
    expect(fills).toHaveLength(1);
    expect(fills[0]!.responseFormat.json_schema.name).toBe("big-demo-rooms");
    expect(result.fields.rooms).toEqual([
      {
        name: envelope("kitchen", "the kitchen"),
        floor: envelope("tile", "tile floor"),
        ...Object.fromEntries(ROOM_LEAVES.slice(2).map((leafKey) => [leafKey, nullEnvelope()])),
      },
    ]);
  });
});
