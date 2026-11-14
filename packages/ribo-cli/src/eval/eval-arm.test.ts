/**
 * @file The arm: the three strategies alone, a two-rung ladder, and the
 * consensus modifier over the whole ladder.
 *
 * The ladder's behaviour is core's, not the runner's: a terminal failure falls
 * through to the next rung, a transient one does not. The tests below pin
 * both directions, because an implementation that fell through on any error —
 * or on none — would still pass one of them.
 *
 * Every count is read from the inspect command's own `describeCalls`; the
 * assertions are at-most, never a restated formula.
 */
import { ChatError, scriptedChat } from "@azx/ribo-core";
import type { ScriptedChatClient } from "@azx/ribo-core";
import { afterEach, expect, test } from "vitest";

import { loadCorpus } from "../corpus/loader.js";
import { describeCalls } from "../inspect/calls.js";
import { describeExtraction } from "@azx/ribo-core";
import { runEval } from "./run.js";
import { replyFor, stubChat } from "./test-support/stub-chat.js";
import {
  corpusWithCases,
  corpusWithoutDocuments,
  removeTemporaries,
} from "./test-support/corpus.js";
import type { EvalSettings } from "./types.js";

afterEach(() => {
  removeTemporaries();
});

/** The schema name a request carries — the wire name of the shape it asked for. */
const schemaName = (request: { responseFormat: { json_schema: { name: string } } }): string =>
  request.responseFormat.json_schema.name;

/** The fixture corpus, without its document case. */
const fixture = () => loadCorpus(corpusWithoutDocuments());

// ---------------------------------------------------------------------------
// Each strategy alone
// ---------------------------------------------------------------------------

test("the single-shot strategy drives one whole-schema request per case", async () => {
  const corpus = fixture();
  const chat = stubChat();
  const calls = describeCalls(describeExtraction({ schema: corpus.schema }), {});

  const results = await runEval(corpus, chat, { strategies: ["single-shot"], model: "ribo-test" });

  expect(chat.calls.length).toBeGreaterThan(0);
  expect(chat.calls.length).toBeLessThanOrEqual((calls.singleShot ?? 0) * results.length);
  // Every request asked for the whole schema, under the runner's own wire name.
  for (const request of chat.calls) {
    expect(schemaName(request)).toBe("ribo-eval");
  }
});

test("the per-group strategy drives one request per plan piece per case", async () => {
  const corpus = fixture();
  const chat = stubChat();
  const calls = describeCalls(describeExtraction({ schema: corpus.schema }), {});

  const results = await runEval(corpus, chat, { strategies: ["per-group"], model: "ribo-test" });

  expect(calls.perGroup).not.toBeNull();
  expect(chat.calls.length).toBeGreaterThan(0);
  expect(chat.calls.length).toBeLessThanOrEqual((calls.perGroup ?? 0) * results.length);
  // Each request asked for one group, under the target's name.
  for (const request of chat.calls) {
    expect(schemaName(request).startsWith("ribo-eval-")).toBe(true);
  }
});

test("the presence-narrowed strategy drives the presence calls, then the fill calls", async () => {
  const corpus = loadCorpus(corpusWithCases("spoken-note"));
  const chat = stubChat();

  const results = await runEval(corpus, chat, {
    strategies: ["presence-narrowed"],
    model: "ribo-test",
  });

  expect(results.length).toBeGreaterThan(0);
  expect(chat.calls.length).toBeGreaterThan(0);
  const names = chat.calls.map(schemaName);
  const presenceCount = names.filter((name) => name.endsWith("-presence")).length;
  const fillCount = names.length - presenceCount;
  expect(presenceCount).toBeGreaterThan(0);
  expect(fillCount).toBeGreaterThan(0);
  // The presence calls come first: the fill reads the note the presence wrote.
  expect(names.slice(0, presenceCount).every((name) => name.endsWith("-presence"))).toBe(true);
});

// ---------------------------------------------------------------------------
// A two-rung ladder
// ---------------------------------------------------------------------------

/** A chat that fails the named schema's calls and answers the rest. */
const chatFailing = (failingName: string, failure: () => Error): ScriptedChatClient =>
  scriptedChat((request) => {
    if (schemaName(request) !== failingName) {
      return { content: replyFor(request) };
    }
    throw failure();
  });

test("a terminal failure on the first rung falls through to the second", async () => {
  const corpus = fixture();
  const chat = chatFailing("ribo-eval", () => ChatError.http(400, "the endpoint refused"));

  const results = await runEval(corpus, chat, {
    strategies: ["single-shot", "per-group"],
    model: "ribo-test",
  });

  expect(results.every((entry) => entry.status === "extracted")).toBe(true);
  // The second rung's requests arrived...
  expect(chat.calls.some((request) => schemaName(request) === "ribo-eval-frame")).toBe(true);
  // ...and the result says which rung won.
  expect(results[0]?.usage?.strategy).toBe("per-group");
});

