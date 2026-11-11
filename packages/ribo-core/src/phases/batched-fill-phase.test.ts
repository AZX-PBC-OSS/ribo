import { z } from "zod";
import { describe, expect, test } from "vitest";

import { enveloped } from "../provenance/enveloped.js";
import { nullEnvelope } from "./presence-phase.js";
import { emptyDraft } from "./phase-draft.js";
import { emptyNotes } from "./phase-notes.js";
import { inventoryPhase, rosterNoteKey } from "./inventory-phase.js";
import { phasedExtractor } from "./phased-extractor.js";
import { fillPhase } from "./fill-phase.js";
import {
  MAX_NULLABLE_UNIONS_PER_CALL,
  splitExtractionSchema,
} from "../extraction/schema/split-schema.js";
import { reshapedExtractor } from "../extraction/shape/reshaped-extractor.js";
import type { DerivedExtractionShape } from "../extraction/shape/derived-shape.js";
import {
  prepareGroups,
  scopedInstanceExtractor,
} from "../extraction/scoped-instance/instance-fill.js";
import type { ChatClient, ChatCompletion, ChatRequest } from "./chat-client.js";
import type { PhaseContext } from "./phase.js";
import type { PhaseDraft } from "./phase-draft.js";
import type { ExtractionTarget } from "../extraction/extractor.js";
import type { PhaseUnit } from "../extraction/extraction-observer.js";
import type { Roster, RosterCandidate } from "../extraction/inventory-types.js";

/**
 * @file Must-fail tests for the batched fill phase (spec §6): the scoped-instance
 * extractor's `fill` option chooses per group, at plan time, between the
 * per-instance `fillPhase` and one batched call per `(group, piece)` whose
 * response elements each carry a roster `instanceId` and merge by id.
 *
 * The chats are scripted and record every request. Every chat answers BOTH the
 * batched names and the per-instance names today's default path would make,
 * so a regression fails on the assertions — the behaviour the test promises —
 * rather than on an unanswered request (the same dual-answering trick
 * `partition-prompt.test.ts`'s body table uses). The retry sleep is injected
 * away.
 */

// --- Fixture: two collections — `systems` (four leaves, partitionable) and `gadgets` (two). ---

const systemValues = z
  .object({
    make: z.string().nullable().optional(),
    fuel: z.string().nullable().optional(),
    rating: z.string().nullable().optional(),
    year: z.string().nullable().optional(),
  })
  .strict();

const gadgetValues = z
  .object({
    color: z.string().nullable().optional(),
    size: z.string().nullable().optional(),
  })
  .strict();

const patch = z
  .object({
    systems: z.array(systemValues).optional(),
    gadgets: z.array(gadgetValues).optional(),
  })
  .strict();

type Values = z.infer<typeof patch>;

const target: ExtractionTarget<Values> = {
  name: "demo",
  extractionSchema: enveloped(patch),
  instructions: "Extract the fields.",
  examples: [],
};

/** The two-part cut of `systems` the part-specific tests run under. */
const PARTITIONS = {
  systems: { identity: ["make", "fuel"], output: ["rating", "year"] },
} as const;

const env = (value: string | null, span: string | null = value) => ({
  value,
  sourceSpan: span,
  confidence: 1,
});

/** The identity part's leaves of one `systems` element, enveloped. */
const identityPart = (make: string, fuel: string | null): Record<string, unknown> => ({
  make: env(make),
  fuel: env(fuel),
});

/** The output part's leaves of one `systems` element, enveloped. */
const outputPart = (rating: string, year: string | null): Record<string, unknown> => ({
  rating: env(rating),
  year: env(year),
});

/** A whole `systems` element (both parts), enveloped. */
const systemElement = (
  make: string,
  fuel: string | null,
  rating: string,
  year: string | null,
): Record<string, unknown> => ({ ...identityPart(make, fuel), ...outputPart(rating, year) });

/** A whole `gadgets` element, enveloped. */
const gadgetElement = (color: string, size: string | null): Record<string, unknown> => ({
  color: env(color),
  size: env(size),
});

