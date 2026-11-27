/**
 * @file The group walk is scoped to the arms that need it.
 *
 * The presence-group derivation (`extractGroups`) refuses a schema whose
 * top-level scalar derives an envelope it reads as a plain-leaf group — the
 * shape a `ribo schema init` draft has. Only the presence-narrowed strategy
 * walks groups; single-shot and per-group run the schema the derivation
 * produced. These tests pin that scope: the walk (and its refusal) happens
 * only when the selected arm needs it, and the refusal names the strategy the
 * operator asked for.
 *
 * Every request and answer is the stub chat's: no model, no network, no
 * credential.
 */
import { expect, test } from "vitest";

import type { ChatRequest } from "@azx/ribo-core";

import { loadCorpus } from "../corpus/loader.js";
import { EvalError } from "./error.js";
import { runEval } from "./run.js";
import { FIXTURE_SCALARS_CORPUS } from "./test-support/corpus.js";
import { stubChat } from "./test-support/stub-chat.js";
import { buildEvalTarget } from "./target.js";
import { CHARS_PER_TOKEN, estimateSpend } from "./spend-guard.js";

const CORPUS = loadCorpus(FIXTURE_SCALARS_CORPUS);

const faultOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

test("single-shot runs a schema-init-shaped corpus with top-level scalars and plain-leaf collections", async () => {
  const chat = stubChat();

  const results = await runEval(CORPUS, chat, { strategies: ["single-shot"], model: "ribo-test" });

  expect(results.length).toBe(CORPUS.cases.length);
  expect(results.every((entry) => entry.status === "extracted")).toBe(true);
  expect(chat.calls.length).toBeGreaterThan(0);
});

test("per-group runs and prices the same corpus without the presence-group walk", async () => {
  const chat = stubChat();

  const results = await runEval(CORPUS, chat, { strategies: ["per-group"], model: "ribo-test" });

  expect(results.length).toBe(CORPUS.cases.length);
  expect(results.every((entry) => entry.status === "extracted")).toBe(true);
  // No presence question was asked: the per-group requests carry the target's
  // own name or a piece's, never a presence suffix.
  expect(
    chat.calls.some((request: ChatRequest) =>
      request.responseFormat.json_schema.name.endsWith("-presence"),
    ),
  ).toBe(false);

  // Building the target for a per-group arm does not walk groups — the walk
  // would refuse this schema, and per-group runs it.
  const { groups } = buildEvalTarget(
    CORPUS.schema,
    CORPUS.manifest.prompt,
    CORPUS.manifest.name,
    {},
    ["per-group"],
  );
  expect(groups).toEqual([]);

  const estimate = estimateSpend({
    corpus: CORPUS,
    arms: [{ strategies: ["per-group"], model: "ribo-test" }],
    backend: "openai-compatible",
    model: "ribo-test",
  });
  expect(estimate.usd).toBeGreaterThan(0);
});

test("presence-narrowed refuses before chat with its selected name and operator fix", async () => {
  const chat = stubChat();

  let message = "";
  try {
    await runEval(CORPUS, chat, { strategies: ["presence-narrowed"], model: "ribo-test" });
  } catch (error) {
    expect(error).toBeInstanceOf(EvalError);
    message = faultOf(error);
  }

  expect(message).toContain("presence-narrowed");
  expect(message).toContain("wrap the scalar in an object group");
  expect(message).toContain("leaf granularity");
  expect(message).toContain("single-shot");
  // The refusal happens at construction: no model call was made.
  expect(chat.calls).toHaveLength(0);
});

test("single-shot spend and prompt-size estimates cover the stubbed requests", async () => {
  const chat = stubChat();
  const results = await runEval(CORPUS, chat, { strategies: ["single-shot"], model: "ribo-test" });

  const estimate = estimateSpend({
    corpus: CORPUS,
    arms: [{ strategies: ["single-shot"], model: "ribo-test" }],
    backend: "openai-compatible",
    model: "ribo-test",
  });

  const arm = estimate.arms[0];
  expect(arm).toBeDefined();
  if (arm === undefined) throw new Error("the estimate carried no arm");

  // The per-call prompt bound covers the largest prompt the run really sent.
  const sentChars = Math.max(
    ...chat.calls.map((request: ChatRequest) =>
      request.messages.reduce((total, message) => total + message.content.length, 0),
    ),
  );
  expect(arm.promptTokensPerCall).toBeGreaterThanOrEqual(Math.ceil(sentChars / CHARS_PER_TOKEN));

  // The call bound covers the calls the run actually metered.
  const metered = results.reduce((total, entry) => total + (entry.usage?.calls ?? 0), 0);
  expect(estimate.worstCaseCalls).toBeGreaterThanOrEqual(metered);
  expect(estimate.usd).toBeGreaterThan(0);
});
