/**
 * @file The eval runner's entry, its settings and its refusals.
 *
 * Every test here drives the runner over a copied fixture corpus with a
 * stubbed chat — core's own `scriptedChat` double, or the suite's
 * schema-driven stub — so no test reaches a network or spends on a model.
 *
 * The call counts are read from the inspect command's own `describeCalls`,
 * never restated: the runner's cost is the extractor's cost, and the report
 * already computes it off the same symbols.
 */
import path from "node:path";

import { ChatError, describeExtraction, scriptedChat } from "@azx/ribo-core";
import { afterEach, expect, test } from "vitest";

import { loadCorpus } from "../corpus/loader.js";
import type { LoadedCorpus } from "../corpus.js";
import { describeCalls } from "../inspect/calls.js";
import { EvalError } from "./error.js";
import { runEval } from "./run.js";
import { stubChat } from "./test-support/stub-chat.js";
import {
  FIXTURE_CORPUS,
  copiedCorpus,
  corpusWithoutDocuments,
  editJson,
  removeTemporaries,
} from "./test-support/corpus.js";
import type { EvalSettings, EvalSplitCaps } from "./types.js";

afterEach(() => {
  removeTemporaries();
});

/** The call counts the inspect command reports for a corpus under its caps. */
const callsFor = (corpus: LoadedCorpus, splitCaps: EvalSplitCaps = {}) =>
  describeCalls(describeExtraction({ schema: corpus.schema, ...splitCaps }), splitCaps);

// ---------------------------------------------------------------------------
// The entry
// ---------------------------------------------------------------------------

test("runEval runs the arm over every transcript and text case, one result per case", async () => {
  const corpus = loadCorpus(corpusWithoutDocuments());
  const chat = stubChat();

  const results = await runEval(corpus, chat, { strategies: ["single-shot"], model: "ribo-test" });

  // One result per case, in the loader's sorted order.
  expect(results.map((entry) => entry.caseId)).toEqual(["spoken-note", "written-ticket"]);
  expect(results.every((entry) => entry.status === "extracted")).toBe(true);
  // A test that drove no model call is never a passing state: every case ran.
  expect(chat.calls.length).toBeGreaterThanOrEqual(results.length);
  // The result carries the extraction's own fields and what it cost.
  const first = results[0];
  expect(first?.fields).toMatchObject({ frame: { material: { value: "sample" } } });
  expect(first?.usage?.calls).toBeGreaterThanOrEqual(1);
});