/** A batched reply body: one element per `[id, fields]` pair, in the order given. */
const batchedReply = (
  key: string,
  elements: readonly (readonly [string, Record<string, unknown>])[],
): Record<string, unknown> => ({
  [key]: elements.map(([instanceId, fields]) => ({ instanceId, ...fields })),
});

/** The two batched replies the main fixture's happy path answers with, by request name. */
const BATCHED_BODIES: Record<string, () => unknown> = {
  "demo-systems-fill-batched": () =>
    batchedReply("systems", [
      ["systems-1", systemElement("furnace", "gas", "20", "1998")],
      ["systems-2", systemElement("handler", "electric", "5", "2020")],
    ]),
  "demo-systems-fill-0-batched": () =>
    batchedReply("systems", [
      ["systems-1", identityPart("furnace", "gas")],
      ["systems-2", identityPart("handler", "electric")],
    ]),
  "demo-systems-fill-1-batched": () =>
    batchedReply("systems", [
      ["systems-1", outputPart("20", "1998")],
      ["systems-2", outputPart("5", "2020")],
    ]),
};

/**
 * The per-instance bodies today's default path answers with — kept so a run
 * parses on either path and a regression fails on the assertions.
 */
const PER_INSTANCE_BODIES: Record<string, () => unknown> = {
  "demo-systems-fill-0": () => ({ systems: systemElement("furnace", "gas", "20", "1998") }),
  "demo-systems-fill-1": () => ({ systems: systemElement("handler", "electric", "5", "2020") }),
  "demo-systems-fill-0-0": () => ({ systems: identityPart("furnace", "gas") }),
  "demo-systems-fill-0-1": () => ({ systems: identityPart("handler", "electric") }),
  "demo-systems-fill-1-0": () => ({ systems: outputPart("20", "1998") }),
  "demo-systems-fill-1-1": () => ({ systems: outputPart("5", "2020") }),
};

/** A current roster candidate; the mention span doubles as the discriminator unless given. */
const current = (
  mentionSpan: string,
  discriminator = mentionSpan,
  distinguishedBy: string | null = null,
): RosterCandidate => ({
  mentionSpan,
  discriminator,
  distinguishedBy,
  eligibility: "current",
  eligibilitySpan: null,
});

/** A roster candidate whose eligibility is not `current` — recorded nowhere. */
const removed = (mentionSpan: string, discriminator = mentionSpan): RosterCandidate => ({
  mentionSpan,
  discriminator,
  distinguishedBy: null,
  eligibility: "removed",
  eligibilitySpan: mentionSpan,
});

const TWO_SYSTEMS: Roster = {
  systems: [current("the basement furnace"), current("the attic air handler")],
};

const buildFillInstructions = (groupKey: string): string => `Fill ${groupKey}.`;

/** The injected retry sleep: record nothing, resolve immediately. */
const noDelay = (): Promise<void> => Promise.resolve();

/** Collect `onUnit` events for assertion. */
function collectUnits(): {
  events: PhaseUnit[];
  onUnit: (event: PhaseUnit) => void;
} {
  const events: PhaseUnit[] = [];
  return { events, onUnit: (e) => void events.push(e) };
}

/** A ChatClient dispatching on the request name, recording every request. */
function fakeChat(respond: (requestName: string) => unknown): {
  chat: ChatClient;
  requests: ChatRequest[];
} {
  const requests: ChatRequest[] = [];
  return {
    requests,
    chat: {
      complete: (request): Promise<ChatCompletion> => {
        requests.push(request);
        return Promise.resolve({
          content: JSON.stringify(respond(request.responseFormat.json_schema.name)),
          finishReason: "stop",
        });
      },
    },
  };
}

const requestName = (request: ChatRequest): string => request.responseFormat.json_schema.name;

/** The `instanceId` member of a batched request's element schema, navigated structurally. */
const instanceIdSchemaOf = (
  request: ChatRequest,
  key: string,
): { readonly enum?: unknown } | undefined => {
  const schema = request.responseFormat.json_schema.schema as {
    properties?: Record<string, { items?: { properties?: Record<string, { enum?: unknown }> } }>;
  };
  return schema.properties?.[key]?.items?.properties?.instanceId;
};

