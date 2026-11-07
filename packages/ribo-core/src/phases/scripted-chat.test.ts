import { z } from "zod";
import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import { isCancellation } from "../async/cancellation.js";
import { ChatError } from "./chat-client.js";
import type { CapableChatClient, ChatRequest } from "./chat-client.js";
import { scriptedChat } from "./scripted-chat.js";
import type { ScriptedChatClient, ScriptedChatContext } from "./scripted-chat.js";
import {
  FakeExtractor,
  enveloped,
  extractGroups,
  fallbackExtractor,
  presencePhase,
  singleShotExtractor,
  terminalFallsThrough,
  validatePhases,
} from "../index.js";
import type { ExtractionTarget } from "../index.js";

/**
 * Behavioural tests for the public scripted chat client. Everything here goes through the
 * same surface a consumer sees — the factory and the client it returns — plus the public
 * extractors it must be able to drive (`singleShotExtractor`, the phased phases) and the
 * arbitration ladder whose errors it must be able to model. No matcher DSL exists to test;
 * every "switch on the schema name" below is plain caller code inside a callback, which is
 * the point.
 */

const contactSchema = z.strictObject({ company: z.string().nullable().optional() });
const contactExtractionSchema = enveloped(contactSchema);
type ContactValues = z.infer<typeof contactSchema>;

const contactTarget: ExtractionTarget<ContactValues> = {
  name: "contact",
  extractionSchema: contactExtractionSchema,
  instructions: "Extract the caller's details.",
  examples: [],
};

// A GROUP-shaped schema for the phase-composition test: `extractGroups` (the phased
// strategy's walk) needs an object group whose leaves carry per-leaf envelopes, so a flat
// top-level leaf — fine for single-shot — is not enough here.
const hvacValuesSchema = z
  .strictObject({
    hvac: z.strictObject({ fuel: z.string().nullable().optional() }).optional(),
  })
  .strict();
const hvacExtractionSchema = enveloped(hvacValuesSchema);
type HvacValues = z.infer<typeof hvacValuesSchema>;

/** A valid enveloped body for `contactTarget` — what the model would emit under strict mode. */
const contactReply = {
  company: { value: "Acme", confidence: 0.9, sourceSpan: "Acme" },
};

const transcript = { text: "The company is Acme.", annotations: {} };

afterEach(() => {
  vi.useRealTimers();
});

