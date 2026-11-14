/**
 * @file The prompt assembly: the manifest's instructions, its examples and its
 * group instructions, and the field-descriptions mode.
 *
 * The assertions are made on the requests the stub received — the prompt is
 * what the model was actually asked, not what the runner meant to ask.
 */
import path from "node:path";

import { afterEach, expect, test } from "vitest";

import { loadCorpus } from "../corpus/loader.js";
import { runEval } from "./run.js";
import { stubChat } from "./test-support/stub-chat.js";
import {
  copiedCorpus,
  corpusWithoutDocuments,
  editJson,
  removeTemporaries,
} from "./test-support/corpus.js";

afterEach(() => {
  removeTemporaries();
});

/** The system message of a request. */
const systemMessage = (request: {
  messages: readonly { role: string; content: string }[];
}): string => request.messages.find((message) => message.role === "system")?.content ?? "";

/** The messages of a request, in order. */
const messagesOf = (request: { messages: readonly { role: string; content: string }[] }) =>
  request.messages;

/** The assistant turn of a request — the example's answer, as the model saw it. */
const assistantTurn = (request: {
  messages: readonly { role: string; content: string }[];
}): string | undefined => request.messages.find((message) => message.role === "assistant")?.content;

// ---------------------------------------------------------------------------
// The instructions
// ---------------------------------------------------------------------------

test("the manifest's instructions reach the model verbatim, as the system message", async () => {
  const dir = copiedCorpus(corpusWithoutDocuments(), (copy) => {
    // No per-group instructions: every request carries the main ones.
    editJson(path.join(copy, "manifest.json"), (document) => {
      const prompt = document["prompt"] as Record<string, unknown>;
      delete prompt["groupInstructions"];
    });
  });
  const corpus = loadCorpus(dir);

  for (const strategy of ["single-shot", "per-group"] as const) {
    const chat = stubChat();
    await runEval(corpus, chat, { strategies: [strategy], model: "ribo-test" });

    expect(chat.calls.length).toBeGreaterThan(0);
    for (const request of chat.calls) {
      expect(systemMessage(request)).toBe(corpus.manifest.prompt.instructions);
    }
  }
});

// ---------------------------------------------------------------------------
// The examples
// ---------------------------------------------------------------------------

test("a corpus example reaches the prompt as a turn pair, translated into the wire shape", async () => {
  const corpus = loadCorpus(corpusWithoutDocuments());
  const chat = stubChat();

  await runEval(corpus, chat, { strategies: ["single-shot"], model: "ribo-test" });

  const request = chat.calls[0];
  expect(request).toBeDefined();
  if (request === undefined) throw new Error("the stub received no request");

  const roles = messagesOf(request).map((message) => message.role);
  // The example's transcript is a user turn, its answer an assistant turn.
  expect(roles).toEqual(["system", "user", "assistant", "user"]);
  expect(messagesOf(request)[1]?.content).toBe(corpus.manifest.prompt.examples?.[0]?.transcript);

  // The assistant turn carries the enveloped, nested-by-group translation of
  // the manifest's flat dotted-path values.
  const turn = assistantTurn(request);
  expect(turn).toBeDefined();
  expect(JSON.parse(turn ?? "{}")).toEqual({
    frame: {
      material: { value: "steel", confidence: 1, sourceSpan: null },
      serial: { value: "BW-1000", confidence: 1, sourceSpan: null },
    },
  });
});

test("a per-group call carries only its own group's projected example", async () => {
  const corpus = loadCorpus(corpusWithoutDocuments());
  const chat = stubChat();

  await runEval(corpus, chat, { strategies: ["per-group"], model: "ribo-test" });

  const frame = chat.calls.find((request) =>
    request.responseFormat.json_schema.name.endsWith("frame"),
  );
  const service = chat.calls.find((request) =>
    request.responseFormat.json_schema.name.endsWith("service"),
  );
  expect(frame).toBeDefined();
  expect(service).toBeDefined();
  if (frame === undefined || service === undefined) throw new Error("a group was never asked");

  // The frame call carries the example, projected to the frame group.
  expect(JSON.parse(assistantTurn(frame) ?? "{}")).toEqual({
    frame: {
      material: { value: "steel", confidence: 1, sourceSpan: null },
      serial: { value: "BW-1000", confidence: 1, sourceSpan: null },
    },
  });
  // The service call carries none: the example says nothing about that group.
  // Must-fail: passing the manifest's flat map through verbatim puts the
  // dotted-path map in the assistant turn, and the projection assertions see
  // no per-group example at all.
  expect(assistantTurn(service)).toBeUndefined();
});

test("a presence-fill call carries only its own group's projected example", async () => {
  const corpus = loadCorpus(corpusWithoutDocuments());
  const chat = stubChat();

  await runEval(corpus, chat, { strategies: ["presence-narrowed"], model: "ribo-test" });

  const fill = chat.calls.find((request) =>
    request.responseFormat.json_schema.name.endsWith("ribo-eval-frame"),
  );
  expect(fill).toBeDefined();
  if (fill === undefined) throw new Error("the fill phase never asked about the frame group");

  // The fill call is asked for the frame group alone, and it carries the
  // example projected to that group.
  expect(JSON.parse(assistantTurn(fill) ?? "{}")).toEqual({
    frame: {
      material: { value: "steel", confidence: 1, sourceSpan: null },
      serial: { value: "BW-1000", confidence: 1, sourceSpan: null },
    },
  });
});