test("the runner's cost is the extractor's cost, as the inspect report counts it", async () => {
  const corpus = loadCorpus(corpusWithoutDocuments());
  const calls = callsFor(corpus);
  const chat = stubChat();

  const results = await runEval(corpus, chat, { strategies: ["single-shot"], model: "ribo-test" });

  expect(calls.singleShot).toBe(1);
  // At most: the report's own count for the shape, per case.
  expect(chat.calls.length).toBeLessThanOrEqual((calls.singleShot ?? 0) * results.length);
  expect(chat.calls.length).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// The settings
// ---------------------------------------------------------------------------

test("the settings object is plain JSON-able data", () => {
  const settings: EvalSettings = {
    strategies: ["single-shot", "per-group"],
    model: "ribo-test",
    consensusCandidates: 2,
    consensusArbiter: "unanimous",
    maxRetries: 1,
    responseCap: 512,
    splitCaps: { maxNullableUnionsPerGroup: 1, maxSerializedCharsPerGroup: 900 },
  };
  expect(JSON.parse(JSON.stringify(settings))).toEqual(settings);
});

test("the settings' model and response cap reach the request", async () => {
  const corpus = loadCorpus(corpusWithoutDocuments());
  const chat = stubChat();

  await runEval(corpus, chat, {
    strategies: ["single-shot"],
    model: "ribo-model-id",
    responseCap: 321,
  });

  expect(chat.calls.length).toBeGreaterThan(0);
  for (const request of chat.calls) {
    expect(request.model).toBe("ribo-model-id");
    expect(request.maxTokens).toBe(321);
  }
});

// ---------------------------------------------------------------------------
// The settings' refusals — every one of them before a single model call
// ---------------------------------------------------------------------------

const refusedSettings: readonly { readonly settings: EvalSettings; readonly names: string }[] = [
  {
    settings: { strategies: [], model: "ribo-test" },
    names: "strategies",
  },
  {
    settings: { strategies: ["not-a-strategy" as "single-shot"], model: "ribo-test" },
    names: "not-a-strategy",
  },
  {
    settings: { strategies: ["single-shot"], model: "ribo-test", consensusCandidates: 1 },
    names: "consensusCandidates",
  },
  {
    settings: {
      strategies: ["single-shot"],
      model: "ribo-test",
      consensusArbiter: "majority",
    },
    names: "consensusArbiter",
  },
];

for (const { settings, names } of refusedSettings) {
  test(`the settings are refused before any model call: ${names}`, async () => {
    const corpus = loadCorpus(corpusWithoutDocuments());
    const chat = stubChat();

    await expect(runEval(corpus, chat, settings)).rejects.toThrow(EvalError);
    await expect(runEval(corpus, chat, settings)).rejects.toThrow(names);

    // The refusal cost nothing: the stub recorded no request at all.
    // Must-fail: an implementation that constructs its strategies lazily, at
    // the first case, lets a request through and fails this assertion.
    expect(chat.calls.length).toBe(0);
  });
}

// ---------------------------------------------------------------------------
// The inputs
// ---------------------------------------------------------------------------

test("a transcript case and a text case both run, each with its own loaded text", async () => {
  const dir = corpusWithoutDocuments();
  const corpus = loadCorpus(dir);
  const chat = stubChat();

  await runEval(corpus, chat, { strategies: ["single-shot"], model: "ribo-test" });

  const spoken = corpus.cases.find((entry) => entry.id === "spoken-note");
  const ticket = corpus.cases.find((entry) => entry.id === "written-ticket");
  if (spoken === undefined || ticket === undefined) throw new Error("the fixture lost a case");

  const transcripts = chat.calls.map((request) => {
    const last = request.messages[request.messages.length - 1];
    return last?.content ?? "";
  });
  expect(transcripts).toContain(spoken.input.kind === "transcript" ? spoken.input.text : "");
  expect(transcripts).toContain(ticket.input.kind === "text" ? ticket.input.text : "");
});

// ---------------------------------------------------------------------------
// The refusals
// ---------------------------------------------------------------------------

test("a corpus holding a document case refuses the whole run, before any model call", async () => {
  const corpus = loadCorpus(FIXTURE_CORPUS);
  const chat = stubChat();

  const failure = await runEval(corpus, chat, {
    strategies: ["single-shot"],
    model: "ribo-test",
  }).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(EvalError);
  const message = failure instanceof Error ? failure.message : String(failure);
  // The case id, the input kind and the deferred document path.
  expect(message).toContain("service-sheet");
  expect(message).toContain("document");
  expect(message).toContain("T11");
  // The whole run refused, not the case skipped: nothing was spent.
  // Must-fail: an implementation that skips the document case and runs the
  // rest spends the other cases' calls and fails this assertion.
  expect(chat.calls.length).toBe(0);
});

test("a schema the arm cannot drive is refused before any model call, naming the path", async () => {
  const dir = copiedCorpus(corpusWithoutDocuments(), (copy) => {
    editJson(path.join(copy, "schema.json"), (document) => {
      const properties = document["properties"] as Record<string, unknown>;
      properties["extras"] = { type: "object", properties: {} };
      document["required"] = ["frame", "service", "extras"];
    });
  });
  const corpus = loadCorpus(dir);
  const chat = stubChat();

  const failure = await runEval(corpus, chat, {
    strategies: ["single-shot"],
    model: "ribo-test",
  }).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(EvalError);
  const message = failure instanceof Error ? failure.message : String(failure);
  // Core's own refusal, carried verbatim: it names the offending path.
  expect(message).toContain("extras");
  // Must-fail: an implementation that derives the extraction shape itself,
  // or that lets the strategy construction throw, spends nothing but reports
  // a fault that does not name the path.
  expect(chat.calls.length).toBe(0);
});

// ---------------------------------------------------------------------------
// A failing case
// ---------------------------------------------------------------------------

test("a case whose ladder exhausts is captured, and the remaining cases still run", async () => {
  const corpus = loadCorpus(corpusWithoutDocuments());
  const calls = callsFor(corpus);
  // The refusal names the transcript the model was asked about, so each
  // captured failure says which case it belongs to.
  const chat = scriptedChat((request) => {
    const asked = request.messages.at(-1)?.content ?? "";
    throw ChatError.http(400, `the endpoint refused the request: ${asked}`);
  });

  const results = await runEval(corpus, chat, { strategies: ["single-shot"], model: "ribo-test" });

  expect(results.map((entry) => entry.status)).toEqual(["failed", "failed"]);
  for (const entry of results) {
    expect(entry.error).toContain("the endpoint refused the request");
    expect(entry.fields).toBeUndefined();
  }
  // Every case reached the model: each captured failure names that case's own
  // transcript, so no case was skipped.
  // Must-fail: an implementation that aborts the whole run at the first
  // failing case reports one failure, not one per case.
  for (const entry of corpus.cases) {
    if (entry.input.kind === "document") continue;
    const text = entry.input.text;
    expect(results.some((result) => result.error?.includes(text))).toBe(true);
  }
  // At most: the report's own single-shot count per case.
  expect(chat.calls.length).toBeLessThanOrEqual((calls.singleShot ?? 0) * results.length);
});
