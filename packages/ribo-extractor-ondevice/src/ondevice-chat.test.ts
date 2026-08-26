import { describe, expect, test } from "vitest";

import { ChatError, type ChatRequest } from "@azx/ribo-extractor-openai";

import { ONDEVICE_CHAT_ENGINE, OnDeviceChat } from "./ondevice-chat.js";
import {
  degenerateResponse,
  FakeLanguageModel,
  wellFormedResponse,
} from "./test-support/fake-language-model.js";

function makeRequest(
  overrides: Partial<ChatRequest> & { transcript?: string } = {},
): ChatRequest {
  const transcript = overrides.transcript ?? "the live transcript";
  return {
    model: overrides.model ?? "ignored-model",
    messages: [
      { role: "system", content: "You are a field extractor." },
      { role: "user", content: "first example transcript" },
      { role: "assistant", content: '{"example": "value"}' },
      { role: "user", content: transcript },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "test-schema",
        schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
        strict: true as const,
      },
    },
    ...(overrides.maxTokens !== undefined ? { maxTokens: overrides.maxTokens } : {}),
  };
}

describe("OnDeviceChat engine", () => {
  test("exports a stable engine id and stamps it on the instance", () => {
    const model = new FakeLanguageModel();
    const chat = new OnDeviceChat({ languageModel: model });

    expect(ONDEVICE_CHAT_ENGINE).toBe("ondevice-chat");
    expect(chat.engine).toBe(ONDEVICE_CHAT_ENGINE);
  });
});

describe("OnDeviceChat capability and priming", () => {
  test("capability() probes availability without creating a session", async () => {
    const model = new FakeLanguageModel();
    model.availabilityValue = "available";
    const chat = new OnDeviceChat({ languageModel: model });

    const result = await chat.capability();

    expect(result).toEqual({ status: "ready" });
    expect(model.createCount).toBe(0);
  });

  test("prime() downloads and reports capability", async () => {
    const model = new FakeLanguageModel();
    model.availabilityValue = "downloadable";
    model.progressSequence = [{ loaded: 0.5, total: 1 }, { loaded: 1, total: 1 }];
    const events: { loaded: number; total: 1 }[] = [];
    const chat = new OnDeviceChat({ languageModel: model });

    const result = await chat.prime((event) => events.push(event));

    expect(result).toEqual({ status: "ready" });
    expect(model.createCount).toBe(1);
    expect(events).toEqual(model.progressSequence);
  });
});

describe("OnDeviceChat translation", () => {
  test("system and few-shot turns become initialPrompts; only the final user turn is prompted", async () => {
    const model = new FakeLanguageModel();
    model.availabilityValue = "available";
    model.chunks = [wellFormedResponse()];
    const chat = new OnDeviceChat({ languageModel: model });

    await chat.complete(makeRequest({ transcript: "the one and only prompt" }));

    expect(model.createCount).toBe(1);
    const base = model.sessions[0]!;
    const clone = model.sessions[1]!;
    expect(base.createOptions?.initialPrompts).toEqual([
      { role: "system", content: "You are a field extractor." },
      { role: "user", content: "first example transcript" },
      { role: "assistant", content: '{"example": "value"}' },
    ]);
    expect(clone.prompts[0]!.input).toBe("the one and only prompt");
  });

  test("the JSON schema is passed through as responseConstraint with omitResponseConstraintInput true", async () => {
    const model = new FakeLanguageModel();
    model.availabilityValue = "available";
    model.chunks = [wellFormedResponse()];
    const chat = new OnDeviceChat({ languageModel: model });

    await chat.complete(makeRequest());

    const clone = model.sessions[1]!;
    expect(clone.prompts[0]!.options).toMatchObject({
      responseConstraint: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
      },
      omitResponseConstraintInput: true,
    });
  });

  test("model and maxTokens are ignored and the call succeeds", async () => {
    const model = new FakeLanguageModel();
    model.availabilityValue = "available";
    model.chunks = [wellFormedResponse()];
    const chat = new OnDeviceChat({ languageModel: model });

    const completion = await chat.complete(
      makeRequest({ model: "some-unsupported-model", maxTokens: 999_999 }),
    );

    expect(completion.content).toBe(wellFormedResponse());
    expect(completion.finishReason).toBe("stop");
  });

  test("every successful completion carries a finishReason", async () => {
    const model = new FakeLanguageModel();
    model.availabilityValue = "available";
    model.chunks = [wellFormedResponse()];
    const chat = new OnDeviceChat({ languageModel: model });

    const completion = await chat.complete(makeRequest());

    expect(completion.finishReason).toBe("stop");
  });
});

describe("OnDeviceChat pre-flight", () => {
  test("an input larger than the context window fails before any prompt is issued", async () => {
    const model = new FakeLanguageModel();
    model.availabilityValue = "available";
    // Fake measureContextUsage uses ceil(length * 0.26), so 40,000 'x' tokens
    // is well past the 9,216-token context window.
    const transcript = "x".repeat(40_000);
    const chat = new OnDeviceChat({ languageModel: model });

    await expect(chat.complete(makeRequest({ transcript }))).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ChatError &&
        error.kind === "unsupported" &&
        error.message.includes("context window"),
    );

    const clone = model.sessions[1]!;
    expect(clone).toBeDefined();
    expect(clone.prompts).toHaveLength(0);
  });
});

