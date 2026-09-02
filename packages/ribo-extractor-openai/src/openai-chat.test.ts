import { isTransientFailure } from "@azx/ribo-core";
import { describe, expect, test } from "vitest";

import { ChatError } from "./chat-client.js";
import type { ChatRequest } from "./chat-client.js";
import { openAiChat } from "./openai-chat.js";

/**
 * Key-free CI tests for the OpenAI-compatible transport. `fetch` is INJECTED with
 * a fake — no network, no key, no live provider — so these run in `./check.sh`.
 * They pin the wire shape (URL, bearer auth, JSON body, the `max_tokens` mapping),
 * the happy-path content/finish-reason/usage extraction, the abort path, and that
 * every failure surfaces as a typed `ChatError` the queue can classify.
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

/** A response body with content and a "stop" finish reason — the shape every happy-path test needs. */
function okBody(
  content: string,
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
  },
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    choices: [{ message: { content }, finish_reason: "stop" }],
  };
  if (usage) body.usage = usage;
  return body;
}

describe("openAiChat — request wire shape", () => {
  test("POSTs to /chat/completions with bearer auth and the request as the JSON body", async () => {
    const { fetchImpl, calls } = fakeFetch(Response.json(okBody("{}")));
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
    // The wire body matches the request — no extra fields when maxTokens is unset.
    expect(JSON.parse(call.init.body as string)).toEqual(sampleRequest);
  });

  test("returns choices[0].message.content with finishReason and usage", async () => {
    const { fetchImpl } = fakeFetch(
      Response.json(okBody('{"ok":true}', { prompt_tokens: 10, completion_tokens: 5 })),
    );
    const chat = openAiChat({ apiKey: "k", baseUrl: "https://h/v1", fetchImpl });
    expect(await chat.complete(sampleRequest)).toEqual({
      content: '{"ok":true}',
      finishReason: "stop",
      usage: { promptTokens: 10, completionTokens: 5 },
    });
  });

  test("the cap is absent from the wire body when maxTokens is unset, and present as max_tokens when set", async () => {
    // Unset: the body carries no max_tokens and no maxTokens.
    const { fetchImpl: fetchNoCap, calls: callsNoCap } = fakeFetch(Response.json(okBody("{}")));
    const chatNoCap = openAiChat({ apiKey: "k", baseUrl: "https://h/v1", fetchImpl: fetchNoCap });
    await chatNoCap.complete(sampleRequest);
    const bodyNoCap = JSON.parse(callsNoCap[0]!.init.body as string) as Record<string, unknown>;
    expect(bodyNoCap).not.toHaveProperty("max_tokens");
    expect(bodyNoCap).not.toHaveProperty("maxTokens");

    // Set: the body carries max_tokens (the wire spelling), NOT maxTokens (the seam spelling).
    const { fetchImpl: fetchCap, calls: callsCap } = fakeFetch(Response.json(okBody("{}")));
    const chatCap = openAiChat({ apiKey: "k", baseUrl: "https://h/v1", fetchImpl: fetchCap });
    await chatCap.complete({ ...sampleRequest, maxTokens: 500 });
    const bodyCap = JSON.parse(callsCap[0]!.init.body as string) as Record<string, unknown>;
    expect(bodyCap.max_tokens).toBe(500);
    expect(bodyCap).not.toHaveProperty("maxTokens");
  });
});

describe("openAiChat — maxTokens validation", () => {
  for (const bad of [0, -1, 1.5, NaN, Infinity]) {
    test(`a non-positive-integer maxTokens (${String(bad)}) is rejected before any request is made`, async () => {
      const { fetchImpl, calls } = fakeFetch(Response.json(okBody("{}")));
      const chat = openAiChat({ apiKey: "k", baseUrl: "https://h/v1", fetchImpl });

      await expect(chat.complete({ ...sampleRequest, maxTokens: bad })).rejects.toThrow(
        /maxTokens must be a positive integer/,
      );
      // No fetch was made — the error is a configuration error, not a transport one.
      expect(calls).toHaveLength(0);
    });
  }
});

describe("openAiChat — abort", () => {
  test("an aborted call rejects with kind 'aborted' and cause preserved", async () => {
    const controller = new AbortController();
    // A fake fetch that never resolves on its own; only the signal can settle it,
    // mirroring how a real fetch rejects with a DOMException named "AbortError".
    const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(new DOMException("aborted", "AbortError"));
          return;
        }
        signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }) as typeof fetch;

    const chat = openAiChat({ apiKey: "k", baseUrl: "https://h/v1", fetchImpl });
    const promise = chat.complete(sampleRequest, { signal: controller.signal });

    // Abort after the fetch is in flight.
    controller.abort();

    let error: unknown;
    try {
      await promise;
      throw new Error("expected complete() to reject on abort");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ChatError);
    expect((error as ChatError).kind).toBe("aborted");
    expect((error as ChatError).cause).toBeInstanceOf(DOMException);
  });
});