test("a corpus with no group instructions still projects the example per group", async () => {
  const dir = copiedCorpus(corpusWithoutDocuments(), (copy) => {
    editJson(path.join(copy, "manifest.json"), (document) => {
      const prompt = document["prompt"] as Record<string, unknown>;
      delete prompt["groupInstructions"];
    });
  });
  const corpus = loadCorpus(dir);
  const chat = stubChat();

  await runEval(corpus, chat, { strategies: ["per-group"], model: "ribo-test" });

  const frame = chat.calls.find((request) =>
    request.responseFormat.json_schema.name.endsWith("frame"),
  );
  const service = chat.calls.find((request) =>
    request.responseFormat.json_schema.name.endsWith("service"),
  );
  if (frame === undefined || service === undefined) throw new Error("a group was never asked");

  // The projection is the hook's doing, not the group instructions' — so it
  // happens with or without them.
  expect(JSON.parse(assistantTurn(frame) ?? "{}")).toEqual({
    frame: {
      material: { value: "steel", confidence: 1, sourceSpan: null },
      serial: { value: "BW-1000", confidence: 1, sourceSpan: null },
    },
  });
  expect(assistantTurn(service)).toBeUndefined();
});

// ---------------------------------------------------------------------------
// The group instructions
// ---------------------------------------------------------------------------

test("a group instruction replaces the main instructions on that group's calls", async () => {
  const corpus = loadCorpus(corpusWithoutDocuments());
  const chat = stubChat();

  await runEval(corpus, chat, { strategies: ["per-group"], model: "ribo-test" });

  const frame = chat.calls.find((request) =>
    request.responseFormat.json_schema.name.endsWith("frame"),
  );
  const service = chat.calls.find((request) =>
    request.responseFormat.json_schema.name.endsWith("service"),
  );
  if (frame === undefined || service === undefined) throw new Error("a group was never asked");

  // The group with an entry uses its own text...
  expect(systemMessage(frame)).toBe(corpus.manifest.prompt.groupInstructions?.["frame"]);
  expect(systemMessage(frame)).not.toBe(corpus.manifest.prompt.instructions);
  // ...and the group with no entry uses the main instructions.
  expect(systemMessage(service)).toBe(corpus.manifest.prompt.instructions);
});

test("a group instruction reaches the presence-fill call, and single-shot keeps the main ones", async () => {
  const corpus = loadCorpus(corpusWithoutDocuments());
  const chat = stubChat();

  await runEval(corpus, chat, { strategies: ["single-shot"], model: "ribo-test" });
  for (const request of chat.calls) {
    expect(systemMessage(request)).toBe(corpus.manifest.prompt.instructions);
  }

  const fillChat = stubChat();
  await runEval(corpus, fillChat, { strategies: ["presence-narrowed"], model: "ribo-test" });
  const fill = fillChat.calls.find((request) =>
    request.responseFormat.json_schema.name.endsWith("ribo-eval-frame"),
  );
  expect(fill).toBeDefined();
  if (fill === undefined) throw new Error("the fill phase never asked about the frame group");
  expect(systemMessage(fill)).toBe(corpus.manifest.prompt.groupInstructions?.["frame"]);
});

// ---------------------------------------------------------------------------
// The field-descriptions mode
// ---------------------------------------------------------------------------

test('the field-descriptions mode is forwarded: under "schema" the instructions pass through', async () => {
  const corpus = loadCorpus(corpusWithoutDocuments());
  expect(corpus.manifest.prompt.fieldDescriptions).toBe("schema");
  const chat = stubChat();

  await runEval(corpus, chat, { strategies: ["single-shot"], model: "ribo-test" });

  const request = chat.calls[0];
  if (request === undefined) throw new Error("the stub received no request");
  // The system message is the instructions, byte for byte: no guidance block.
  expect(systemMessage(request)).toBe(corpus.manifest.prompt.instructions);
});

test('the field-descriptions mode is forwarded: under "prompt" the guidance appears', async () => {
  const dir = copiedCorpus(corpusWithoutDocuments(), (copy) => {
    editJson(path.join(copy, "manifest.json"), (document) => {
      const prompt = document["prompt"] as Record<string, unknown>;
      prompt["fieldDescriptions"] = "prompt";
    });
  });
  const corpus = loadCorpus(dir);
  const chat = stubChat();

  await runEval(corpus, chat, { strategies: ["single-shot"], model: "ribo-test" });

  const request = chat.calls[0];
  if (request === undefined) throw new Error("the stub received no request");
  const system = systemMessage(request);
  // The instructions are still there, and the schema's field guidance joined them.
  expect(system).toContain(corpus.manifest.prompt.instructions);
  expect(system).toContain("The frame's material.");
  expect(system.length).toBeGreaterThan(corpus.manifest.prompt.instructions.length);
});

// ---------------------------------------------------------------------------
// A malformed example
// ---------------------------------------------------------------------------

test("an example whose dotted path names no leaf is refused before any model call", async () => {
  const dir = copiedCorpus(corpusWithoutDocuments(), (copy) => {
    editJson(path.join(copy, "manifest.json"), (document) => {
      const prompt = document["prompt"] as Record<string, unknown>;
      const examples = prompt["examples"] as { fields: Record<string, unknown> }[];
      examples[0]!.fields["frame.materiel"] = "steel";
    });
  });
  const corpus = loadCorpus(dir);
  const chat = stubChat();

  const failure = await runEval(corpus, chat, {
    strategies: ["single-shot"],
    model: "ribo-test",
  }).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  const message = failure instanceof Error ? failure.message : String(failure);
  // The manifest, the offending example and the path are named.
  expect(message).toContain(corpus.manifest.name);
  expect(message).toContain("frame.materiel");
  expect(message).toContain("Dropped off a steel frame");
  // Must-fail: an unvalidated pass-through spends the calls before the
  // malformed example is noticed.
  expect(chat.calls.length).toBe(0);
});
