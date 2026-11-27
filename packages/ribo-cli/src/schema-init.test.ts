import type { ChatClient, ChatRequest } from "@azx/ribo-core";
import { expect, test, vi } from "vitest";

import { convertDocument } from "./inspect/convert.js";
import { walkFieldInventory } from "./inspect/field-inventory.js";
import { initSchema } from "./index.js";
import type { SchemaInitSample, SchemaInitSampleInput } from "./index.js";
import { OperatorError } from "./operator/error.js";

const sample = (
  name: string,
  kind: SchemaInitSampleInput["kind"],
  text: string,
): SchemaInitSample => ({
  name,
  inputs: [
    {
      path: `/samples/${name}.txt`,
      file: `${name}.txt`,
      kind,
      text,
      bytes: new TextEncoder().encode(text),
    },
  ],
  text,
});

const evidence = (source: string, quote: string) => ({ source, quote });
const property = (name: string, node: unknown) => ({ name, node });
const object = (description: string, properties: readonly unknown[]) => ({
  kind: "object",
  description,
  properties,
});
const leaf = (
  kind: "string" | "number" | "boolean",
  description: string,
  source: string,
  quote: string,
  extra: Readonly<Record<string, unknown>> = {},
) => ({
  kind,
  description,
  evidence: evidence(source, quote),
  ...extra,
});

function scriptedChat(contents: readonly string[]): {
  readonly chat: ChatClient;
  readonly requests: ChatRequest[];
} {
  const requests: ChatRequest[] = [];
  return {
    requests,
    chat: {
      async complete(request) {
        requests.push(request);
        const content = contents[requests.length - 1];
        if (content === undefined) throw new Error("unexpected schema-init call");
        return { content };
      },
    },
  };
}

const createdAt = "2026-10-01T02:03:04.000Z";
const options = (chat: ChatClient, clock: () => Date = () => new Date(createdAt)) => ({
  chat,
  model: "stub-schema-author",
  clock,
});

const notesText = "Address: 12 High Street\nNickname: The Cottage\nStatus: active";
const rosterText = "Kitchen\nArea: 12.5 m²\noccupied\nNext status: pending";
const notes = sample("field-notes", "text", notesText);
const roster = sample("roster", "transcript", rosterText);

const mergedProposal = {
  root: object("A reviewable draft grounded in the named samples.", [
    property(
      "home",
      object("Home identity and observed state.", [
        property("address", leaf("string", "Street address.", "field-notes", "12 High Street")),
        property(
          "nickname",
          leaf("string", "Household nickname.", "field-notes", "The Cottage", {
            optional: true,
          }),
        ),
        property(
          "status",
          leaf("string", "Observed workflow state.", "field-notes", "Status: active", {
            optional: true,
            enum: [
              { value: "active", evidence: evidence("field-notes", "active") },
              { value: "pending", evidence: evidence("roster", "pending") },
            ],
          }),
        ),
      ]),
    ),
    property("rooms", {
      kind: "collection",
      description: "Rooms observed in the roster.",
      items: object("One observed room.", [
        property("name", leaf("string", "Room name.", "roster", "Kitchen")),
        property(
          "area",
          leaf("number", "Measured floor area.", "roster", "12.5 m²", { optional: true }),
        ),
        property(
          "occupied",
          leaf("boolean", "Whether the room was occupied.", "roster", "occupied"),
        ),
      ]),
    }),
  ]),
};
const mergedReply = JSON.stringify(mergedProposal);

