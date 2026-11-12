import { describe, expect, test } from "vitest";
import { z } from "zod";

import {
  extractGroups,
  perGroupPlan,
  presenceNarrowedExtractor,
  presencePhase,
} from "@azx/ribo-core";
import type { ChatClient, ChatRequest, ExtractionTarget } from "@azx/ribo-core";

import { SCHEMA_SERIALIZED_CHAR_CAP, snuggExtractionSchema, type SnuggValues } from "./schema.js";

/**
 * The presence-narrowed fill must honour the same split caps the per-group
 * strategy honours: under the Helix route's vendor cap
 * (`SCHEMA_SERIALIZED_CHAR_CAP`), `perGroupPlan` partitions `basedata` into
 * several pieces — an unpartitioned `basedata` serializes far past the cap and
 * the route refuses it with a 400. The presence-narrowed fill narrows to the
 * same group and, when every leaf is present, narrows to nothing — so its one
 * call per group is the over-cap call the per-group path never sends. These
 * tests pin the rule on the real Snugg Pro schema with a recording chat stub.
 *
 * No test makes a model call; the stub dispatches on the request's own
 * `json_schema.name` (presence calls are `<group>-presence`, fill calls are
 * `<target.name>-<group>`).
 */

const MODEL = "fake-model";

const target: ExtractionTarget<SnuggValues> = {
  name: "snugg",
  extractionSchema: snuggExtractionSchema,
  instructions: "Extract the fields from the transcript.",
  examples: [],
};

const transcript = {
  text: "the house is a two-storey colonial, gas heat, built in 1950",
  annotations: {},
};

const groups = extractGroups(z.toJSONSchema(snuggExtractionSchema, { target: "draft-2020-12" }));

const basedataLeaves =
  groups.find((group) => group.key === "basedata")?.leaves.map((leaf) => leaf.key) ?? [];

/** One committed leaf envelope, as a fill response carries. */
const envelope = { value: null, confidence: 0.9, sourceSpan: "the transcript says so" };

/** The seed's floor, as the merge writes an inactive leaf. */
const nullEnvelope = { value: null, confidence: 0, sourceSpan: null };

/** A plan-construction chat that must never be called: the plan is a dry run. */
const neverChat: ChatClient = {
  complete: (request: ChatRequest) => {
    throw new Error(`perGroupPlan construction dialled ${request.responseFormat.json_schema.name}`);
  },
};

/** The request's one group key, its leaf keys, and whether the group is a collection. */
function pieceOf(request: ChatRequest): {
  key: string;
  leafKeys: readonly string[];
  collection: boolean;
} {
  const schema = request.responseFormat.json_schema.schema;
  const properties = schema["properties"] as Record<string, unknown>;
  const keys = Object.keys(properties);
  if (keys.length !== 1) {
    throw new Error(`expected a one-key fill schema, got [${keys.join(", ")}]`);
  }
  const key = keys[0]!;
  const value = properties[key] as Record<string, unknown>;
  const collection = value["type"] === "array";
  const element = collection ? (value["items"] as Record<string, unknown>) : value;
  return {
    key,
    leafKeys: Object.keys(element["properties"] as Record<string, unknown>),
    collection,
  };
}

/**
 * A recording chat: answers each presence call with the map built from
 * `present`, and each fill call with a committed envelope for exactly the
 * leaves the request's own schema asks for — two instances for a collection,
 * so a partitioned collection piece has somewhere to land. Every request is
 * recorded in order.
 */
function recordingChat(presenceMaps: (groupKey: string) => Record<string, boolean>): {
  chat: ChatClient;
  requests: ChatRequest[];
} {
  const requests: ChatRequest[] = [];
  return {
    requests,
    chat: {
      complete: async (request) => {
        requests.push(request);
        const name = request.responseFormat.json_schema.name;
        if (name.endsWith("-presence")) {
          const groupKey = name.slice(0, -"-presence".length);
          return { content: JSON.stringify(presenceMaps(groupKey)), finishReason: "stop" };
        }
        const { key, leafKeys, collection } = pieceOf(request);
        const leaves = Object.fromEntries(leafKeys.map((leafKey) => [leafKey, envelope]));
        return {
          content: JSON.stringify(collection ? { [key]: [leaves, leaves] } : { [key]: leaves }),
          finishReason: "stop",
        };
      },
    },
  };
}

/** `presencePhase` speaks `CapableChatClient`; wrap the recording fake for it. */
const capable = (chat: ChatClient) => ({
  ...chat,
  engine: "fake-engine",
  capability: () => Promise.resolve({ status: "ready" as const }),
});

