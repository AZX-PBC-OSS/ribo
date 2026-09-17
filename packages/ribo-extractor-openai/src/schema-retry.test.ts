import { enveloped, isTransientFailure, SchemaParseError, TerminalError } from "@azx/ribo-core";
import type { Enveloped, ExtractionTarget } from "@azx/ribo-core";
import { z } from "zod";
import { describe, expect, test } from "vitest";

import { ChatError } from "./chat-client.js";
import type { ChatClient, ChatCompletion, ChatRequest } from "./chat-client.js";
import { schemaRetryExtractor } from "./schema-retry.js";
import { singleShotExtractor } from "./single-shot.js";

/**
 * Key-free CI tests for the schema-retry combinator, against a small
 * self-contained target — the same fixture discipline as `gap-fill.test.ts`.
 * The base is a REAL `singleShotExtractor` over a scripted {@link ChatClient},
 * so the retry is proved against the genuine failure path: a completion that
 * parses as JSON but fails `parseWithSchema`, carrying the rejected payload on
 * `SchemaParseError.output`. Nothing touches the network.
 *
 * The load-bearing assertion in every retry test is that the message carrying
 * the transcript is byte-for-byte the caller's string on every attempt —
 * `spanGroundedness` checks quotes against the real transcript at review time,
 * so feeding feedback through the transcript text would manufacture
 * `ungrounded` spans and re-present the model's bad values as citable source.
 */