test("multi-sample declarations merge into described OpenAPI objects and collections with conservative enums", async () => {
  const clock = vi.fn(() => new Date(createdAt));
  const originalSamples = structuredClone([notes, roster]);
  const { chat, requests } = scriptedChat([mergedReply]);

  const draft = await initSchema([notes, roster], options(chat, clock));

  expect(requests).toHaveLength(1);
  expect(requests[0]!.model).toBe("stub-schema-author");
  expect(clock).toHaveBeenCalledTimes(1);
  expect(draft.provenance).toEqual({ model: "stub-schema-author", createdAt });
  expect(draft.proposal).toEqual(mergedProposal);
  expect([notes, roster]).toEqual(originalSamples);

  expect(draft.document).toMatchObject({
    type: "object",
    description: "A reviewable draft grounded in the named samples.",
    required: ["home", "rooms"],
    properties: {
      home: {
        type: "object",
        description: "Home identity and observed state.",
        required: ["address"],
        properties: {
          address: { type: "string", description: "Street address." },
          nickname: {
            type: "string",
            description: "Household nickname.",
            nullable: true,
          },
          status: {
            type: "string",
            description: "Observed workflow state.",
            enum: ["active", "pending"],
            nullable: true,
          },
        },
      },
      rooms: {
        type: "array",
        description: "Rooms observed in the roster.",
        items: {
          type: "object",
          description: "One observed room.",
          required: ["name", "occupied"],
          properties: {
            name: { type: "string", description: "Room name." },
            area: {
              type: "number",
              description: "Measured floor area.",
              nullable: true,
            },
            occupied: { type: "boolean", description: "Whether the room was occupied." },
          },
        },
      },
    },
  });
  expect(draft.document).toHaveProperty("properties.home.required", ["address"]);
  expect(draft.document).toHaveProperty("properties.rooms.items.required", ["name", "occupied"]);
  expect(draft.document).not.toHaveProperty("properties.home.properties.address.nullable");
  expect(draft.document).not.toHaveProperty("properties.rooms.nullable");
});

test("every successful draft passes inspect conversion and field walking without envelopes or unsupported nullability", async () => {
  const { chat } = scriptedChat([mergedReply]);

  const draft = await initSchema([notes, roster], options(chat));
  const inventory = walkFieldInventory(convertDocument(draft.document));

  expect(inventory.map((entry) => entry.path)).toEqual([
    "home.address",
    "home.nickname",
    "home.status",
    "rooms.name",
    "rooms.area",
    "rooms.occupied",
  ]);
  expect(inventory.map((entry) => entry.kind)).toEqual([
    "string",
    "string",
    "enum",
    "string",
    "number",
    "boolean",
  ]);
  expect(inventory[2]).toMatchObject({
    description: "Observed workflow state.",
    values: ["active", "pending"],
  });
  expect(inventory.filter((entry) => entry.inArray).map((entry) => entry.path)).toEqual([
    "rooms.name",
    "rooms.area",
    "rooms.occupied",
  ]);

  const serialized = JSON.stringify(draft.document);
  for (const forbidden of [
    "sourceSpan",
    "extractedSchema",
    "evidence",
    "anyOf",
    "oneOf",
    '"type":"null"',
    '"type":["',
    "$schema",
  ]) {
    expect(serialized).not.toContain(forbidden);
  }
});

