import { z } from "zod";
import { describe, expect, test } from "vitest";

import { ChatError } from "./chat-client.js";
import type { ChatClient, ChatFinishReason, ChatRequest } from "./chat-client.js";
import { extractInventory } from "./inventory.js";
import { SchemaParseError } from "@azx/ribo-core";

/**
 * Must-fail tests for the inventory-pass extraction phase (Task 9). All calls run
 * against a FAKE {@link ChatClient}, so nothing here touches a model or the
 * network.
 */

/** A minimal synthetic roster schema for the tool-agnostic extractor tests. */
const syntheticRosterSchema = z.strictObject({
  hvac: z.array(
    z.strictObject({
      mentionSpan: z.string(),
      discriminator: z.string(),
      distinguishedBy: z.string().nullable(),
      eligibility: z.enum(["current", "decommissioned"]),
      eligibilitySpan: z.string().nullable(),
    }),
  ),
  attic: z.array(z.any()),
  wall: z.array(z.any()),
  window: z.array(z.any()),
  dhw: z.array(z.any()),
});

type SyntheticRoster = z.infer<typeof syntheticRosterSchema>;

/** A ChatClient that records the request and replays a fixed response body. */
function fakeInventoryChat(
  content: string,
  finishReason: ChatFinishReason = "stop",
): { chat: ChatClient; requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  const chat: ChatClient = {
    complete: async (request) => {
      requests.push(request);
      return { content, finishReason };
    },
  };
  return { chat, requests };
}

const makeOptions = (chat: ChatClient) => ({
  name: "demo-inventory",
  instructions: "Inventory instructions for the demo target.",
  schema: syntheticRosterSchema,
  chat,
  model: "demo-model",
});

describe("extractInventory", () => {
  test("returns a parsed roster from a fake chat response", async () => {
    const response: SyntheticRoster = {
      hvac: [
        {
          mentionSpan: "the basement furnace",
          discriminator: "the basement furnace",
          distinguishedBy: null,
          eligibility: "current",
          eligibilitySpan: null,
        },
      ],
      attic: [],
      wall: [],
      window: [],
      dhw: [],
    };
    const { chat, requests } = fakeInventoryChat(JSON.stringify(response));

    const result = await extractInventory(makeOptions(chat), "the transcript");

    expect(requests).toHaveLength(1);
    expect(result.hvac).toHaveLength(1);
    expect(result.hvac[0]!.discriminator).toBe("the basement furnace");
  });

  test("a group the transcript never mentions yields an empty list, not a candidate", async () => {
    const response: SyntheticRoster = {
      hvac: [],
      attic: [],
      wall: [],
      window: [],
      dhw: [],
    };
    const { chat, requests } = fakeInventoryChat(JSON.stringify(response));

    const result = await extractInventory(makeOptions(chat), "no components mentioned at all");

    expect(requests[0]!.messages[1]).toEqual({
      role: "user",
      content: "no components mentioned at all",
    });
    expect(result.hvac).toHaveLength(0);
    expect(result.attic).toHaveLength(0);
    expect(result.wall).toHaveLength(0);
    expect(result.window).toHaveLength(0);
    expect(result.dhw).toHaveLength(0);
  });

  test("keeps the transcript as the last message", async () => {
    const { chat, requests } = fakeInventoryChat(
      JSON.stringify({ hvac: [], attic: [], wall: [], window: [], dhw: [] }),
    );

    await extractInventory(makeOptions(chat), "the final transcript");

    const messages = requests[0]!.messages;
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({
      role: "system",
      content: "Inventory instructions for the demo target.",
    });
    expect(messages[messages.length - 1]).toEqual({
      role: "user",
      content: "the final transcript",
    });
  });

  test("pins the response to a strict json_schema with the supplied name", async () => {
    const { chat, requests } = fakeInventoryChat(
      JSON.stringify({ hvac: [], attic: [], wall: [], window: [], dhw: [] }),
    );

    await extractInventory(makeOptions(chat), "t");

    const request = requests[0]!;
    expect(request.response_format.type).toBe("json_schema");
    expect(request.response_format.json_schema.name).toBe("demo-inventory");
    expect(request.response_format.json_schema.strict).toBe(true);
    expect(request.response_format.json_schema.schema).toEqual(
      z.toJSONSchema(syntheticRosterSchema, { target: "draft-2020-12" }),
    );
  });

  test("a schema-invalid response is rejected at the trust boundary", async () => {
    // Missing required `mentionSpan` on the hvac candidate.
    const { chat } = fakeInventoryChat(
      JSON.stringify({
        hvac: [
          {
            discriminator: "x",
            distinguishedBy: null,
            eligibility: "current",
            eligibilitySpan: null,
          },
        ],
        attic: [],
        wall: [],
        window: [],
        dhw: [],
      }),
    );

    await expect(extractInventory(makeOptions(chat), "t")).rejects.toBeInstanceOf(SchemaParseError);
  });

  test("a non-JSON response is transient (queue retries)", async () => {
    const { chat } = fakeInventoryChat("not valid json");

    await expect(extractInventory(makeOptions(chat), "t")).rejects.toThrow("was not valid JSON");
  });

  test("a truncated response is terminal and not retried", async () => {
    const { chat } = fakeInventoryChat(
      JSON.stringify({ hvac: [], attic: [], wall: [], window: [], dhw: [] }),
      "length",
    );

    await expect(extractInventory(makeOptions(chat), "t")).rejects.toThrow("maxTokens");
  });

  test("a refusal/unsupported transport error is terminal", async () => {
    const chat: ChatClient = {
      complete: async () => {
        throw ChatError.unsupported("this client cannot do json_schema");
      },
    };

    await expect(extractInventory(makeOptions(chat), "t")).rejects.toThrow(
      "the transport failed terminally",
    );
  });
});
