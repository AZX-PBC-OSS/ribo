import type { ChatRequest } from "@azx/ribo-core";
import { expect, test } from "vitest";

import { openAiChat } from "./openai-chat.js";

/**
 * Pin of the OpenAI wire body's structured-output field name.
 *
 * The seam member is `responseFormat` (camelCase, like `maxTokens`), but the
 * OpenAI-compatible wire field is `response_format` (snake_case) — each
 * transport owns the wire spelling, so this test holds the mapping still:
 * whatever the seam calls the structured-output field, the body must carry it
 * as `response_format`, never `responseFormat`.
 */

const request: ChatRequest = {
  model: "gpt-test",
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

test("the structured-output directive reaches the OpenAI wire as response_format", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init: init ?? {} });
    return Promise.resolve(
      Response.json({
        choices: [{ message: { content: "{}" }, finish_reason: "stop" }],
      }),
    );
  }) as typeof fetch;

  const chat = openAiChat({ apiKey: "k", baseUrl: "https://h/v1", fetchImpl });
  await chat.complete(request);

  expect(calls).toHaveLength(1);
  const body = JSON.parse(calls[0]!.init.body as string) as Record<string, unknown>;
  const rf = body.response_format as Record<string, unknown>;
  expect(rf.type).toBe("json_schema");
  expect(rf.json_schema).toHaveProperty("name", "wire-pin");
  expect(rf.json_schema).toHaveProperty("strict", true);
  expect(body).not.toHaveProperty("responseFormat");
});
