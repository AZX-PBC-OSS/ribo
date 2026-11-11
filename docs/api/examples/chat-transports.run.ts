/**
 * The runnable example behind docs/api/chat-transports.html.
 *
 * Every export is a zero-argument function ending in `node:assert/strict`
 * assertions on exactly what the page prose claims. The runner
 * (`run-examples.test.ts`) executes each export in the Vitest `unit` project,
 * so a source change that breaks what the page says breaks the `test` stage.
 * Runs with no credentials and no network: the double is `scriptedChat`, and
 * the real transports run against injected fake `fetch` implementations.
 */

import assert from "node:assert/strict";
import { ChatError, type ChatRequest, type ChatResponseFormat, scriptedChat } from "@azx/ribo-core";
import { openAiChat } from "@azx/ribo-chat-openai";
import { helixChat } from "@azx/ribo-chat-helix";

const responseFormat: ChatResponseFormat = {
  type: "json_schema",
  json_schema: { name: "contact", schema: {}, strict: true },
};

const request = (): ChatRequest => ({
  model: "fake-mini",
  messages: [{ role: "user", content: "Caller is Acme Heating" }],
  responseFormat: responseFormat,
});

export async function scriptedChatAnswersFromAScriptAndRecordsEveryCall(): Promise<void> {
  // #region usage
  const chat = scriptedChat(
    { content: { name: { value: "Acme Heating", confidence: 0.9, sourceSpan: "Acme Heating" } } },
    { engine: "fake-contact" },
  );
  const completion = await chat.complete(request());
  // #endregion usage

  // A plain object reply is serialised — write the value the model was
  // supposedly constrained to emit, not a hand-stringified JSON string.
  assert.equal(
    completion.content,
    JSON.stringify({
      name: { value: "Acme Heating", confidence: 0.9, sourceSpan: "Acme Heating" },
    }),
  );
  assert.equal(completion.finishReason, "stop");
  // Every request is recorded before the reply is produced — failed and
  // aborted calls included.
  assert.equal(chat.calls.length, 1);
  assert.equal(chat.calls[0]?.responseFormat.json_schema.name, "contact");
}

export async function aCallbackResponderDispatchesPerCall(): Promise<void> {
  const chat = scriptedChat((req, _context) => {
    if (req.responseFormat.json_schema.name !== "contact") {
      throw new Error(`unexpected schema: ${req.responseFormat.json_schema.name}`);
    }
    return { content: { name: { value: "Acme", confidence: 0.9, sourceSpan: "Acme" } } };
  });
  await chat.complete(request());
  await chat.complete(request());

  assert.equal(chat.calls.length, 2);
  chat.reset();
  // `reset()` clears the recording, restores the constructed capability and
  // restarts the callback's call numbering at zero.
  assert.equal(chat.calls.length, 0);
}

export async function failuresUseTheTransportVocabulary(): Promise<void> {
  const chat = scriptedChat(() => {
    throw ChatError.http(500, "upstream exploded");
  });

  // A thrown ChatError reaches arbitration unchanged — exactly what a real
  // transport's failure looks like.
  await assert.rejects(chat.complete(request()), (error: unknown) => {
    assert.ok(error instanceof ChatError);
    assert.equal(error.kind, "http");
    // `status` is present exactly when kind === "http".
    assert.equal(error.status, 500);
    return true;
  });
}

export async function anAbortedCallRejectsWithChatErrorAborted(): Promise<void> {
  const chat = scriptedChat({ content: "never reached" });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    chat.complete(request(), { signal: controller.signal }),
    (error: unknown) => {
      assert.ok(error instanceof ChatError);
      assert.equal(error.kind, "aborted");
      return true;
    },
  );
}

// #region defaults
export async function theDefaultsThePageStatesAreObservable(): Promise<void> {
  // Defaults read from packages/ribo-core/src/phases/scripted-chat.ts — not
  // exported constants, so the example observes them: engine id `"scripted"`
  // and a `ready` capability until `setCapability` changes it.
  const chat = scriptedChat({ content: "ok" });
  assert.equal(chat.engine, "scripted");
  assert.deepEqual(await chat.capability(), { status: "ready" });

  chat.setCapability({ status: "unavailable", reason: "offline", detail: "no network" });
  assert.deepEqual(await chat.capability(), {
    status: "unavailable",
    reason: "offline",
    detail: "no network",
  });
}
// #endregion defaults

export async function openAiChatPostsWithBearerAuthAndMapsErrors(): Promise<void> {
  const seen: { url: string; authorization: string; body: string }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    seen.push({
      url,
      authorization: String(new Headers(init?.headers).get("authorization")),
      body: typeof init?.body === "string" ? init.body : "",
    });
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "Acme Heating" }, finish_reason: "stop" }],
      }),
      { status: 200 },
    );
  };

  // The key, base URL and fetch are all injected — the package has no capacity
  // to authenticate. This fake fetch is what makes the example credential-free.
  const chat = openAiChat({
    apiKey: "injected-by-the-host",
    baseUrl: "https://example.test/v1",
    fetchImpl,
  });
  const completion = await chat.complete(request());

  assert.equal(completion.content, "Acme Heating");
  assert.equal(completion.finishReason, "stop");
  assert.equal(seen[0]?.url, "https://example.test/v1/chat/completions");
  assert.equal(seen[0]?.authorization, "Bearer injected-by-the-host");

  const nonOk: typeof fetch = async () => new Response("no", { status: 503 });
  const failing = openAiChat({ apiKey: "k", baseUrl: "https://example.test/v1", fetchImpl: nonOk });
  await assert.rejects(failing.complete(request()), (error: unknown) => {
    assert.ok(error instanceof ChatError);
    assert.equal(error.kind, "http");
    assert.equal(error.status, 503);
    return true;
  });
}

export async function helixChatSpeaksTheProviderNeutralRoute(): Promise<void> {
  const fetchImpl: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        model: "fake-mini",
        content: "Acme Heating",
        stopReason: "end_turn",
        usage: { inputTokens: 12, outputTokens: 3, cacheReadInputTokens: 9 },
      }),
      { status: 200 },
    );

  const chat = helixChat({ baseUrl: "https://example.test/slug", fetchImpl });
  const completion = await chat.complete(request());

  assert.equal(completion.content, "Acme Heating");
  // `"end_turn"` maps to `"stop"`, so the truncation guard keeps working.
  assert.equal(completion.finishReason, "stop");
  // The route's cache counts reach ChatUsage instead of being parsed and
  // discarded — absent means "not reported", never "zero".
  assert.deepEqual(completion.usage, {
    promptTokens: 12,
    completionTokens: 3,
    cachedPromptTokens: 9,
  });
  assert.equal(chat.engine, "helix");
}