const valuesSchema = z
  .object({
    envelope: z
      .object({
        roof: z.enum(["asphalt_shingle", "metal", "tile"]).nullable().optional(),
        stories: z.number().nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
type Values = z.infer<typeof valuesSchema>;
type Extraction = Enveloped<Values>;

const target: ExtractionTarget<Values> = {
  name: "retry-demo",
  extractionSchema: enveloped(valuesSchema),
  instructions: "Extract the roof covering and the storey count. Emit null for anything unstated.",
};

const transcript = "The roof is asphalt shingle. The house is two stories.";

/** Fails the schema: a string where `stories.value` must be a number. */
const badOutput = {
  envelope: {
    roof: { value: "asphalt_shingle", confidence: 0.9, sourceSpan: "asphalt shingle" },
    stories: { value: "two", confidence: 0.8, sourceSpan: "two stories" },
  },
};

/** Passes the schema: the same spans, `stories` committed as a number. */
const goodOutput = {
  envelope: {
    roof: { value: "asphalt_shingle", confidence: 0.9, sourceSpan: "asphalt shingle" },
    stories: { value: 2, confidence: 0.95, sourceSpan: "two stories" },
  },
};

const completion = (body: unknown, usage?: ChatCompletion["usage"]): ChatCompletion => ({
  content: JSON.stringify(body),
  finishReason: "stop",
  ...(usage !== undefined ? { usage } : {}),
});

/** A ChatClient that records every request and replays a script of completions or errors. */
function scriptedChat(script: readonly (ChatCompletion | Error)[]): {
  chat: ChatClient;
  requests: ChatRequest[];
} {
  const requests: ChatRequest[] = [];
  const chat: ChatClient = {
    complete: (request) => {
      requests.push(request);
      const step = script[requests.length - 1];
      if (step === undefined) return Promise.reject(new Error("scripted chat exhausted"));
      return step instanceof Error ? Promise.reject(step) : Promise.resolve(step);
    },
  };
  return { chat, requests };
}

/** Rejects with the caught error, or throws if `promise` unexpectedly resolved. */
const catchRejection = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => {
      throw new Error("expected extract() to reject");
    },
    (caught: unknown) => caught,
  );

/** A retry-wrapped single-shot extractor over `script`. */
const wrapped = (chat: ChatClient, options: { maxRetries?: number } = {}) =>
  schemaRetryExtractor({
    base: singleShotExtractor({ target, chat, model: "m" }),
    target,
    chat,
    model: "m",
    ...options,
  });

describe("schemaRetryExtractor — the self-correction retry", () => {
  test("a validation failure is retried once and the corrected result returned", async () => {
    const { chat, requests } = scriptedChat([
      completion(badOutput),
      completion(goodOutput, { promptTokens: 60, completionTokens: 20 }),
    ]);

    const result = await wrapped(chat).extract({ text: transcript, annotations: {} });

    expect(result.fields).toEqual(goodOutput);
    expect(result.raw).toEqual(goodOutput);
    expect(requests).toHaveLength(2);
  });

  test("the retry shows the model its failed output and the validation error — transcript untouched", async () => {
    const { chat, requests } = scriptedChat([completion(badOutput), completion(goodOutput)]);

    await wrapped(chat).extract({ text: transcript, annotations: {} });

    const retry = requests[1]!;
    // The regression test for transcript-augmentation: the message carrying the
    // transcript is byte-for-byte the caller's string. If feedback were ever
    // appended to the document text, this is the assertion that catches it.
    const transcriptTurns = retry.messages.filter((m) => m.content.includes(transcript));
    expect(transcriptTurns).toHaveLength(1);
    expect(transcriptTurns[0]).toEqual({ role: "user", content: transcript });
    // And no turn anywhere carries the transcript with anything appended.
    for (const message of retry.messages) {
      if (message.content !== transcript) expect(message.content).not.toContain(transcript);
    }

    // The failed output reached the model as an ASSISTANT turn — its own
    // previous answer, not document text...
    const assistant = retry.messages.find((m) => m.role === "assistant");
    expect(assistant?.content).toBe(JSON.stringify(badOutput));
    // ...and the validation error reached it as a USER turn naming what failed.
    const feedback = retry.messages.at(-1)!;
    expect(feedback.role).toBe("user");
    expect(feedback.content).toContain("did not match the schema");
    expect(feedback.content).toContain("stories");

    // The original prompt is otherwise unchanged: same system instructions,
    // same response SCHEMA (the retry's response_format name differs — `-retry`
    // — but the contract pinned to the model is the target's own).
    expect(retry.messages[0]).toEqual(requests[0]!.messages[0]);
    expect(retry.response_format.json_schema.name).toBe("retry-demo-retry");
    expect(retry.response_format.json_schema.schema).toEqual(
      requests[0]!.response_format.json_schema.schema,
    );
  });

  test("SchemaParseError carries the rejected payload on `output`", async () => {
    const { chat } = scriptedChat([completion(badOutput), completion(badOutput)]);

    const error = await catchRejection(
      wrapped(chat, { maxRetries: 1 }).extract({ text: transcript, annotations: {} }),
    );

    expect(error).toBeInstanceOf(SchemaParseError);
    expect((error as SchemaParseError).output).toEqual(badOutput);
  });

  test("a second failure feeds the NEW error back: attempt two carries both rejected answers", async () => {
    // A SECOND schema failure, distinct from the first: a string again, but a
    // different one, so the two rejected answers cannot be confused.
    const secondBad = {
      envelope: {
        ...badOutput.envelope,
        stories: { value: "two and a half", confidence: 0.7, sourceSpan: "two" },
      },
    };
    const { chat, requests } = scriptedChat([
      completion(badOutput),
      completion(secondBad),
      completion(goodOutput),
    ]);

    const result = await wrapped(chat, { maxRetries: 2 }).extract({
      text: transcript,
      annotations: {},
    });

    expect(result.fields).toEqual(goodOutput);
    expect(requests).toHaveLength(3);
    const finalRetry = requests[2]!;
    const assistants = finalRetry.messages.filter((m) => m.role === "assistant");
    expect(assistants.map((m) => m.content)).toEqual([
      JSON.stringify(badOutput),
      JSON.stringify(secondBad),
    ]);
    // The transcript turn is still exactly the caller's string, three attempts in.
    expect(finalRetry.messages.filter((m) => m.content === transcript)).toHaveLength(1);
  });

  test("normalize runs on a retry's parsed fields — the trust boundary does not lapse on retry", async () => {
    const wild = {
      envelope: {
        ...goodOutput.envelope,
        stories: { value: 2, confidence: 1.7, sourceSpan: "two stories" },
      },
    };
    const { chat } = scriptedChat([completion(badOutput), completion(wild)]);
    const extractor = schemaRetryExtractor({
      base: singleShotExtractor({ target, chat, model: "m" }),
      target,
      chat,
      model: "m",
      normalize: (fields): Extraction => ({
        ...fields,
        envelope: fields.envelope && {
          ...fields.envelope,
          stories: fields.envelope.stories && {
            ...fields.envelope.stories,
            confidence: Math.min(1, fields.envelope.stories.confidence),
          },
        },
      }),
    });

    const result = await extractor.extract({ text: transcript, annotations: {} });

    expect(result.fields.envelope?.stories?.confidence).toBe(1);
  });
});

describe("schemaRetryExtractor — what is NOT retried", () => {
  test("a transport error passes through untouched, same object, no second call", async () => {
    const transport = ChatError.transport("connection reset");
    const { chat, requests } = scriptedChat([transport]);

    const error = await catchRejection(
      wrapped(chat).extract({ text: transcript, annotations: {} }),
    );

    expect(error).toBe(transport);
    expect(requests).toHaveLength(1);
  });

  test("a truncated base response (terminal) passes through untouched", async () => {
    const { chat, requests } = scriptedChat([
      { content: JSON.stringify(badOutput), finishReason: "length" },
    ]);

    const error = await catchRejection(
      wrapped(chat).extract({ text: transcript, annotations: {} }),
    );

    expect(error).toBeInstanceOf(TerminalError);
    expect(requests).toHaveLength(1);
  });

  test("a retry's own non-schema failure (truncation) is not swallowed by the loop", async () => {
    const { chat, requests } = scriptedChat([
      completion(badOutput),
      { content: JSON.stringify(goodOutput), finishReason: "length" },
    ]);

    const error = await catchRejection(
      wrapped(chat, { maxRetries: 2 }).extract({ text: transcript, annotations: {} }),
    );

    expect(error).toBeInstanceOf(TerminalError);
    expect((error as Error).message).toContain("maxTokens");
    expect(requests).toHaveLength(2);
  });

  test("a base success passes through unchanged — no wrapper call, no usage change", async () => {
    const { chat, requests } = scriptedChat([
      completion(goodOutput, { promptTokens: 50, completionTokens: 15 }),
    ]);

    const result = await wrapped(chat).extract({ text: transcript, annotations: {} });

    expect(result.fields).toEqual(goodOutput);
    expect(result.usage).toEqual({ calls: 1, promptTokens: 50, completionTokens: 15 });
    expect(requests).toHaveLength(1);
  });
});

describe("schemaRetryExtractor — the budget", () => {
  test("a zero budget disables retrying and surfaces the base's failure", async () => {
    const { chat, requests } = scriptedChat([completion(badOutput)]);

    const error = await catchRejection(
      wrapped(chat, { maxRetries: 0 }).extract({ text: transcript, annotations: {} }),
    );

    expect(error).toBeInstanceOf(SchemaParseError);
    expect(requests).toHaveLength(1);
  });

  test("an exhausted budget rethrows the last SchemaParseError, still transient and recognisable", async () => {
    const { chat, requests } = scriptedChat([completion(badOutput), completion(badOutput)]);

    const error = await catchRejection(
      wrapped(chat, { maxRetries: 1 }).extract({ text: transcript, annotations: {} }),
    );

    // Meaningfully the original failure: the same recognisable, sampled-miss
    // error a strategy ladder or the queue already knows how to handle.
    expect(error).toBeInstanceOf(SchemaParseError);
    expect((error as Error).message).toContain("did not match the schema");
    expect(isTransientFailure(error)).toBe(true);
    // The budget held: base attempt plus one retry, no more.
    expect(requests).toHaveLength(2);
  });

  test("a non-integer or negative budget is a configuration error at construction", () => {
    const { chat } = scriptedChat([]);
    expect(() => wrapped(chat, { maxRetries: 1.5 })).toThrow(TypeError);
    expect(() => wrapped(chat, { maxRetries: -1 })).toThrow(TypeError);
  });
});

describe("schemaRetryExtractor — usage", () => {
  test("usage counts the retry call and sums its tokens across attempts", async () => {
    const { chat } = scriptedChat([
      completion(badOutput),
      completion(badOutput, { promptTokens: 40, completionTokens: 10 }),
      completion(goodOutput, { promptTokens: 60, completionTokens: 20 }),
    ]);

    const result = await wrapped(chat, { maxRetries: 2 }).extract({
      text: transcript,
      annotations: {},
    });

    // Two real model calls beyond the base attempt, tokens summed. The failed
    // base call reported nothing — a rejected extract() has no usage to carry.
    expect(result.usage).toEqual({ calls: 2, promptTokens: 100, completionTokens: 30 });
  });

  test("a retry that reports no usage leaves token totals absent, not zero", async () => {
    const { chat } = scriptedChat([completion(badOutput), completion(goodOutput)]);

    const result = await wrapped(chat).extract({ text: transcript, annotations: {} });

    expect(result.usage).toEqual({ calls: 1 });
  });
});
