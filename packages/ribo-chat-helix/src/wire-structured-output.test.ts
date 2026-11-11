import type { ChatRequest } from "@azx/ribo-core";
import { expect, test } from "vitest";

import { helixChat } from "./helix-chat.js";

/**
 * Pin of the Helix wire body's structured-output field name.
 *
 * The seam carries `responseFormat` as the OpenAI-shaped
 * `{ type, json_schema: { name, schema, strict } }`; the Helix route flattens
 * it to `responseFormat` `{ type, name, schema }` — camelCase, no `strict`, no
 * `json_schema`, and never the snake_case `response_format`. This test holds
 * that mapping still.
 */

const request: ChatRequest = {
  model: "claude-haiku-4-5",
  messages: [{ role: "user", content: "The unit is a boiler." }],
  responseFormat: {
    type: "json_schema",
    json_schema: {
      name: "wire-pin",
      schema: { type: "object", additionalProperties: false },
      strict: true,
    },
  },
};

test("the structured-output directive reaches the Helix wire as the flattened responseFormat", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init: init ?? {} });
    return Promise.resolve(Response.json({ content: "{}", stopReason: "end_turn" }));
  }) as typeof fetch;

  const chat = helixChat({ token: "t", baseUrl: "https://h", fetchImpl });
  await chat.complete(request);

  expect(calls).toHaveLength(1);
  const body = JSON.parse(calls[0]!.init.body as string) as Record<string, unknown>;
  const rf = body.responseFormat as Record<string, unknown>;
  expect(rf.type).toBe("json_schema");
  expect(rf.name).toBe("wire-pin");
  expect(rf).not.toHaveProperty("strict");
  expect(rf).not.toHaveProperty("json_schema");
  expect(body).not.toHaveProperty("response_format");
});