/** Presence maps with `present` deciding per group; basedata's leaves are the knobs. */
const presenceAnswer = (present: (leafKey: string) => boolean) => (groupKey: string) => {
  const group = groups.find((g) => g.key === groupKey);
  if (group === undefined) throw new Error(`unexpected presence group ${groupKey}`);
  return Object.fromEntries(
    group.leaves.map((leaf) => [leaf.key, groupKey === "basedata" && present(leaf.key)]),
  );
};

/** How many pieces `perGroupPlan` splits one group into under the byte cap. */
function perGroupPieceCount(groupKey: string): number {
  const plan = perGroupPlan({
    target,
    chat: neverChat,
    model: MODEL,
    maxSerializedCharsPerGroup: SCHEMA_SERIALIZED_CHAR_CAP,
  });
  const entry = (plan.groups as Record<string, unknown>)[groupKey];
  return Array.isArray(entry) ? entry.length : 1;
}

describe("the presence-narrowed fill honours the per-group split caps (real Snugg schema)", () => {
  test("every basedata leaf present: basedata is filled across the pieces per-group would use, each under the byte cap", async () => {
    const { chat, requests } = recordingChat(presenceAnswer(() => true));
    const extractor = presenceNarrowedExtractor(
      presencePhase({ groups, chat: capable(chat), model: MODEL }),
      {
        target,
        groups,
        chat,
        model: MODEL,
        maxSerializedCharsPerGroup: SCHEMA_SERIALIZED_CHAR_CAP,
      },
    );
    const result = await extractor.extract(transcript);

    const fills = requests.filter((r) => !r.responseFormat.json_schema.name.endsWith("-presence"));
    // Only basedata was marked present: every fill call is a basedata call.
    expect(
      fills.map((r) => r.responseFormat.json_schema.name),
      JSON.stringify(fills.map((r) => r.responseFormat.json_schema.name)),
    ).toEqual(
      fills
        .filter((r) => r.responseFormat.json_schema.name.startsWith("snugg-basedata"))
        .map((r) => r.responseFormat.json_schema.name),
    );

    // THE CAP: no call's serialized schema exceeds the vendor ceiling — the
    // property the per-group path guarantees and the fill path must too.
    for (const request of fills) {
      const size = JSON.stringify(request.responseFormat.json_schema.schema).length;
      expect(
        size,
        `fill call "${request.responseFormat.json_schema.name}" serializes to ${size} characters`,
      ).toBeLessThan(SCHEMA_SERIALIZED_CHAR_CAP);
    }

    // THE PARTITION: the same pieces per-group would partition the group into.
    expect(fills).toHaveLength(perGroupPieceCount("basedata"));

    // The pieces tile the group's leaves exactly — nothing lost, nothing duplicated.
    const asked = fills.flatMap((request) => pieceOf(request).leafKeys);
    expect(new Set(asked).size).toBe(asked.length);
    expect([...asked].sort()).toEqual([...basedataLeaves].sort());

    // And the merge is total: every basedata leaf comes back filled.
    expect((result.fields as Record<string, unknown>)["basedata"]).toEqual(
      Object.fromEntries(basedataLeaves.map((leafKey) => [leafKey, envelope])),
    );
  });

  test("only a few basedata leaves present: narrowing happens first — basedata still costs exactly one call", async () => {
    const few = new Set(basedataLeaves.slice(0, 2));
    const { chat, requests } = recordingChat(presenceAnswer((leafKey) => few.has(leafKey)));
    const extractor = presenceNarrowedExtractor(
      presencePhase({ groups, chat: capable(chat), model: MODEL }),
      {
        target,
        groups,
        chat,
        model: MODEL,
        maxSerializedCharsPerGroup: SCHEMA_SERIALIZED_CHAR_CAP,
      },
    );
    const result = await extractor.extract(transcript);

    const fills = requests.filter((r) => !r.responseFormat.json_schema.name.endsWith("-presence"));
    expect(fills).toHaveLength(1);
    expect(fills[0]!.responseFormat.json_schema.name).toBe("snugg-basedata");

    // The two present leaves carry the answer; every other leaf stays at the
    // seed's null floor.
    const expected: Record<string, unknown> = {};
    for (const leafKey of basedataLeaves) {
      expected[leafKey] = few.has(leafKey) ? envelope : nullEnvelope;
    }
    expect((result.fields as Record<string, unknown>)["basedata"]).toEqual(expected);
  });
});