describe("OnDeviceChat error mapping", () => {
  test("NotSupportedError from the model is unsupported", async () => {
    const model = new FakeLanguageModel();
    model.availabilityValue = "available";
    model.promptError = new DOMException(
      "A constraint is not supported by this model",
      "NotSupportedError",
    );
    const chat = new OnDeviceChat({ languageModel: model });

    await expect(chat.complete(makeRequest())).rejects.toSatisfy(
      (error: unknown) => error instanceof ChatError && error.kind === "unsupported",
    );
  });

  test("SyntaxError from the model is malformed", async () => {
    const model = new FakeLanguageModel();
    model.availabilityValue = "available";
    model.promptError = new SyntaxError("constraint unsatisfiable");
    const chat = new OnDeviceChat({ languageModel: model });

    await expect(chat.complete(makeRequest())).rejects.toSatisfy(
      (error: unknown) => error instanceof ChatError && error.kind === "malformed-response",
    );
  });

  test("NetworkError from the model is transport", async () => {
    const model = new FakeLanguageModel();
    model.availabilityValue = "available";
    model.promptError = new DOMException("Model fetch failed", "NetworkError");
    const chat = new OnDeviceChat({ languageModel: model });

    await expect(chat.complete(makeRequest())).rejects.toSatisfy(
      (error: unknown) => error instanceof ChatError && error.kind === "transport",
    );
  });

  test("a caller abort signal rejects with aborted", async () => {
    const model = new FakeLanguageModel();
    model.availabilityValue = "available";
    model.chunks = ["a", "b", "c"];
    model.chunkDelayMs = 10;
    const chat = new OnDeviceChat({ languageModel: model });
    const abort = new AbortController();

    setTimeout(() => abort.abort("test abort"), 15);

    await expect(chat.complete(makeRequest(), { signal: abort.signal })).rejects.toSatisfy(
      (error: unknown) => error instanceof ChatError && error.kind === "aborted",
    );
  });

  test("QuotaExceededError is transient, not terminal refusal or unsupported", async () => {
    const model = new FakeLanguageModel();
    model.availabilityValue = "available";
    model.promptError = new DOMException(
      "The response exceeded output limits and was truncated",
      "QuotaExceededError",
    );
    const chat = new OnDeviceChat({ languageModel: model });

    let error: unknown;
    try {
      await chat.complete(makeRequest());
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(ChatError);
    const chatError = error as ChatError;
    // Output truncation on-device is degenerate looping, not genuine truncation.
    // Treating it as `refusal` or `unsupported` would make completeOrClassify
    // terminal, disabling the retry that measurement showed is the fix.
    expect(chatError.kind).not.toBe("refusal");
    expect(chatError.kind).not.toBe("unsupported");
    expect(chatError.kind).toBe("transport");
  });
});

describe("OnDeviceChat streaming", () => {
  test("a well-formed response is returned whole", async () => {
    const model = new FakeLanguageModel();
    model.availabilityValue = "available";
    model.chunks = [wellFormedResponse()];
    const chat = new OnDeviceChat({ languageModel: model });

    const completion = await chat.complete(makeRequest());

    expect(completion.content).toBe(wellFormedResponse());
    expect(completion.finishReason).toBe("stop");
  });

  test("a stream that degenerates into trailing whitespace is aborted mid-stream", async () => {
    const model = new FakeLanguageModel();
    model.availabilityValue = "available";
    model.chunks = degenerateResponse();
    model.chunkDelayMs = 1;
    const chat = new OnDeviceChat({ languageModel: model });

    let error: unknown;
    try {
      await chat.complete(makeRequest());
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(ChatError);
    const chatError = error as ChatError;
    expect(chatError.kind).not.toBe("refusal");
    expect(chatError.kind).not.toBe("unsupported");

    const clone = model.sessions[1]!;
    expect(clone).toBeDefined();
    // The generator must have noticed the abort, not just had the consumer stop
    // pulling chunks.
    expect(clone.streamCancelled).toBe(true);
  });

  test("a stream that does not degenerate but exceeds the deadline is aborted", async () => {
    const model = new FakeLanguageModel();
    model.availabilityValue = "available";
    model.chunks = ["first", "second"];
    model.chunkDelayMs = 100;
    const chat = new OnDeviceChat({ languageModel: model, deadlineMs: 50 });

    let error: unknown;
    try {
      await chat.complete(makeRequest());
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(ChatError);
    const chatError = error as ChatError;
    expect(chatError.kind).not.toBe("refusal");
    expect(chatError.kind).not.toBe("unsupported");
    expect(chatError.kind).toBe("transport");

    const clone = model.sessions[1]!;
    expect(clone.streamCancelled).toBe(true);
  });

  test("a caller abort signal cancels the stream mid-flight", async () => {
    const model = new FakeLanguageModel();
    model.availabilityValue = "available";
    model.chunks = ["a", "b", "c"];
    model.chunkDelayMs = 10;
    const chat = new OnDeviceChat({ languageModel: model });
    const abort = new AbortController();

    setTimeout(() => abort.abort("caller abort"), 15);

    let error: unknown;
    try {
      await chat.complete(makeRequest(), { signal: abort.signal });
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(ChatError);
    const chatError = error as ChatError;
    expect(chatError.kind).toBe("aborted");

    const clone = model.sessions[1]!;
    expect(clone.streamCancelled).toBe(true);
  });
});