test("initial prompts carry each named sample verbatim, the closed declaration contract and no completeness claim", async () => {
  const direct = sample("layout", "text", "  first line\r\n\tsecond line\n");
  const valid = {
    root: object("A small draft.", [
      property("first", leaf("string", "First line.", "layout", "  first line\r\n\tsecond line\n")),
    ]),
  };
  const { chat, requests } = scriptedChat([JSON.stringify(valid)]);

  await initSchema([direct], options(chat));

  const prompt = requests[0]!.messages.map((message) => message.content).join("\n");
  expect(prompt).toContain(direct.text);
  expect(prompt).toContain("layout");
  expect(prompt).toContain("collection");
  expect(prompt).toContain("evidence");
  expect(prompt).toContain("conservative");
  expect(prompt).toContain("not a completeness claim");
  expect(prompt).not.toMatch(/extract every field|all fields|complete schema/iu);
  expect(requests[0]!.responseFormat.json_schema.name).toBe("ribo_schema_init");
  // A strict response format is rejected by strict transports unless every property is required.
  const format = requests[0]!.responseFormat.json_schema;
  if (format.strict === true) {
    // `properties` and `$defs` map names to schemas; only a schema's own members are checked.
    const optionalSomewhere = (node: unknown): boolean => {
      if (Array.isArray(node)) return node.some(optionalSomewhere);
      if (node === null || typeof node !== "object") return false;
      const record = node as Record<string, unknown>;
      return Object.entries(record).some(([key, value]) => {
        if (
          (key === "properties" || key === "$defs") &&
          value !== null &&
          typeof value === "object"
        ) {
          const schemas = Object.entries(value as Record<string, unknown>);
          if (key === "properties") {
            const required = new Set((record["required"] as string[] | undefined) ?? []);
            if (schemas.some(([name]) => !required.has(name))) return true;
          }
          return schemas.some(([, schema]) => optionalSomewhere(schema));
        }
        return optionalSomewhere(value);
      });
    };
    expect(optionalSomewhere(format.schema)).toBe(false);
  }
});

test("initial prompts list ordered input files and kinds and forbid marker or cross-input evidence", async () => {
  const mixed: SchemaInitSample = {
    name: "spoken-case",
    inputs: [
      {
        path: "/samples/spoken-case/input.pdf",
        file: "input.pdf",
        kind: "document",
        text: "Chain replaced",
        bytes: new Uint8Array([1]),
      },
      {
        path: "/samples/spoken-case/note.txt",
        file: "note.txt",
        kind: "text",
        text: "No additional observations.",
        bytes: new TextEncoder().encode("No additional observations."),
      },
    ],
    text: "joined",
  };
  const valid = {
    root: object("A small draft.", [
      property("first", leaf("string", "First line.", "spoken-case", "Chain replaced")),
    ]),
  };
  const { chat, requests } = scriptedChat([JSON.stringify(valid)]);

  await initSchema([mixed], options(chat));

  const prompt = requests[0]!.messages.map((message) => message.content).join("\n");
  // The prompt lists each input and kind, in declared order.
  expect(prompt).toContain(
    'name: "spoken-case"; inputs in order: input.pdf (document), note.txt (text)',
  );
  // And tells the model what a quote may and may not span.
  expect(prompt).toContain("a quote must come from inside one capture");
  expect(prompt).toContain("never quote a marker line");
  expect(prompt).toContain("never quote across two inputs");
});

test("a valid first reply needs no repair and the two repair turns are bounded and named", async () => {
  const first = scriptedChat([mergedReply]);
  await initSchema([notes, roster], options(first.chat));
  expect(first.requests).toHaveLength(1);

  const repaired = scriptedChat(["bad one", "bad two", mergedReply]);
  await initSchema([notes, roster], options(repaired.chat));
  expect(repaired.requests).toHaveLength(3);
  expect(repaired.requests[1]!.messages.at(-1)!.content).toContain("Repair 1");
  expect(repaired.requests[2]!.messages.at(-1)!.content).toContain("Repair 2");
  expect(repaired.requests[1]!.messages.at(-2)!.content).toBe("bad one");
  expect(repaired.requests[2]!.messages.at(-2)!.content).toBe("bad two");
  expect(repaired.requests[2]!.messages.at(-1)!.content).toContain("malformed JSON");
});

test("ambiguous or empty named-sample input refuses before model or clock work", async () => {
  const duplicate = sample("field-notes", "transcript", "Chain replaced");
  const { chat, requests } = scriptedChat([mergedReply]);
  const clock = vi.fn(() => new Date(createdAt));

  await expect(initSchema([notes, duplicate], options(chat, clock))).rejects.toThrow(OperatorError);
  await expect(initSchema([], options(chat, clock))).rejects.toThrow(/at least one sample/iu);
  expect(requests).toHaveLength(0);
  expect(clock).not.toHaveBeenCalled();
});
