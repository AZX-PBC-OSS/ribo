import { isTransientFailure } from "@azx/ribo-core";
import { describe, expect, test } from "vitest";

import type { ChatRequest } from "./chat-client.js";
import { openAiChat } from "./openai-chat.js";

/**
 * Key-free CI tests for the OpenAI-compatible transport. `fetch` is INJECTED with
 * a fake — no network, no key, no live provider — so these run in `./check.sh`.
 * They pin the wire shape (URL, bearer auth, JSON body), the happy-path content
 * extraction, and that HTTP errors carry a `status` the queue can classify.
 */

const sampleRequest: ChatRequest = {
  model: "gpt-test",
  messages: [{ role: "user", content: "hi" }],
  response_format: {
    type: "json_schema",
    json_schema: { name: "t", schema: { type: "object" }, strict: true },
  },
};

/** A fake `fetch` that records its call and returns a canned Response. */
function fakeFetch(response: Response): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return Promise.resolve(response);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("openAiChat — request wire shape", () => {
  test("POSTs to /chat/completions with bearer auth and the request as the JSON body", async () => {
    const { fetchImpl, calls } = fakeFetch(
      Response.json({ choices: [{ message: { content: "{}" } }] }),
    );
    const chat = openAiChat({
      apiKey: "sk-secret",
      baseUrl: "https://api.example.com/v1/",
      fetchImpl,
    });

    await chat.complete(sampleRequest);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    // trailing slash on baseUrl is tolerated; the path is appended once.
    expect(call.url).toBe("https://api.example.com/v1/chat/completions");
    expect(call.init.method).toBe("POST");
    const headers = call.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-secret");
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(call.init.body as string)).toEqual(sampleRequest);
  });

  test("returns choices[0].message.content", async () => {
    const { fetchImpl } = fakeFetch(
      Response.json({ choices: [{ message: { content: '{"ok":true}' } }] }),
    );
    const chat = openAiChat({ apiKey: "k", baseUrl: "https://h/v1", fetchImpl });
    expect(await chat.complete(sampleRequest)).toEqual({ content: '{"ok":true}' });
  });
});

describe("openAiChat — HTTP errors carry a classifiable status", () => {
  test("a 400 rejects and is classified terminal (do not retry a bad request)", async () => {
    const { fetchImpl } = fakeFetch(new Response("bad request", { status: 400 }));
    const chat = openAiChat({ apiKey: "k", baseUrl: "https://h/v1", fetchImpl });

    let error: unknown;
    try {
      await chat.complete(sampleRequest);
    } catch (caught) {
      error = caught;
    }
    expect((error as { status?: number }).status).toBe(400);
    expect(isTransientFailure(error)).toBe(false);
  });

  test("a 503 rejects and is classified transient (retry)", async () => {
    const { fetchImpl } = fakeFetch(new Response("upstream down", { status: 503 }));
    const chat = openAiChat({ apiKey: "k", baseUrl: "https://h/v1", fetchImpl });

    let error: unknown;
    try {
      await chat.complete(sampleRequest);
    } catch (caught) {
      error = caught;
    }
    expect((error as { status?: number }).status).toBe(503);
    expect(isTransientFailure(error)).toBe(true);
  });

  test("a 2xx body missing the content rejects (transient by default)", async () => {
    const { fetchImpl } = fakeFetch(Response.json({ choices: [{ message: {} }] }));
    const chat = openAiChat({ apiKey: "k", baseUrl: "https://h/v1", fetchImpl });

    let error: unknown;
    try {
      await chat.complete(sampleRequest);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(isTransientFailure(error)).toBe(true);
  });
});