describe("openAiChat — typed errors", () => {
  test("a 400 rejects as kind 'http' with the real status, classified terminal", async () => {
    const { fetchImpl } = fakeFetch(new Response("bad request", { status: 400 }));
    const chat = openAiChat({ apiKey: "k", baseUrl: "https://h/v1", fetchImpl });

    let error: unknown;
    try {
      await chat.complete(sampleRequest);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ChatError);
    expect((error as ChatError).kind).toBe("http");
    expect((error as ChatError).status).toBe(400);
    expect(isTransientFailure(error)).toBe(false);
  });

  test("a 503 rejects as kind 'http' with the real status, classified transient", async () => {
    const { fetchImpl } = fakeFetch(new Response("upstream down", { status: 503 }));
    const chat = openAiChat({ apiKey: "k", baseUrl: "https://h/v1", fetchImpl });

    let error: unknown;
    try {
      await chat.complete(sampleRequest);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ChatError);
    expect((error as ChatError).kind).toBe("http");
    expect((error as ChatError).status).toBe(503);
    expect(isTransientFailure(error)).toBe(true);
  });

  test("a fetch rejection yields kind 'transport'", async () => {
    const fetchImpl = (() => Promise.reject(new TypeError("Failed to fetch"))) as typeof fetch;
    const chat = openAiChat({ apiKey: "k", baseUrl: "https://h/v1", fetchImpl });

    let error: unknown;
    try {
      await chat.complete(sampleRequest);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ChatError);
    expect((error as ChatError).kind).toBe("transport");
    expect((error as ChatError).cause).toBeInstanceOf(TypeError);
  });

  test("an unparseable body yields kind 'malformed-response'", async () => {
    const { fetchImpl } = fakeFetch(new Response("not json at all", { status: 200 }));
    const chat = openAiChat({ apiKey: "k", baseUrl: "https://h/v1", fetchImpl });

    let error: unknown;
    try {
      await chat.complete(sampleRequest);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ChatError);
    expect((error as ChatError).kind).toBe("malformed-response");
  });

  test("a body with no choices yields kind 'malformed-response'", async () => {
    const { fetchImpl } = fakeFetch(Response.json({}));
    const chat = openAiChat({ apiKey: "k", baseUrl: "https://h/v1", fetchImpl });

    let error: unknown;
    try {
      await chat.complete(sampleRequest);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ChatError);
    expect((error as ChatError).kind).toBe("malformed-response");
  });

  test("a body missing the content string yields kind 'malformed-response' (transient by default)", async () => {
    const { fetchImpl } = fakeFetch(
      Response.json({ choices: [{ message: {}, finish_reason: "stop" }] }),
    );
    const chat = openAiChat({ apiKey: "k", baseUrl: "https://h/v1", fetchImpl });

    let error: unknown;
    try {
      await chat.complete(sampleRequest);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ChatError);
    expect((error as ChatError).kind).toBe("malformed-response");
    expect(isTransientFailure(error)).toBe(true);
  });
});

describe("openAiChat — finish_reason guarantee", () => {
  test("an absent finish_reason yields 'malformed-response', never a completion with the field omitted", async () => {
    // Content IS present — so the only thing wrong is the missing finish_reason.
    // If openAiChat returned a completion with finishReason omitted instead of
    // throwing, this test would not reject.
    const { fetchImpl } = fakeFetch(Response.json({ choices: [{ message: { content: "{}" } }] }));
    const chat = openAiChat({ apiKey: "k", baseUrl: "https://h/v1", fetchImpl });

    let error: unknown;
    try {
      await chat.complete(sampleRequest);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ChatError);
    expect((error as ChatError).kind).toBe("malformed-response");
  });

  test("an unrecognised finish_reason yields 'malformed-response'", async () => {
    const { fetchImpl } = fakeFetch(
      Response.json({
        choices: [{ message: { content: "{}" }, finish_reason: "tool_calls" }],
      }),
    );
    const chat = openAiChat({ apiKey: "k", baseUrl: "https://h/v1", fetchImpl });

    let error: unknown;
    try {
      await chat.complete(sampleRequest);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ChatError);
    expect((error as ChatError).kind).toBe("malformed-response");
  });

  test("a null finish_reason yields 'malformed-response'", async () => {
    const { fetchImpl } = fakeFetch(
      Response.json({
        choices: [{ message: { content: "{}" }, finish_reason: null }],
      }),
    );
    const chat = openAiChat({ apiKey: "k", baseUrl: "https://h/v1", fetchImpl });

    let error: unknown;
    try {
      await chat.complete(sampleRequest);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ChatError);
    expect((error as ChatError).kind).toBe("malformed-response");
  });
});

describe("openAiChat — prefix cache accounting", () => {
  test("prompt_tokens_details.cached_tokens reaches ChatUsage", async () => {
    // OpenAI nests the prefix-cache hit under prompt_tokens_details rather than
    // alongside prompt_tokens, so a flat read misses it entirely.
    const fetchImpl = (async () =>
      Response.json({
        choices: [{ message: { content: "{}" }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 4128,
          completion_tokens: 210,
          prompt_tokens_details: { cached_tokens: 3712 },
        },
      })) as unknown as typeof fetch;

    const chat = openAiChat({ apiKey: "k", baseUrl: "https://api.example.com/v1", fetchImpl });
    const usage = (
      await chat.complete({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        response_format: {
          type: "json_schema",
          json_schema: { name: "n", schema: { type: "object" }, strict: true },
        },
      })
    ).usage;

    expect(usage?.promptTokens).toBe(4128);
    expect(usage?.cachedPromptTokens).toBe(3712);
    // This surface bills no cache write, so there is nothing to report.
    expect(usage?.cacheCreationPromptTokens).toBeUndefined();
  });
});
