import {
  isTransientFailure,
  type ConnectivitySource,
  type ConnectivityState,
  type ConnectivityStatus,
} from "@azx/ribo-core";
import { describe, expect, test } from "vitest";

import { ChatError } from "./chat-client.js";
import type { ChatRequest } from "./chat-client.js";
import { helixChat } from "./helix-chat.js";

/**
 * A hand-driven connectivity source for capability tests. Mirrors the real
 * model's subscription contract: the listener is called immediately on subscribe
 * and again on every pushed change.
 */
class FakeConnectivitySource implements ConnectivitySource {
  #listeners = new Set<(state: ConnectivityState) => void>();
  #status: ConnectivityStatus = "offline";

  setStatus(status: ConnectivityStatus): void {
    if (status === this.#status) return;
    this.#status = status;
    const state: ConnectivityState = { status };
    for (const listener of this.#listeners) listener(state);
  }

  subscribe = (listener: (state: ConnectivityState) => void): (() => void) => {
    this.#listeners.add(listener);
    listener({ status: this.#status });
    return () => {
      this.#listeners.delete(listener);
    };
  };
}

/**
 * Key-free CI tests for the Helix platform LLM transport. `fetch` is INJECTED
 * with a fake — no network, no token, no live route — so these run in
 * `./check.sh`. They pin the wire shape (URL, bearer + Origin auth, the
 * `system` field mapping, `stream: false`, `responseFormat` flattening), the
 * happy-path content/finish-reason/usage extraction, the `max_tokens`→`length`
 * mapping, the abort path, and that every failure surfaces as a typed
 * `ChatError`.
 */

const sampleRequest: ChatRequest = {
  model: "claude-haiku-4-5",
  messages: [
    { role: "system", content: "You are an extractor." },
    { role: "user", content: "hi" },
  ],
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

/** A non-streaming Helix success body with `content` and a `stopReason`. */
function okBody(
  content: string,
  stopReason: string = "end_turn",
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
  },
): Record<string, unknown> {
  const body: Record<string, unknown> = { content, stopReason };
  if (usage) body.usage = usage;
  return body;
}

describe("helixChat — request wire shape", () => {
  test("a role:system message becomes the top-level system field and is not in messages", async () => {
    const { fetchImpl, calls } = fakeFetch(Response.json(okBody("{}")));
    const chat = helixChat({
      token: "dev-token",
      baseUrl: "https://dev-api.azx.helix.azxlabs.io/my-app",
      origin: "http://localhost:5173",
      fetchImpl,
    });

    await chat.complete(sampleRequest);

    const body = JSON.parse(calls[0]!.init.body as string) as Record<string, unknown>;
    expect(body.system).toBe("You are an extractor.");
    const messages = body.messages as Array<{ role: string }>;
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe("user");
    expect(messages.every((m) => m.role !== "system")).toBe(true);
  });

  test("POSTs to /_api/llm/chat with bearer auth and the Origin header", async () => {
    const { fetchImpl, calls } = fakeFetch(Response.json(okBody("{}")));
    const chat = helixChat({
      token: "dev-token",
      baseUrl: "https://dev-api.azx.helix.azxlabs.io/my-app/",
      origin: "http://localhost:5173",
      fetchImpl,
    });

    await chat.complete(sampleRequest);

    const call = calls[0]!;
    // trailing slash on baseUrl is tolerated; the path is appended once.
    expect(call.url).toBe("https://dev-api.azx.helix.azxlabs.io/my-app/_api/llm/chat");
    expect(call.init.method).toBe("POST");
    const headers = call.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer dev-token");
    expect(headers.origin).toBe("http://localhost:5173");
    expect(headers["content-type"]).toBe("application/json");
  });

  test("stream: false is always sent", async () => {
    const { fetchImpl, calls } = fakeFetch(Response.json(okBody("{}")));
    const chat = helixChat({
      token: "t",
      baseUrl: "https://h",
      origin: "http://localhost:5173",
      fetchImpl,
    });

    await chat.complete(sampleRequest);

    const body = JSON.parse(calls[0]!.init.body as string) as Record<string, unknown>;
    expect(body.stream).toBe(false);
  });

  test("response_format is flattened to responseFormat { type, name, schema } without strict", async () => {
    const { fetchImpl, calls } = fakeFetch(Response.json(okBody("{}")));
    const chat = helixChat({
      token: "t",
      baseUrl: "https://h",
      origin: "http://localhost:5173",
      fetchImpl,
    });

    await chat.complete(sampleRequest);

    const body = JSON.parse(calls[0]!.init.body as string) as Record<string, unknown>;
    const rf = body.responseFormat as Record<string, unknown>;
    expect(rf.type).toBe("json_schema");
    expect(rf.name).toBe("t");
    expect(rf.schema).toEqual({ type: "object" });
    expect(rf).not.toHaveProperty("strict");
    expect(rf).not.toHaveProperty("json_schema");
  });

  test("maxTokens is passed through as camelCase", async () => {
    const { fetchImpl, calls } = fakeFetch(Response.json(okBody("{}")));
    const chat = helixChat({
      token: "t",
      baseUrl: "https://h",
      origin: "http://localhost:5173",
      fetchImpl,
    });

    await chat.complete({ ...sampleRequest, maxTokens: 4096 });

    const body = JSON.parse(calls[0]!.init.body as string) as Record<string, unknown>;
    expect(body.maxTokens).toBe(4096);
  });

  test("the cap is absent from the wire body when maxTokens is unset", async () => {
    const { fetchImpl, calls } = fakeFetch(Response.json(okBody("{}")));
    const chat = helixChat({
      token: "t",
      baseUrl: "https://h",
      origin: "http://localhost:5173",
      fetchImpl,
    });

    await chat.complete(sampleRequest);

    const body = JSON.parse(calls[0]!.init.body as string) as Record<string, unknown>;
    expect(body).not.toHaveProperty("maxTokens");
  });
});

describe("helixChat — maxTokens validation", () => {
  for (const bad of [0, -1, 1.5, NaN, Infinity]) {
    test(`a non-positive-integer maxTokens (${String(bad)}) is rejected before any request is made`, async () => {
      const { fetchImpl, calls } = fakeFetch(Response.json(okBody("{}")));
      const chat = helixChat({ token: "t", baseUrl: "https://h", fetchImpl });

      await expect(chat.complete({ ...sampleRequest, maxTokens: bad })).rejects.toThrow(
        /maxTokens must be a positive integer/,
      );
      expect(calls).toHaveLength(0);
    });
  }
});

describe("helixChat — response mapping", () => {
  test("returns content with finishReason and usage", async () => {
    const { fetchImpl } = fakeFetch(
      Response.json(okBody('{"ok":true}', "end_turn", { inputTokens: 10, outputTokens: 5 })),
    );
    const chat = helixChat({ token: "t", baseUrl: "https://h", fetchImpl });
    expect(await chat.complete(sampleRequest)).toEqual({
      content: '{"ok":true}',
      finishReason: "stop",
      usage: { promptTokens: 10, completionTokens: 5 },
    });
  });

  test("the route's cache counts reach ChatUsage rather than being dropped", async () => {
    // The prefix cache is what decides what the few-shot example actually costs
    // in production: the same instructions ship on every group call. These counts
    // were parsed and discarded, which made "is the cache working" unanswerable
    // from the field.
    const { fetchImpl } = fakeFetch(
      Response.json(
        okBody('{"ok":true}', "end_turn", {
          inputTokens: 4128,
          outputTokens: 210,
          cacheReadInputTokens: 3900,
          cacheCreationInputTokens: 0,
        }),
      ),
    );
    const chat = helixChat({ token: "t", baseUrl: "https://h", fetchImpl });
    expect((await chat.complete(sampleRequest)).usage).toEqual({
      promptTokens: 4128,
      completionTokens: 210,
      cachedPromptTokens: 3900,
      cacheCreationPromptTokens: 0,
    });
  });

  test("a reported cache count of zero is carried, not treated as absent", async () => {
    // A cold call reports 0 read / N created. Absent means "the route said
    // nothing"; 0 means "it said there was no hit". Collapsing them would make a
    // cold run indistinguishable from a route that does not cache at all.
    const { fetchImpl } = fakeFetch(
      Response.json(
        okBody("{}", "end_turn", {
          inputTokens: 100,
          outputTokens: 10,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 90,
        }),
      ),
    );
    const chat = helixChat({ token: "t", baseUrl: "https://h", fetchImpl });
    const usage = (await chat.complete(sampleRequest)).usage;
    expect(usage?.cachedPromptTokens).toBe(0);
    expect(usage?.cacheCreationPromptTokens).toBe(90);
  });

  test("cache fields stay absent when the route does not report them", async () => {
    const { fetchImpl } = fakeFetch(
      Response.json(okBody("{}", "end_turn", { inputTokens: 10, outputTokens: 5 })),
    );
    const chat = helixChat({ token: "t", baseUrl: "https://h", fetchImpl });
    expect((await chat.complete(sampleRequest)).usage).toEqual({
      promptTokens: 10,
      completionTokens: 5,
    });
  });

  test('stopReason "max_tokens" becomes finishReason "length"', async () => {
    const { fetchImpl } = fakeFetch(Response.json(okBody("{}", "max_tokens")));
    const chat = helixChat({ token: "t", baseUrl: "https://h", fetchImpl });
    const result = await chat.complete(sampleRequest);
    expect(result.finishReason).toBe("length");
  });

  test("an unrecognised stopReason is a malformed-response ChatError, not a silent stop", async () => {
    const { fetchImpl } = fakeFetch(Response.json(okBody("{}", "unknown_reason")));
    const chat = helixChat({ token: "t", baseUrl: "https://h", fetchImpl });

    let error: unknown;
    try {
      await chat.complete(sampleRequest);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ChatError);
    expect((error as ChatError).kind).toBe("malformed-response");
  });

  test("an absent stopReason is a malformed-response ChatError", async () => {
    const { fetchImpl } = fakeFetch(Response.json({ content: "{}" }));
    const chat = helixChat({ token: "t", baseUrl: "https://h", fetchImpl });

    let error: unknown;
    try {
      await chat.complete(sampleRequest);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ChatError);
    expect((error as ChatError).kind).toBe("malformed-response");
  });

  test("a null stopReason is a malformed-response ChatError", async () => {
    const { fetchImpl } = fakeFetch(Response.json({ content: "{}", stopReason: null }));
    const chat = helixChat({ token: "t", baseUrl: "https://h", fetchImpl });

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
    const { fetchImpl } = fakeFetch(Response.json({ stopReason: "end_turn" }));
    const chat = helixChat({ token: "t", baseUrl: "https://h", fetchImpl });

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

describe("helixChat — origin and 403", () => {
  test("the Origin header is sent when origin is provided", async () => {
    const { fetchImpl, calls } = fakeFetch(Response.json(okBody("{}")));
    const chat = helixChat({
      token: "t",
      baseUrl: "https://h",
      origin: "http://localhost:5173",
      fetchImpl,
    });

    await chat.complete(sampleRequest);

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.origin).toBe("http://localhost:5173");
  });

  test("the Origin header is absent when origin is not provided", async () => {
    const { fetchImpl, calls } = fakeFetch(Response.json(okBody("{}")));
    const chat = helixChat({ token: "t", baseUrl: "https://h", fetchImpl });

    await chat.complete(sampleRequest);

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers).not.toHaveProperty("origin");
  });

  test("a 403 surfaces as an http ChatError naming origin registration", async () => {
    const { fetchImpl } = fakeFetch(
      new Response(
        JSON.stringify({
          code: "forbidden",
          message: "origin is not registered for this dev token",
        }),
        { status: 403, statusText: "Forbidden" },
      ),
    );
    const chat = helixChat({
      token: "t",
      baseUrl: "https://h",
      origin: "http://localhost:5173",
      fetchImpl,
    });

    let error: unknown;
    try {
      await chat.complete(sampleRequest);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ChatError);
    expect((error as ChatError).kind).toBe("http");
    expect((error as ChatError).status).toBe(403);
    expect((error as ChatError).message).toContain("origin");
    expect((error as ChatError).message).toContain("http://localhost:5173");
    expect((error as ChatError).message).toContain("registered");
  });

  test("a 403 model_not_allowed names the missing model grant", async () => {
    const { fetchImpl } = fakeFetch(
      new Response(JSON.stringify({ code: "model_not_allowed", message: "model not allowed" }), {
        status: 403,
        statusText: "Forbidden",
      }),
    );
    const chat = helixChat({
      token: "t",
      baseUrl: "https://h",
      origin: "http://localhost:5173",
      fetchImpl,
    });

    let error: unknown;
    try {
      await chat.complete(sampleRequest);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ChatError);
    expect((error as ChatError).kind).toBe("http");
    expect((error as ChatError).status).toBe(403);
    expect((error as ChatError).message).toContain("model_not_allowed");
    expect((error as ChatError).message).toContain("capabilities.llm.models");
  });

  test("a 400 validation_failed names the schema rejection", async () => {
    const { fetchImpl } = fakeFetch(
      new Response(JSON.stringify({ code: "validation_failed", message: "bad schema" }), {
        status: 400,
        statusText: "Bad Request",
      }),
    );
    const chat = helixChat({
      token: "t",
      baseUrl: "https://h",
      origin: "http://localhost:5173",
      fetchImpl,
    });

    let error: unknown;
    try {
      await chat.complete(sampleRequest);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ChatError);
    expect((error as ChatError).kind).toBe("http");
    expect((error as ChatError).status).toBe(400);
    expect((error as ChatError).message).toContain("validation_failed");
    expect((error as ChatError).message).toContain("responseFormat.schema");
  });
});

describe("helixChat — abort", () => {
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

    const chat = helixChat({ token: "t", baseUrl: "https://h", fetchImpl });
    const promise = chat.complete(sampleRequest, { signal: controller.signal });

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

describe("helixChat — typed errors", () => {
  test("a 503 rejects as kind 'http' with the real status, classified transient", async () => {
    const { fetchImpl } = fakeFetch(new Response("capability_unavailable", { status: 503 }));
    const chat = helixChat({ token: "t", baseUrl: "https://h", fetchImpl });

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
    const chat = helixChat({ token: "t", baseUrl: "https://h", fetchImpl });

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
    const chat = helixChat({ token: "t", baseUrl: "https://h", fetchImpl });

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

describe("helixChat — capability", () => {
  test("connectivity reporting online → capability is ready", async () => {
    const source = new FakeConnectivitySource();
    source.setStatus("online");
    const chat = helixChat({
      token: "t",
      baseUrl: "https://h",
      connectivity: source,
    });

    expect(await chat.capability()).toEqual({ status: "ready" });
  });

  test("connectivity reporting offline → capability is unavailable with reason offline", async () => {
    const source = new FakeConnectivitySource();
    source.setStatus("offline");
    const chat = helixChat({
      token: "t",
      baseUrl: "https://h",
      connectivity: source,
    });

    const cap = await chat.capability();
    expect(cap).toEqual({
      status: "unavailable",
      reason: "offline",
      detail: expect.any(String),
    });
  });

  test("the client subscribes and tracks connectivity change", async () => {
    const source = new FakeConnectivitySource();
    source.setStatus("online");
    const chat = helixChat({
      token: "t",
      baseUrl: "https://h",
      connectivity: source,
    });

    expect(await chat.capability()).toEqual({ status: "ready" });

    source.setStatus("offline");

    expect(await chat.capability()).toEqual({
      status: "unavailable",
      reason: "offline",
      detail: expect.any(String),
    });
  });

  test("no connectivity source at all → capability is ready", async () => {
    const chat = helixChat({ token: "t", baseUrl: "https://h" });

    expect(await chat.capability()).toEqual({ status: "ready" });
  });

  test("engine is a non-empty string", () => {
    const chat = helixChat({ token: "t", baseUrl: "https://h" });

    expect(chat.engine).toBe("helix");
    expect(chat.engine.length).toBeGreaterThan(0);
  });
});
