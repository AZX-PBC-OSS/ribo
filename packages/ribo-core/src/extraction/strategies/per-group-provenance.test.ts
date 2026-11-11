import { enveloped } from "../../provenance/enveloped.js";
import type { ChatClient, ChatRequest } from "../../phases/chat-client.js";
import type { ExtractionTarget } from "../extractor.js";
import { z } from "zod";
import { expect, test } from "vitest";

import { perGroupExtractor } from "./per-group.js";

/**
 * @file A row-provenance group end to end through `perGroupExtractor`.
 *
 * `split-schema-unions.test.ts` pins the split arithmetic; this pins the thing the arithmetic was
 * for — a wide table arriving in ONE call, with a usable citation per row — and that a target
 * declaring row provenance types through the extractor without a cast.
 */

const leaf = () => z.number().nullable().optional();

/** A 15-leaf room set: the width the real measurement ran against. Spelled out, not generated,
 * so `z.infer` sees fifteen named keys rather than an index signature — the type-level half of
 * this file is the assertion that a row target reaches the extractor without a cast. */
const roomsPatch = z.object({
  rooms: z
    .array(
      z.object({
        f1: leaf(),
        f2: leaf(),
        f3: leaf(),
        f4: leaf(),
        f5: leaf(),
        f6: leaf(),
        f7: leaf(),
        f8: leaf(),
        f9: leaf(),
        f10: leaf(),
        f11: leaf(),
        f12: leaf(),
        f13: leaf(),
        f14: leaf(),
        f15: leaf(),
      }),
    )
    .optional(),
});
type RoomValues = z.infer<typeof roomsPatch>;
const provenance = { rooms: "row" } as const;

const roomsTarget: ExtractionTarget<RoomValues, typeof provenance> = {
  name: "rooms",
  extractionSchema: enveloped(roomsPatch, { provenance }),
  instructions: "One row per room.",
  examples: [],
};

const row = (n: number): Record<string, unknown> => ({
  ...Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`f${i + 1}`, n * 100 + i])),
  sourceSpan: `L1.Room${n} | ${n * 100}`,
});

function fakeChat(body: string): { chat: ChatClient; requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    requests,
    chat: {
      complete: (request) => {
        requests.push(request);
        return Promise.resolve({ content: body });
      },
    },
  };
}

test("a 15-leaf row group is extracted in ONE call, with a row span per instance", async () => {
  const { chat, requests } = fakeChat(JSON.stringify({ rooms: [row(1), row(2)] }));

  const result = await perGroupExtractor({ target: roomsTarget, chat, model: "m" }).extract({
    text: "t",
    annotations: {},
  });

  // The whole point: 15 plain leaves plus a row span is 16 nullable unions, which fits. A leaf
  // cap of 8 would have made this two calls and two partial answers to merge.
  expect(requests).toHaveLength(1);
  expect(result.usage.calls).toBe(1);

  const rooms = result.fields.rooms;
  expect(rooms).toHaveLength(2);
  // Plain values, not envelopes — the field IS the number.
  expect(rooms[0]!.f1).toBe(100);
  expect(rooms[1]!.f15).toBe(214);
  // One citation, shared by the row's fifteen fields.
  expect(rooms[0]!.sourceSpan).toBe("L1.Room1 | 100");
});

test("the request's response schema asks for plain leaves and one row span", async () => {
  const { chat, requests } = fakeChat(JSON.stringify({ rooms: [row(1)] }));

  await perGroupExtractor({ target: roomsTarget, chat, model: "m" }).extract({
    text: "t",
    annotations: {},
  });

  const schema = requests[0]!.responseFormat.json_schema.schema as {
    properties: { rooms: { items: { properties: Record<string, unknown>; required: string[] } } };
  };
  const item = schema.properties.rooms.items;

  expect(item.required).toHaveLength(16);
  expect(item.required.at(-1)).toBe("sourceSpan");
  // A plain leaf, not a `{ value, confidence, sourceSpan }` object.
  expect(item.properties.f1).not.toHaveProperty("properties");
});