describe("batched fill — one call per (group, piece), keyed by roster id", () => {
  test('3.1 fill: "batched" with two current instances and no partition: exactly one fill request, whose element schema enums the roster ids', async () => {
    const { chat, requests } = fakeChat((name) => {
      const body = BATCHED_BODIES[name] ?? PER_INSTANCE_BODIES[name];
      if (body === undefined) throw new Error(`unexpected request ${name}`);
      return body();
    });

    const result = await scopedInstanceExtractor({
      target,
      chat,
      model: "m",
      inventory: async () => TWO_SYSTEMS,
      buildFillInstructions,
      fill: "batched",
      delay: noDelay,
    }).extract({ text: "the transcript", annotations: {} });

    // One batched call covers both instances; no per-instance request is made.
    expect(requests.map(requestName)).toEqual(["demo-systems-fill-batched"]);
    const instanceId = instanceIdSchemaOf(requests[0]!, "systems");
    expect(instanceId).toBeDefined();
    expect(instanceId!.enum).toEqual(["systems-1", "systems-2"]);
    expect(result.fields.systems?.map((system) => system.make.value)).toEqual([
      "furnace",
      "handler",
    ]);
  });

  test("3.2 the batched prompt lists each identity's id, mentionSpan, discriminator and distinguishedBy, and the excluded candidates as out of scope", async () => {
    const roster: Roster = {
      systems: [
        current("the furnace in the basement", "Basement furnace", "in the basement"),
        current("the air handler in the attic", "Attic air handler"),
        removed("the old boiler they ripped out", "Decommissioned boiler"),
      ],
    };
    const { chat, requests } = fakeChat((name) => {
      const body = BATCHED_BODIES[name] ?? PER_INSTANCE_BODIES[name];
      if (body === undefined) throw new Error(`unexpected request ${name}`);
      return body();
    });

    await scopedInstanceExtractor({
      target,
      chat,
      model: "m",
      inventory: async () => roster,
      buildFillInstructions,
      fill: "batched",
      delay: noDelay,
    }).extract({ text: "the transcript", annotations: {} });

    const batched = requests.find((r) => requestName(r) === "demo-systems-fill-batched");
    expect(batched).toBeDefined();
    const content = batched!.messages[0]!.content;
    expect(content).toContain("systems-1");
    expect(content).toContain("the furnace in the basement");
    expect(content).toContain("Basement furnace");
    expect(content).toContain("in the basement");
    expect(content).toContain("systems-2");
    expect(content).toContain("the air handler in the attic");
    expect(content).toContain("Attic air handler");
    expect(content).toContain("Decommissioned boiler");
    expect(content).toContain("Out of scope");
  });

  test("3.3 a roster with an excluded candidate: the enum holds exactly the current ids, and the excluded discriminator appears only in the out-of-scope section", async () => {
    const roster: Roster = {
      systems: [
        current("the basement furnace"),
        current("the attic air handler"),
        removed("the old boiler they ripped out", "Decommissioned boiler"),
      ],
    };
    const { chat, requests } = fakeChat((name) => {
      const body = BATCHED_BODIES[name] ?? PER_INSTANCE_BODIES[name];
      if (body === undefined) throw new Error(`unexpected request ${name}`);
      return body();
    });

    await scopedInstanceExtractor({
      target,
      chat,
      model: "m",
      inventory: async () => roster,
      buildFillInstructions,
      fill: "batched",
      delay: noDelay,
    }).extract({ text: "the transcript", annotations: {} });

    const batched = requests.find((r) => requestName(r) === "demo-systems-fill-batched");
    expect(batched).toBeDefined();
    // An element naming an excluded candidate is impossible by schema.
    const instanceId = instanceIdSchemaOf(batched!, "systems");
    expect(instanceId).toBeDefined();
    expect(instanceId!.enum).toEqual(["systems-1", "systems-2"]);
    // The excluded candidate is named only as out of scope, never as an identity.
    const content = batched!.messages[0]!.content;
    const outOfScopeAt = content.indexOf("Out of scope");
    expect(outOfScopeAt).toBeGreaterThanOrEqual(0);
    expect(content.slice(0, outOfScopeAt)).not.toContain("Decommissioned boiler");
    expect(content.slice(outOfScopeAt)).toContain("Decommissioned boiler");
  });

  test("3.4 a reply missing an id retries the same request, the error event names the id, and the second reply merges", async () => {
    let batchedAttempts = 0;
    const { chat, requests } = fakeChat((name) => {
      if (name === "demo-systems-fill-batched") {
        batchedAttempts += 1;
        // First attempt: systems-2 is missing. Second: the full roster.
        return batchedAttempts === 1
          ? batchedReply("systems", [["systems-1", systemElement("furnace", "gas", "20", "1998")]])
          : BATCHED_BODIES[name]!();
      }
      const body = PER_INSTANCE_BODIES[name];
      if (body === undefined) throw new Error(`unexpected request ${name}`);
      return body();
    });
    const { events, onUnit } = collectUnits();

    const result = await scopedInstanceExtractor({
      target,
      chat,
      model: "m",
      inventory: async () => TWO_SYSTEMS,
      buildFillInstructions,
      fill: "batched",
      onUnit,
      delay: noDelay,
    }).extract({ text: "the transcript", annotations: {} });

    const batchedRequests = requests.filter((r) => requestName(r) === "demo-systems-fill-batched");
    expect(batchedRequests).toHaveLength(2);
    // The retry is a re-send: the engine re-runs the same item with the same messages.
    expect(batchedRequests[1]).toEqual(batchedRequests[0]);
    const errors = events.filter((e) => e.phaseId === "batched-fill" && e.phase === "error");
    expect(errors).toHaveLength(1);
    expect(String(errors[0]!.error)).toContain("systems-2");
    expect(result.fields.systems?.map((system) => system.make.value)).toEqual([
      "furnace",
      "handler",
    ]);
  });

  test("3.5 a reply carrying one id twice retries the same way, the error event naming the duplicate", async () => {
    let batchedAttempts = 0;
    const { chat, requests } = fakeChat((name) => {
      if (name === "demo-systems-fill-batched") {
        batchedAttempts += 1;
        return batchedAttempts === 1
          ? batchedReply("systems", [
              ["systems-1", systemElement("furnace", "gas", "20", "1998")],
              ["systems-1", systemElement("furnace-again", "oil", "21", "1999")],
              ["systems-2", systemElement("handler", "electric", "5", "2020")],
            ])
          : BATCHED_BODIES[name]!();
      }
      const body = PER_INSTANCE_BODIES[name];
      if (body === undefined) throw new Error(`unexpected request ${name}`);
      return body();
    });
    const { events, onUnit } = collectUnits();

    const result = await scopedInstanceExtractor({
      target,
      chat,
      model: "m",
      inventory: async () => TWO_SYSTEMS,
      buildFillInstructions,
      fill: "batched",
      onUnit,
      delay: noDelay,
    }).extract({ text: "the transcript", annotations: {} });

    expect(requests.filter((r) => requestName(r) === "demo-systems-fill-batched")).toHaveLength(2);
    const errors = events.filter((e) => e.phaseId === "batched-fill" && e.phase === "error");
    expect(errors).toHaveLength(1);
    expect(String(errors[0]!.error)).toContain("systems-1");
    expect(String(errors[0]!.error)).toContain("duplicated");
    expect(result.fields.systems?.map((system) => system.make.value)).toEqual([
      "furnace",
      "handler",
    ]);
  });

  test("3.6 a partitioned collection: the first part's reply in reverse roster order and the second's in order both land on the right instances, with no instanceId left over", async () => {
    const { chat, requests } = fakeChat((name) => {
      // The identity part's reply lists the instances REVERSED; the output
      // part's is in roster order. Merge by id, never by arrival order.
      if (name === "demo-systems-fill-0-batched") {
        return batchedReply("systems", [
          ["systems-2", identityPart("handler", "electric")],
          ["systems-1", identityPart("furnace", "gas")],
        ]);
      }
      if (name === "demo-systems-fill-1-batched") {
        return batchedReply("systems", [
          ["systems-1", outputPart("20", "1998")],
          ["systems-2", outputPart("5", "2020")],
        ]);
      }
      const body = PER_INSTANCE_BODIES[name];
      if (body === undefined) throw new Error(`unexpected request ${name}`);
      return body();
    });

    const result = await scopedInstanceExtractor({
      target,
      chat,
      model: "m",
      inventory: async () => TWO_SYSTEMS,
      buildFillInstructions,
      partitions: PARTITIONS,
      fill: "batched",
      delay: noDelay,
    }).extract({ text: "the transcript", annotations: {} });

    // One batched call per part, each carrying its part's label line.
    expect(requests.map(requestName).sort()).toEqual([
      "demo-systems-fill-0-batched",
      "demo-systems-fill-1-batched",
    ]);
    const byName = new Map(requests.map((r) => [requestName(r), r]));
    expect(byName.get("demo-systems-fill-0-batched")!.messages[0]!.content).toContain(
      "This call covers the identity fields of systems.",
    );
    expect(byName.get("demo-systems-fill-1-batched")!.messages[0]!.content).toContain(
      "This call covers the output fields of systems.",
    );
    expect(byName.get("demo-systems-fill-0-batched")!.messages[0]!.content).toContain(
      "These systems fields are extracted in other calls, not this one: rating, year.",
    );
    expect(byName.get("demo-systems-fill-1-batched")!.messages[0]!.content).toContain(
      "These systems fields are extracted in other calls, not this one: make, fuel.",
    );

    expect(result.fields.systems).toEqual([
      { make: env("furnace"), fuel: env("gas"), rating: env("20"), year: env("1998") },
      { make: env("handler"), fuel: env("electric"), rating: env("5"), year: env("2020") },
    ]);
    expect(result.fields.systems[0]).not.toHaveProperty("instanceId");
    expect(result.fields.systems[1]).not.toHaveProperty("instanceId");
  });

  test('3.7 retries exhausted with onItemFailure: "skip": one skipped item naming group and part with no instance, and every instance carries the part\'s fields abstained', async () => {
    const { chat, requests } = fakeChat((name) => {
      // The identity part's batched call misses systems-2 on EVERY attempt.
      if (name === "demo-systems-fill-0-batched") {
        return batchedReply("systems", [["systems-1", identityPart("furnace", "gas")]]);
      }
      if (name === "demo-systems-fill-1-batched") {
        return batchedReply("systems", [
          ["systems-1", outputPart("20", "1998")],
          ["systems-2", outputPart("5", "2020")],
        ]);
      }
      const body = PER_INSTANCE_BODIES[name];
      if (body === undefined) throw new Error(`unexpected request ${name}`);
      return body();
    });

    const result = await scopedInstanceExtractor({
      target,
      chat,
      model: "m",
      inventory: async () => TWO_SYSTEMS,
      buildFillInstructions,
      partitions: PARTITIONS,
      fill: "batched",
      onItemFailure: "skip",
      delay: noDelay,
    }).extract({ text: "the transcript", annotations: {} });

    // The default two retries after the first attempt: three identical sends.
    expect(requests.filter((r) => requestName(r) === "demo-systems-fill-0-batched")).toHaveLength(
      3,
    );
    expect(result.skippedItems).toEqual([
      { phaseId: "batched-fill", key: "systems", part: 1, parts: 2 },
    ]);
    expect(result.skippedItems![0]).not.toHaveProperty("instance");
    // Both instances carry the skipped part's leaves abstained — no holes, and
    // the succeeding part's values survive the recombine.
    expect(result.fields.systems).toEqual([
      { make: nullEnvelope(), fuel: nullEnvelope(), rating: env("20"), year: env("1998") },
      { make: nullEnvelope(), fuel: nullEnvelope(), rating: env("5"), year: env("2020") },
    ]);
  });

  test("3.8 a stated-none collection plans no batched item", async () => {
    const roster: Roster = { systems: { stated: "none", span: "no systems here" } };
    const { chat, requests } = fakeChat((name) => {
      throw new Error(`unexpected request ${name}`);
    });

    const result = await scopedInstanceExtractor({
      target,
      chat,
      model: "m",
      inventory: async () => roster,
      buildFillInstructions,
      fill: "batched",
      delay: noDelay,
    }).extract({ text: "the transcript", annotations: {} });

    expect(requests).toHaveLength(0);
    expect(result.fields.systems).toEqual([]);
    // No collection had current instances, so no mode was recorded.
    expect(result.fillModes).toEqual({});
  });

  test("3.9 fill: { batchAbove: 2 }: a two-instance collection fills per-instance, a three-instance one batches", async () => {
    const roster: Roster = {
      systems: [current("the basement furnace"), current("the attic air handler")],
      gadgets: [current("g1"), current("g2"), current("g3")],
    };
    const { chat, requests } = fakeChat((name) => {
      if (name === "demo-gadgets-fill-batched") {
        return batchedReply("gadgets", [
          ["gadgets-1", gadgetElement("red", "small")],
          ["gadgets-2", gadgetElement("green", null)],
          ["gadgets-3", gadgetElement("blue", "large")],
        ]);
      }
      const body =
        PER_INSTANCE_BODIES[name] ??
        // The per-instance fallback for gadgets — today's only path.
        (
          {
            "demo-gadgets-fill-0": () => ({ gadgets: gadgetElement("red", "small") }),
            "demo-gadgets-fill-1": () => ({ gadgets: gadgetElement("green", null) }),
            "demo-gadgets-fill-2": () => ({ gadgets: gadgetElement("blue", "large") }),
          } as Record<string, () => unknown>
        )[name];
      if (body === undefined) throw new Error(`unexpected request ${name}`);
      return body();
    });

    const result = await scopedInstanceExtractor({
      target,
      chat,
      model: "m",
      inventory: async () => roster,
      buildFillInstructions,
      fill: { batchAbove: 2 },
      delay: noDelay,
    }).extract({ text: "the transcript", annotations: {} });

    expect(requests.map(requestName).sort()).toEqual([
      "demo-gadgets-fill-batched",
      "demo-systems-fill-0",
      "demo-systems-fill-1",
    ]);
    expect(result.fields.systems?.map((system) => system.make.value)).toEqual([
      "furnace",
      "handler",
    ]);
    expect(result.fields.gadgets?.map((gadget) => gadget.color.value)).toEqual([
      "red",
      "green",
      "blue",
    ]);
  });

  test("3.10 fillModes records the mode each collection used, keyed by group", async () => {
    const roster: Roster = {
      systems: [current("the basement furnace"), current("the attic air handler")],
      gadgets: [current("g1"), current("g2"), current("g3")],
    };
    const { chat } = fakeChat((name) => {
      if (name === "demo-gadgets-fill-batched") {
        return batchedReply("gadgets", [
          ["gadgets-1", gadgetElement("red", "small")],
          ["gadgets-2", gadgetElement("green", null)],
          ["gadgets-3", gadgetElement("blue", "large")],
        ]);
      }
      const body =
        PER_INSTANCE_BODIES[name] ??
        (
          {
            "demo-gadgets-fill-0": () => ({ gadgets: gadgetElement("red", "small") }),
            "demo-gadgets-fill-1": () => ({ gadgets: gadgetElement("green", null) }),
            "demo-gadgets-fill-2": () => ({ gadgets: gadgetElement("blue", "large") }),
          } as Record<string, () => unknown>
        )[name];
      if (body === undefined) throw new Error(`unexpected request ${name}`);
      return body();
    });

    const result = await scopedInstanceExtractor({
      target,
      chat,
      model: "m",
      inventory: async () => roster,
      buildFillInstructions,
      fill: { batchAbove: 2 },
      delay: noDelay,
    }).extract({ text: "the transcript", annotations: {} });

    expect(result.fillModes).toEqual({ systems: "per-instance", gadgets: "batched" });
  });

  test("3.12 the default (fill omitted): no batched phase, the same requests and fields as today, and fillModes records per-instance", async () => {
    const { chat, requests } = fakeChat((name) => {
      const body = PER_INSTANCE_BODIES[name];
      if (body === undefined) throw new Error(`unexpected request ${name}`);
      return body();
    });
    const { events, onUnit } = collectUnits();

    const result = await scopedInstanceExtractor({
      target,
      chat,
      model: "m",
      inventory: async () => TWO_SYSTEMS,
      buildFillInstructions,
      onUnit,
      delay: noDelay,
    }).extract({ text: "the transcript", annotations: {} });

    // Today's preset, composed by hand: the two phases with no filter.
    const today = fakeChat((name) => {
      const body = PER_INSTANCE_BODIES[name];
      if (body === undefined) throw new Error(`unexpected request ${name}`);
      return body();
    });
    const prepared = prepareGroups(
      target,
      splitExtractionSchema(target.extractionSchema, MAX_NULLABLE_UNIONS_PER_CALL),
    );
    const todayResult = await phasedExtractor<Values>({
      target,
      phases: [
        inventoryPhase<Values>({ inventory: async () => TWO_SYSTEMS, prepared, instanceCap: 10 }),
        fillPhase<Values>({
          target,
          chat: today.chat,
          model: "m",
          prepared,
          buildFillInstructions,
        }),
      ],
      delay: noDelay,
    }).extract({ text: "the transcript", annotations: {} });

    // The phase list is today's: the unit stream sees no batched phase.
    expect([...new Set(events.map((e) => e.phaseId))].sort()).toEqual(["fill", "inventory"]);
    expect(requests.map(requestName)).toEqual(["demo-systems-fill-0", "demo-systems-fill-1"]);
    expect(requests).toEqual(today.requests);
    expect(result.fields.systems?.map((system) => system.make.value)).toEqual([
      "furnace",
      "handler",
    ]);
    expect(result.fields).toEqual(todayResult.fields);
    expect(result.fillModes).toEqual({ systems: "per-instance" });
  });

  test('3.13 fill: "batched" over a schema whose only groups are collections: result.raw is present', async () => {
    const roster: Roster = {
      systems: [current("the basement furnace"), current("the attic air handler")],
      gadgets: [current("g1")],
    };
    const { chat, requests } = fakeChat((name) => {
      if (name === "demo-gadgets-fill-batched") {
        return batchedReply("gadgets", [["gadgets-1", gadgetElement("red", "small")]]);
      }
      const body =
        BATCHED_BODIES[name] ??
        PER_INSTANCE_BODIES[name] ??
        (
          { "demo-gadgets-fill-0": () => ({ gadgets: gadgetElement("red", "small") }) } as Record<
            string,
            () => unknown
          >
        )[name];
      if (body === undefined) throw new Error(`unexpected request ${name}`);
      return body();
    });

    const result = await scopedInstanceExtractor({
      target,
      chat,
      model: "m",
      inventory: async () => roster,
      buildFillInstructions,
      fill: "batched",
      delay: noDelay,
    }).extract({ text: "the transcript", annotations: {} });

    // Every fill was a batched one — with only collection groups, the
    // per-instance phase planned nothing, so `raw` exists only if the batched
    // merge wrote it.
    expect(requests.map(requestName).sort()).toEqual([
      "demo-gadgets-fill-batched",
      "demo-systems-fill-batched",
    ]);
    expect(result.raw).toBeDefined();
    const raw = result.raw as Record<string, unknown>;
    expect(Array.isArray(raw.systems)).toBe(true);
    expect(Array.isArray(raw.gadgets)).toBe(true);
  });

  test("3.14 reshapedExtractor forwards the scoped-instance extractor's fillModes unchanged", async () => {
    // The identity shape: no operations, so the mapping is the group's own keys.
    const shape = {
      extractionSchema: enveloped(patch),
      patchSchema: patch,
      mapping: {
        leaves: {
          "systems.make": { source: "systems.make" },
          "systems.fuel": { source: "systems.fuel" },
          "systems.rating": { source: "systems.rating" },
          "systems.year": { source: "systems.year" },
          "gadgets.color": { source: "gadgets.color" },
          "gadgets.size": { source: "gadgets.size" },
        },
        provenance: {},
      },
      provenance: {},
      requiredOnCreate: {},
      identifyingFields: {},
      partitions: {},
    } satisfies DerivedExtractionShape;
    const { chat } = fakeChat((name) => {
      const body = BATCHED_BODIES[name] ?? PER_INSTANCE_BODIES[name];
      if (body === undefined) throw new Error(`unexpected request ${name}`);
      return body();
    });

    const inner = scopedInstanceExtractor<Values>({
      target,
      chat,
      model: "m",
      inventory: async () => TWO_SYSTEMS,
      buildFillInstructions,
      fill: "batched",
      delay: noDelay,
    });
    const result = await reshapedExtractor<Values, Values>(inner, shape).extract({
      text: "the transcript",
      annotations: {},
    });

    expect(result.fillModes).toEqual({ systems: "batched" });
    expect(result.fields.systems?.map((system) => system.make.value)).toEqual([
      "furnace",
      "handler",
    ]);
  });
});