describe("scriptedChat", () => {
  test("a fixed reply returns that content on every call, with finishReason stop by default", async () => {
    const chat = scriptedChat('{"a":1}');
    const first = await chat.complete(request());
    const second = await chat.complete(request());
    expect(first).toEqual({ content: '{"a":1}', finishReason: "stop" });
    expect(second).toEqual({ content: '{"a":1}', finishReason: "stop" });
  });

  test("a callback is invoked once per call with the sent request and the context", async () => {
    const seen: { request: ChatRequest; context: ScriptedChatContext }[] = [];
    const chat = scriptedChat((request, context) => {
      seen.push({ request, context });
      return "ok";
    });
    const controller = new AbortController();
    await chat.complete(request(), {});
    await chat.complete(request(), { signal: controller.signal });
    await chat.complete(request());

    expect(seen.map(({ context }) => context.call)).toEqual([0, 1, 2]);
    expect(seen[0]?.request).toEqual(request());
    expect(seen[1]?.context.signal).toBe(controller.signal);
    expect(seen[0]?.context.signal).toBeUndefined();
    expect(seen[2]?.context.signal).toBeUndefined();
  });

  test("a callback switching on the schema name drives singleShotExtractor end to end", async () => {
    const chat = scriptedChat((request) => {
      // Plain caller code — there is no rule list: dispatch on the extraction target's name.
      if (request.response_format.json_schema.name === "contact") {
        return { content: contactReply };
      }
      throw new Error(`unexpected schema: ${request.response_format.json_schema.name}`);
    });
    const extractor = singleShotExtractor({ target: contactTarget, chat, model: "fake" });

    const result = await extractor.extract(transcript, {});

    // The resolved fields parse against the target's enveloped schema — typed, span-quoted.
    expect(result.fields.company).toEqual({
      value: "Acme",
      confidence: 0.9,
      sourceSpan: "Acme",
    });
    expect(result.usage.calls).toBe(1);
    // And the scripted client saw the full request the extractor built.
    expect(chat.calls).toHaveLength(1);
    expect(chat.calls[0]?.response_format.json_schema.name).toBe("contact");
    expect(chat.calls[0]?.model).toBe("fake");
  });

  test("object and array content is JSON-serialised", async () => {
    const objectChat = scriptedChat({ content: { a: 1 } });
    const arrayChat = scriptedChat({ content: [{ a: 1 }] });
    const objectCompletion = await objectChat.complete(request());
    const arrayCompletion = await arrayChat.complete(request());
    expect(objectCompletion).toEqual({ content: '{"a":1}', finishReason: "stop" });
    expect(arrayCompletion).toEqual({ content: '[{"a":1}]', finishReason: "stop" });
  });

  test("finishReason and usage are carried through when the reply names them", async () => {
    const usage = { promptTokens: 10, completionTokens: 5, cachedPromptTokens: 4 };
    const chat = scriptedChat({ content: "x", finishReason: "length", usage });
    const completion = await chat.complete(request());
    expect(completion).toEqual({ content: "x", finishReason: "length", usage });
  });

  test("calls records every request in order, including failures and aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    let call = 0;
    const chat = scriptedChat(() => {
      if (call++ === 1) throw ChatError.http(503, "down");
      return "fine";
    });
    const first = request();

    await chat.complete(first);
    await expect(chat.complete(request())).rejects.toThrow();
    await expect(chat.complete(request(), { signal: controller.signal })).rejects.toThrow();

    expect(chat.calls).toHaveLength(3);
    expect(chat.calls[0]).toEqual(first);
    expect(chat.calls[1]).toEqual(request());
    expect(chat.calls[2]).toEqual(request());
  });

  test("a thrown ChatError and a thrown plain Error propagate unchanged", async () => {
    const chatError = ChatError.http(503, "bad gateway");
    const chat = scriptedChat(() => {
      throw chatError;
    });
    await expect(chat.complete(request())).rejects.toBe(chatError);

    const plain = new Error("script bug");
    const other = scriptedChat(() => {
      throw plain;
    });
    await expect(other.complete(request())).rejects.toBe(plain);
  });

  test("a terminal ChatError (refusal) falls through the fallbackExtractor ladder", async () => {
    // The default arbiter (`terminalFallsThrough`) continues past a TERMINAL error — the
    // request itself is broken, and a different strategy might fix it. `completeOrClassify`
    // classifies `refusal` as terminal before the arbiter ever sees it.
    const failing = singleShotExtractor({
      target: contactTarget,
      chat: scriptedChat(() => {
        throw ChatError.refusal("the model declined");
      }),
      model: "fake",
    });
    const fallback = new FakeExtractor(contactReply);
    const extractor = fallbackExtractor(
      [
        { strategy: "scripted", extractor: failing },
        { strategy: "fake", extractor: fallback },
      ],
      terminalFallsThrough,
    );

    const result = await extractor.extract(transcript, {});
    expect(result.fields).toEqual(contactReply);
    expect(result.usage.strategy).toBe("fake");
  });

  test("a transient ChatError (transport) does NOT fall through under terminalFallsThrough", async () => {
    // The documented direction of `terminalFallsThrough`, pinned here because it is the
    // opposite of what a first reading suggests: a transient error means the transport is
    // down and the next strategy shares it, so the arbiter gives up for the relay to retry.
    const chatError = ChatError.transport("uplink down");
    const failing = singleShotExtractor({
      target: contactTarget,
      chat: scriptedChat(() => {
        throw chatError;
      }),
      model: "fake",
    });
    const fallback = new FakeExtractor(contactReply);
    const extractor = fallbackExtractor(
      [
        { strategy: "scripted", extractor: failing },
        { strategy: "fake", extractor: fallback },
      ],
      terminalFallsThrough,
    );

    await expect(extractor.extract(transcript, {})).rejects.toBe(chatError);
    expect(fallback.calls).toEqual([]);
  });

  test("an arbiter that continues past transient errors sees the exact ChatError and falls through", async () => {
    // The same ladder under a caller's own arbiter: the ChatError the scripted chat threw
    // arrives at arbitration unchanged (kind, identity), so a deployment that WANTS transient
    // fall-through gets it with ordinary caller code.
    const chatError = ChatError.transport("uplink down");
    const seen: unknown[] = [];
    const failing = singleShotExtractor({
      target: contactTarget,
      chat: scriptedChat(() => {
        throw chatError;
      }),
      model: "fake",
    });
    const fallback = new FakeExtractor(contactReply);
    const extractor = fallbackExtractor(
      [
        { strategy: "scripted", extractor: failing },
        { strategy: "fake", extractor: fallback },
      ],
      (input) => {
        for (const outcome of input.outcomes) {
          if (outcome.outcome === "error") seen.push(outcome.error);
        }
        // Exhaustion is checked first — a verdict of `continue` there is a caller bug.
        const firstResult = input.outcomes.find((o) => o.outcome === "result");
        if (input.exhausted) {
          return firstResult
            ? { accept: firstResult.result }
            : { giveUp: input.outcomes.find((o) => o.outcome === "error")?.error };
        }
        return { continue: true };
      },
    );

    const result = await extractor.extract(transcript, {});
    expect(result.fields).toEqual(contactReply);
    expect(seen).toContain(chatError);
    expect(seen.at(-1)).toBeInstanceOf(ChatError);
  });

  test("an already-aborted signal rejects with ChatError.aborted before the callback runs", async () => {
    const controller = new AbortController();
    controller.abort();
    let invoked = false;
    const chat = scriptedChat(() => {
      invoked = true;
      return "nope";
    });

    const rejection = chat.complete(request(), { signal: controller.signal });
    await expect(rejection).rejects.toMatchObject({ kind: "aborted" });
    await rejection.catch((error: unknown) => {
      expect(error).toBeInstanceOf(ChatError);
      expect(isCancellation(error)).toBe(true);
    });
    expect(invoked).toBe(false);
    // Still recorded — recording happens before the abort check.
    expect(chat.calls).toHaveLength(1);
  });

  test("an abort during the delay rejects promptly, well before the delay elapses", async () => {
    const controller = new AbortController();
    const chat = scriptedChat({ content: "slow", delay: 10_000 });
    const pending = chat.complete(request(), { signal: controller.signal });

    setTimeout(() => controller.abort(), 20);
    const startedAt = Date.now();
    await expect(pending).rejects.toMatchObject({ kind: "aborted" });
    const elapsed = Date.now() - startedAt;
    await pending.catch((error: unknown) => {
      expect(error).toBeInstanceOf(ChatError);
      expect(isCancellation(error)).toBe(true);
    });
    expect(elapsed).toBeLessThan(5_000);
  });

  test("without an abort, a delayed reply resolves after roughly the delay", async () => {
    vi.useFakeTimers();
    const chat = scriptedChat({ content: "slow", delay: 10_000 });
    const pending = chat.complete(request());

    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ content: "slow", finishReason: "stop" });
  });

  test("capability is poll-based, controllable at runtime, and the engine is overridable", async () => {
    const ready = scriptedChat("ok");
    expect(ready.engine).toBe("scripted");
    await expect(ready.capability()).resolves.toEqual({ status: "ready" });

    const offline = scriptedChat("ok", {
      engine: "fake-openai",
      capability: { status: "unavailable", reason: "offline", detail: "no uplink" },
    });
    expect(offline.engine).toBe("fake-openai");
    await expect(offline.capability()).resolves.toEqual({
      status: "unavailable",
      reason: "offline",
      detail: "no uplink",
    });

    // setCapability is chainable, and later capability() calls observe the change — the
    // contract is poll-based; there is no subscription to notify.
    expect(offline.setCapability({ status: "needs-download" })).toBe(offline);
    await expect(offline.capability()).resolves.toEqual({ status: "needs-download" });
    await expect(ready.capability()).resolves.toEqual({ status: "ready" });
  });

  test("reset clears calls, restores the constructed capability, and restarts call numbering", async () => {
    const seen: number[] = [];
    const chat = scriptedChat((request, context) => {
      seen.push(context.call);
      return "ok";
    });
    await chat.complete(request());
    await chat.complete(request());
    chat.setCapability({ status: "unavailable", reason: "offline", detail: "no uplink" });

    chat.reset();

    expect(chat.calls).toEqual([]);
    await expect(chat.capability()).resolves.toEqual({ status: "ready" });
    await chat.complete(request());
    expect(seen).toEqual([0, 1, 0]);
  });

  test("concurrent calls are recorded in arrival order with their own call numbers and replies", async () => {
    const chat = scriptedChat((request, context) => ({ content: `reply ${context.call}` }));
    const [first, second] = await Promise.all([chat.complete(request()), chat.complete(request())]);
    expect(first.content).toBe("reply 0");
    expect(second.content).toBe("reply 1");
    expect(chat.calls).toHaveLength(2);
  });

  test("the client satisfies CapableChatClient and composes with the chat-based extractors", () => {
    const chat = scriptedChat("ok");
    expectTypeOf(chat).toExtend<CapableChatClient>();
    expectTypeOf<ScriptedChatClient>().toExtend<CapableChatClient>();

    // Assignability to the chat parameter of the chat-based extractors and phases — proven
    // at compile time by constructing them, the way public-composition.test.ts composes.
    singleShotExtractor({ target: contactTarget, chat, model: "fake" });
    const groups = extractGroups(z.toJSONSchema(hvacExtractionSchema));
    validatePhases([presencePhase<HvacValues>({ groups, chat, model: "fake" })]);
  });

  test("degenerate delays behave as no delay", async () => {
    for (const delay of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const chat = scriptedChat({ content: "x", delay });
      await expect(chat.complete(request())).resolves.toEqual({
        content: "x",
        finishReason: "stop",
      });
    }
  });

  test("content that cannot be serialised rejects unwrapped, with the call still recorded", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const chat = scriptedChat({ content: circular });

    const rejection = chat.complete(request());
    await expect(rejection).rejects.toThrow(TypeError);
    await rejection.catch((error: unknown) => {
      expect(error).not.toBeInstanceOf(ChatError);
    });
    expect(chat.calls).toHaveLength(1);
  });
});

/** A minimal valid request — the shape the extractors build, small enough to read in a test. */
function request(): ChatRequest {
  return {
    model: "fake",
    messages: [{ role: "user", content: "hello" }],
    response_format: {
      type: "json_schema",
      json_schema: { name: "contact", schema: { type: "object" }, strict: true },
    },
  };
}
