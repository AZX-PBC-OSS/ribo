import { expect, test } from "vitest";
import * as api from "./index.js";
import type { OpenAiChatOptions } from "./index.js";

// The barrel is the contract of what consumers may depend on. This pins the
// public surface so an accidental drop from `index.ts` is a failing test, not a
// silent break at a consumer.
test("exports the OpenAI-compatible chat transport", () => {
  expect(typeof api.openAiChat).toBe("function");
});

test("exports the options type a host constructs the transport with", () => {
  const options: OpenAiChatOptions = {
    apiKey: "k",
    baseUrl: "https://api.example.com/v1",
  };
  expect(Object.keys(options)).toEqual(["apiKey", "baseUrl"]);
});