test("a collection whose element has its own instanceId leaf is refused by name, not silently overwritten", async () => {
  const clashing = z
    .object({
      tags: z
        .array(
          z
            .object({
              instanceId: z.string().nullable().optional(),
              label: z.string().nullable().optional(),
            })
            .strict(),
        )
        .optional(),
    })
    .strict();
  const { chat, requests } = fakeChat(() => ({}));

  const run = scopedInstanceExtractor<z.infer<typeof clashing>>({
    target: {
      name: "demo",
      extractionSchema: enveloped(clashing),
      instructions: "Extract the fields.",
      examples: [],
    },
    chat,
    model: "m",
    inventory: async () => ({ tags: [current("t1"), current("t2")] }),
    buildFillInstructions,
    fill: "batched",
    delay: noDelay,
  }).extract({ text: "the transcript", annotations: {} });

  await expect(run).rejects.toThrow(/"tags".*instanceId/);
  expect(requests).toHaveLength(0);
});

describe("fillPhase — includeGroup", () => {
  // A singleton beside the collection, so the "never filtered" half has a subject.
  const phasePatch = z
    .object({
      systems: z.array(systemValues).optional(),
      house: z.object({ color: z.string().nullable().optional() }).strict().optional(),
    })
    .strict();
  type PhaseValues = z.infer<typeof phasePatch>;
  const phaseTarget: ExtractionTarget<PhaseValues> = {
    name: "demo-phase",
    extractionSchema: enveloped(phasePatch),
    instructions: "Extract the fields.",
    examples: [],
  };
  const phasePrepared = prepareGroups(
    phaseTarget,
    splitExtractionSchema(phaseTarget.extractionSchema, MAX_NULLABLE_UNIONS_PER_CALL),
  );
  const phaseCtx: PhaseContext<PhaseValues> = {
    transcript: { text: "the transcript", annotations: {} },
    target: phaseTarget,
  };
  const phaseDraft = (roster: Roster): PhaseDraft<PhaseValues> => ({
    ...emptyDraft<PhaseValues>(),
    notes: emptyNotes().set(rosterNoteKey, roster),
  });
  /** The item type is existentially hidden; recover what the encoding hides for assertions. */
  const jobOf = (item: unknown): { requestName: string } => item as { requestName: string };

  test("3.11 includeGroup returning false for a collection plans no job for it, and singletons are never filtered (regression pin for the singleton half)", () => {
    const phase = fillPhase<PhaseValues>({
      target: phaseTarget,
      chat: {} as ChatClient,
      model: "m",
      prepared: phasePrepared,
      buildFillInstructions,
      includeGroup: () => false,
    });

    phase.with((def) => {
      const names = def
        .plan(phaseDraft({ systems: [current("a"), current("b")] }), phaseCtx)
        .map(jobOf)
        .map((job) => job.requestName);
      expect(names.filter((name) => name.startsWith("demo-phase-systems"))).toEqual([]);
      expect(names).toContain("demo-phase-house-fill");
    });
  });
});