test("a transient failure on the first rung never reaches the second", async () => {
  const corpus = fixture();
  const chat = chatFailing("ribo-eval", () => ChatError.transport("the uplink dropped"));

  const results = await runEval(corpus, chat, {
    strategies: ["single-shot", "per-group"],
    model: "ribo-test",
  });

  // The second rung never received a request.
  // Must-fail: an implementation that falls through on ANY error reaches the
  // second rung here and fails this assertion; one that never falls through
  // fails the terminal case above.
  expect(chat.calls.some((request) => schemaName(request) === "ribo-eval-frame")).toBe(false);
  // The case settled as a failure, carrying the error.
  expect(results[0]?.status).toBe("failed");
  expect(results[0]?.error).toContain("the uplink dropped");
});

// ---------------------------------------------------------------------------
// The consensus modifier
// ---------------------------------------------------------------------------

/** The settings of a consensus run over the single-shot ladder. */
const consensusSettings = (
  arbiter: "unanimous" | "majority",
  candidates: number,
): EvalSettings => ({
  strategies: ["single-shot"],
  model: "ribo-test",
  consensusCandidates: candidates,
  consensusArbiter: arbiter,
});

test("the consensus modifier runs the whole ladder as N candidates, under both arbiters", async () => {
  for (const arbiter of ["unanimous", "majority"] as const) {
    const corpus = fixture();
    const chat = stubChat();
    const calls = describeCalls(describeExtraction({ schema: corpus.schema }), {});

    const results = await runEval(corpus, chat, consensusSettings(arbiter, 2));

    expect(results.length).toBeGreaterThan(0);
    // At most: the report's own per-candidate count, times the candidates this
    // run asked for, times the cases. The bound is read from `describeCalls`;
    // the ladder-times-candidates formula is never written out here.
    expect(chat.calls.length).toBeLessThanOrEqual(
      (calls.consensusPerCandidate ?? 0) * 2 * results.length,
    );
    expect(results.every((entry) => entry.status === "extracted")).toBe(true);
  }
});

test("the unanimous arbiter nulls a contested field and keeps its citation", async () => {
  const corpus = fixture();
  // Two candidates, disagreeing on one leaf only.
  const chat = scriptedChat((request, context) => ({
    content: replyFor(request, {
      values: { "frame.material": context.call % 2 === 0 ? "alpha" : "beta" },
    }),
  }));

  const calls = describeCalls(describeExtraction({ schema: corpus.schema }), {});
  const results = await runEval(corpus, chat, consensusSettings("unanimous", 2));

  const fields = results[0]?.fields as
    { frame: { material: { value: unknown; sourceSpan: unknown } } } | undefined;
  expect(fields).toBeDefined();
  const contested = fields?.frame.material;
  // The contested field is null, and its citation is kept.
  expect(contested?.value).toBeNull();
  expect(contested?.sourceSpan).toBeTruthy();
  // The result is not one candidate's whole answer: the agreed field carries
  // the agreed value, and the contested one carries neither candidate's.
  const agreed = (fields as unknown as { frame: { serial: { value: unknown } } }).frame.serial;
  expect(agreed.value).toBe("sample");
  expect(contested?.value).not.toBe("alpha");
  expect(contested?.value).not.toBe("beta");
  // The model was never re-asked: the run spent at most the report's own
  // per-candidate count for each of the two candidates, over each case. A run
  // that re-asked the model would spend one request more per case and break
  // this bound.
  // Must-fail: an implementation that picks one candidate's envelope
  // wholesale leaves the contested field valued, and one that re-asks the
  // model spends more requests than the bound allows.
  expect(chat.calls.length).toBeLessThanOrEqual(
    (calls.consensusPerCandidate ?? 0) * 2 * results.length,
  );
});

test("the majority arbiter accepts the value the candidates agreed on", async () => {
  const corpus = fixture();
  // Three candidates: two say "alpha", one says "beta".
  const chat = scriptedChat((request, context) => ({
    content: replyFor(request, {
      values: { "frame.material": context.call % 2 === 0 ? "alpha" : "beta" },
    }),
  }));

  const calls = describeCalls(describeExtraction({ schema: corpus.schema }), {});
  const results = await runEval(corpus, chat, consensusSettings("majority", 3));

  const fields = results[0]?.fields as
    { frame: { material: { value: unknown; sourceSpan: unknown } } } | undefined;
  expect(fields?.frame.material.value).toBe("alpha");
  // At most: the report's own per-candidate count for each of the three
  // candidates, over each case — the bound is read, never restated.
  expect(chat.calls.length).toBeLessThanOrEqual(
    (calls.consensusPerCandidate ?? 0) * 3 * results.length,
  );
});
