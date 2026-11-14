/**
 * @file The round-trip seam and the openai-compatible backend.
 *
 * The round-trip test drives the same run twice — once from a schema that
 * went through the loader, once from the same schema built by hand — and
 * pins that the two produce the same raw outputs. It is the check that the
 * loader's conversion and a hand-built schema are the same schema.
 *
 * The backend test drives the real `@azx/ribo-chat-openai` transport over a
 * stubbed `fetch`: no network, no credential, no model — but the real wire
 * path, which is the thing the factory exists for.
 */
import { z } from "zod";
import { afterEach, expect, test } from "vitest";

import { loadCorpus } from "../corpus/loader.js";
import { createOpenAiCompatibleChat } from "./backend.js";
import { runEval, runEvalOverSchema } from "./run.js";
import { replyForSchema, stubChat } from "./test-support/stub-chat.js";
import {
  corpusWithCases,
  corpusWithoutDocuments,
  removeTemporaries,
} from "./test-support/corpus.js";

afterEach(() => {
  removeTemporaries();
});

// ---------------------------------------------------------------------------
// The round trip
// ---------------------------------------------------------------------------

test("a run from a loader-round-tripped schema matches a run from a hand-built one", async () => {
  const corpus = loadCorpus(corpusWithoutDocuments());
  const cases = corpus.cases.map((entry) => {
    if (entry.input.kind === "document") throw new Error("the fixture case is a document case");
    return { id: entry.id, kind: entry.input.kind, text: entry.input.text };
  });

  // The same schema, built by hand: the fixture's bicycle workshop.
  const built = z.object({
    frame: z.object({ material: z.string(), serial: z.string() }),
    service: z.object({ date: z.string(), notes: z.string() }),
  });

  const loadedChat = stubChat();
  const loaded = await runEvalOverSchema({
    schema: corpus.schema,
    prompt: corpus.manifest.prompt,
    manifestName: corpus.manifest.name,
    cases,
    chat: loadedChat,
    settings: { strategies: ["single-shot"], model: "ribo-test" },
  });

  const builtChat = stubChat();
  const builtRun = await runEvalOverSchema({
    schema: built,
    prompt: corpus.manifest.prompt,
    manifestName: corpus.manifest.name,
    cases,
    chat: builtChat,
    settings: { strategies: ["single-shot"], model: "ribo-test" },
  });

  expect(loaded.length).toBe(builtRun.length);
  expect(loaded.length).toBeGreaterThan(0);
  // The same requests, and the same raw extracted outputs, either way.
  expect(builtChat.calls.length).toBe(loadedChat.calls.length);
  expect(builtRun.map((entry) => entry.raw)).toEqual(loaded.map((entry) => entry.raw));
  expect(builtRun.map((entry) => entry.fields)).toEqual(loaded.map((entry) => entry.fields));
});

// ---------------------------------------------------------------------------
// The openai-compatible backend
// ---------------------------------------------------------------------------

/** One request the stubbed fetch received. */
interface WireRequest {
  readonly url: string;
  readonly body: {
    readonly model: string;
    readonly messages: readonly { readonly role: string; readonly content: string }[];
    readonly response_format: {
      readonly json_schema: { readonly name: string; readonly schema: Record<string, unknown> };
    };
  };
}

/**
 * A `fetch` that answers every request with a value conforming to the
 * request's own schema — the same answer the stub chat gives, over the real
 * transport's wire body.
 */
const stubFetch = (received: WireRequest[]): typeof fetch => {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const rawBody = init?.body;
    const body = JSON.parse(typeof rawBody === "string" ? rawBody : "{}") as WireRequest["body"];
    received.push({ url, body });
    const content = replyForSchema(
      body.response_format.json_schema.schema,
      body.response_format.json_schema.name,
    );
    return new Response(
      JSON.stringify({
        choices: [{ message: { content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 5 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
};

test("the openai-compatible backend drives a case end to end, over a stubbed fetch", async () => {
  const corpus = loadCorpus(corpusWithCases("spoken-note"));
  const received: WireRequest[] = [];
  const chat = createOpenAiCompatibleChat({
    baseUrl: "https://endpoint.invalid/v1",
    apiKey: "test-key",
    fetchImpl: stubFetch(received),
  });

  const results = await runEval(corpus, chat, { strategies: ["single-shot"], model: "ribo-test" });

  expect(results[0]?.status).toBe("extracted");
  expect(results[0]?.fields).toMatchObject({ frame: { material: { value: "sample" } } });
  // The real transport's wire path: the endpoint, the model, the instructions.
  expect(received.length).toBeGreaterThan(0);
  expect(received[0]?.url).toBe("https://endpoint.invalid/v1/chat/completions");
  expect(received[0]?.body.model).toBe("ribo-test");
  expect(received[0]?.body.messages[0]?.content).toBe(corpus.manifest.prompt.instructions);
});

test("the presence-narrowed arm runs over the backend's client", async () => {
  const corpus = loadCorpus(corpusWithCases("spoken-note"));
  const received: WireRequest[] = [];
  const chat = createOpenAiCompatibleChat({
    baseUrl: "https://endpoint.invalid/v1",
    apiKey: "test-key",
    fetchImpl: stubFetch(received),
  });

  const results = await runEval(corpus, chat, {
    strategies: ["presence-narrowed"],
    model: "ribo-test",
  });

  expect(results[0]?.status).toBe("extracted");
  // The presence phase's calls went through the same transport.
  const names = received.map((entry) => entry.body.response_format.json_schema.name);
  expect(names.some((name) => name.endsWith("-presence"))).toBe(true);
  expect(names.some((name) => name.startsWith("ribo-eval-"))).toBe(true);
});
