import { z } from "zod";
import { describe, expect, test } from "vitest";

import { enveloped } from "../../provenance/enveloped.js";
import type { ChatClient, ChatCompletion, ChatRequest } from "../../phases/chat-client.js";
import type { ExtractionTarget } from "../extractor.js";
import type { Roster } from "../scoped-instance/instance-fill.js";
import { scopedInstanceExtractor } from "../scoped-instance/instance-fill.js";
import { perGroupExtractor } from "./per-group.js";
import { schemaExtractor } from "./schema-extractor.js";

/**
 * @file A labelled piece's request carries the partition's label line — under
 * the per-group strategy, the scoped-instance fills, and the schemaExtractor
 * forcing rule (spec §5). The chats are scripted and record every request.
 */

const leaf = (description: string) => z.string().nullable().optional().describe(description);

const patch = z
  .object({
    basedata: z
      .object({
        yearBuilt: leaf("when the house was built"),
        storeys: leaf("number of storeys"),
        externalWall: leaf("external wall construction"),
        floorType: leaf("ground floor type"),
      })
      .strict()
      .optional(),
    systems: z
      .array(
        z
          .object({
            make: leaf("system make"),
            fuel: leaf("system fuel"),
            ratingKw: leaf("output rating in kW"),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

const schema = enveloped(patch);
type Values = z.infer<typeof patch>;

const target: ExtractionTarget<Values> = {
  name: "demo",
  extractionSchema: schema,
  instructions: "Extract the fields.",
  examples: [],
};

const PARTITIONS = {
  basedata: { envelope: ["yearBuilt", "storeys"], comfort: ["externalWall", "floorType"] },
} as const;
const SYSTEM_PARTITIONS = {
  systems: { identity: ["make", "fuel"], output: ["ratingKw"] },
} as const;

const env = (value: string | null, span: string | null) => ({
  value,
  sourceSpan: span,
  confidence: 1,
});

/** Envelope values for the named leaves — extraction responses parse with these. */
const leaves = (...names: readonly string[]): Record<string, unknown> =>
  Object.fromEntries(names.map((name) => [name, env(null, null)]));

const current = (discriminator: string) => ({
  mentionSpan: discriminator,
  discriminator,
  distinguishedBy: null,
  eligibility: "current",
  eligibilitySpan: null,
});

/**
 * Response bodies by request name, covering both the unsplit names (today's
 * behaviour) and the per-part names (after the split honours partitions), so a
 * scripted run parses under either and the assertions land on the cut and the
 * label line, not on a parse error.
 */
const BODIES: Record<string, string> = {
  demo: JSON.stringify({
    basedata: leaves("yearBuilt", "storeys", "externalWall", "floorType"),
    systems: [leaves("make", "fuel", "ratingKw")],
  }),
  "demo-basedata": JSON.stringify({
    basedata: leaves("yearBuilt", "storeys", "externalWall", "floorType"),
  }),
  "demo-basedata-0": JSON.stringify({ basedata: leaves("yearBuilt", "storeys") }),
  "demo-basedata-1": JSON.stringify({ basedata: leaves("externalWall", "floorType") }),
  "demo-systems": JSON.stringify({ systems: [leaves("make", "fuel", "ratingKw")] }),
};

function fakeChat(respond: (request: ChatRequest) => ChatCompletion): {
  chat: ChatClient;
  requests: ChatRequest[];
} {
  const requests: ChatRequest[] = [];
  return {
    requests,
    chat: {
      complete: (request) => {
        requests.push(request);
        return Promise.resolve(respond(request));
      },
    },
  };
}

const requestName = (request: ChatRequest): string => request.response_format.json_schema.name;
const bodyChat = (): { chat: ChatClient; requests: ChatRequest[] } =>
  fakeChat((request) => ({
    content: BODIES[requestName(request)] ?? "{}",
    finishReason: "stop",
  }));

describe("partition prompts", () => {
  test("2.7 perGroupExtractor with a partitioned group: each piece's request carries its label line, and an unpartitioned group's request does not", async () => {
    const { chat, requests } = bodyChat();

    await perGroupExtractor({
      target,
      chat,
      model: "m",
      partitions: PARTITIONS,
    }).extract({ text: "the transcript", annotations: {} });

    expect(requests.map(requestName).sort()).toEqual([
      "demo-basedata-0",
      "demo-basedata-1",
      "demo-systems",
    ]);
    const byName = new Map(requests.map((r) => [requestName(r), r]));
    expect(byName.get("demo-basedata-0")!.messages[0]!.content).toContain(
      "This call covers the envelope fields of basedata.",
    );
    expect(byName.get("demo-basedata-1")!.messages[0]!.content).toContain(
      "This call covers the comfort fields of basedata.",
    );
    expect(byName.get("demo-systems")!.messages[0]!.content).not.toContain("This call covers");
  });

  test("2.8 scopedInstanceExtractor with a roster of two instances and a partitioned collection: every per-instance request carries its piece's label line", async () => {
    const roster: Roster = {
      systems: [current("the x system"), current("the y system")],
    };
    const fillBodies: Record<string, string> = {
      "demo-basedata-fill": JSON.stringify({
        basedata: leaves("yearBuilt", "storeys", "externalWall", "floorType"),
      }),
      "demo-systems-fill-0": JSON.stringify({ systems: leaves("make", "fuel", "ratingKw") }),
      "demo-systems-fill-1": JSON.stringify({ systems: leaves("make", "fuel", "ratingKw") }),
      "demo-systems-fill-0-0": JSON.stringify({ systems: leaves("make", "fuel") }),
      "demo-systems-fill-0-1": JSON.stringify({ systems: leaves("make", "fuel") }),
      "demo-systems-fill-1-0": JSON.stringify({ systems: leaves("ratingKw") }),
      "demo-systems-fill-1-1": JSON.stringify({ systems: leaves("ratingKw") }),
    };
    const { chat, requests } = fakeChat((request) => ({
      content: fillBodies[requestName(request)] ?? "{}",
      finishReason: "stop",
    }));

    await scopedInstanceExtractor({
      target,
      chat,
      model: "m",
      inventory: async () => roster,
      buildFillInstructions: (key, scope) => `Fill ${key} for ${scope.positive.discriminator}.`,
      partitions: SYSTEM_PARTITIONS,
    }).extract({ text: "the transcript", annotations: {} });

    // Two parts x two instances, plus the unpartitioned singleton's one fill.
    const fillRequests = requests.filter((r) => requestName(r).startsWith("demo-systems-fill-"));
    expect(fillRequests).toHaveLength(4);
    for (const request of fillRequests) {
      const name = requestName(request);
      const part = Number(/-fill-(\d+)-\d+$/.exec(name)![1]);
      const labelLine =
        part === 0
          ? "This call covers the identity fields of systems."
          : "This call covers the output fields of systems.";
      expect(request.messages[0]!.content, name).toContain(labelLine);
    }
    // The unpartitioned singleton's fill carries no label line.
    const singleton = requests.find((r) => requestName(r) === "demo-basedata-fill");
    expect(singleton).toBeDefined();
    expect(singleton!.messages[0]!.content).not.toContain("This call covers");
  });

  test("scopedInstanceExtractor with a partitioned object group: each part's fill request carries its label line", async () => {
    const fillBodies: Record<string, string> = {
      "demo-basedata-fill-0": JSON.stringify({ basedata: leaves("yearBuilt", "storeys") }),
      "demo-basedata-fill-1": JSON.stringify({ basedata: leaves("externalWall", "floorType") }),
    };
    const { chat, requests } = fakeChat((request) => ({
      content: fillBodies[requestName(request)] ?? "{}",
      finishReason: "stop",
    }));

    await scopedInstanceExtractor({
      target,
      chat,
      model: "m",
      inventory: async () => ({ systems: [] }),
      buildFillInstructions: (key) => `Fill ${key}.`,
      partitions: PARTITIONS,
    }).extract({ text: "the transcript", annotations: {} });

    const byName = new Map(requests.map((r) => [requestName(r), r]));
    expect(byName.get("demo-basedata-fill-0")?.messages[0]!.content).toContain(
      "This call covers the envelope fields of basedata.",
    );
    expect(byName.get("demo-basedata-fill-1")?.messages[0]!.content).toContain(
      "This call covers the comfort fields of basedata.",
    );
  });

  test("2.9 schemaExtractor: without partitions a fitting schema makes one call (regression pin); with them it makes one call per part", async () => {
    const plain = bodyChat();
    await schemaExtractor<Values>({
      extractionSchema: schema,
      name: "demo",
      instructions: "Extract the fields.",
      chat: plain.chat,
      model: "m",
    }).extract({ text: "the transcript", annotations: {} });
    expect(plain.requests).toHaveLength(1);

    const partitioned = bodyChat();
    await schemaExtractor<Values>({
      extractionSchema: schema,
      name: "demo",
      instructions: "Extract the fields.",
      chat: partitioned.chat,
      model: "m",
      partitions: PARTITIONS,
    }).extract({ text: "the transcript", annotations: {} });

    expect(partitioned.requests.map(requestName).sort()).toEqual([
      "demo-basedata-0",
      "demo-basedata-1",
      "demo-systems",
    ]);
  });
});
