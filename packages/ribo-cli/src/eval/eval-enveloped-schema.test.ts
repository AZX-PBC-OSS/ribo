/**
 * @file A corpus may ship core's already-enveloped extraction schema. The
 * loader must hand the runner its field-level values schema so core adds one
 * envelope, not a second one the scorer would read as an object abstention.
 * Every request and answer here is the stub chat's: no model or network.
 */
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

import { enveloped, generateShapedValue, scriptedChat } from "@azx/ribo-core";
import type { ChatRequest } from "@azx/ribo-core";

import { loadCorpus } from "../corpus/loader.js";
import { runEval } from "./run.js";
import { scoreEvalRun } from "./score.js";
import { stubChat } from "./test-support/stub-chat.js";

const ENVELOPED_CORPUS = fileURLToPath(new URL("../fixtures/corpus-enveloped", import.meta.url));
const SNUGG_CORPUS = fileURLToPath(
  new URL("../../../ribo-adapter-snuggpro/acceptance/corpus", import.meta.url),
);

const SETTINGS = { strategies: ["single-shot"], model: "ribo-test" } as const;

const VALUES = {
  "basedata.yearBuilt": 1978,
  "rooms.name": "Kitchen",
  "rooms.floorArea": 12,
} as const;

type SchemaNode = Record<string, unknown>;

const isNode = (value: unknown): value is SchemaNode =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const propertiesOf = (node: SchemaNode): Readonly<Record<string, unknown>> => {
  const properties = node["properties"];
  return isNode(properties) ? properties : {};
};

/** The request schema's envelope shape, at the field boundary under test. */
const isEnvelopeSchema = (node: unknown): boolean => {
  if (!isNode(node)) return false;
  const properties = propertiesOf(node);
  return "value" in properties && "confidence" in properties && "sourceSpan" in properties;
};

/** Paths whose envelope's `value` is another envelope, including in arrays. */
const doubleEnvelopePaths = (node: unknown, path = ""): string[] => {
  if (!isNode(node)) return [];
  if (node["type"] === "array") return doubleEnvelopePaths(node["items"], path);
  const properties = propertiesOf(node);
  if (isEnvelopeSchema(node) && isEnvelopeSchema(properties["value"])) {
    return [path === "" ? "<root>" : path];
  }
  return Object.entries(properties).flatMap(([key, property]) =>
    doubleEnvelopePaths(property, path === "" ? key : `${path}.${key}`),
  );
};

const expectSinglyEnvelopedRequests = (calls: readonly ChatRequest[]): void => {
  expect(calls.length).toBeGreaterThan(0);
  const doubled = calls.flatMap((request) =>
    doubleEnvelopePaths(request.responseFormat.json_schema.schema),
  );
  expect(doubled).toEqual([]);
};

const runFixture = async () => {
  const corpus = loadCorpus(ENVELOPED_CORPUS);
  const chat = stubChat({ values: VALUES, sourceSpan: "built in 1978" });
  const results = await runEval(corpus, chat, SETTINGS);
  return { corpus, chat, results };
};

test("an enveloped corpus is requested and scored with one envelope per field", async () => {
  const { corpus, chat, results } = await runFixture();

  expectSinglyEnvelopedRequests(chat.calls);
  expect(results.map((result) => result.status)).toEqual(["extracted"]);

  // The response parsed against a singly-enveloped target, so an envelope-valued
  // envelope cannot reach this score as a silently empty answer.
  const score = scoreEvalRun(corpus, results);
  expect(score.totals.answered).toBe(3);
  expect(score.totals.correct).toBe(3);
  expect(score.totals.answerRate).toBe(1);
  const cells = score.cases[0]?.cells;
  expect(cells?.["basedata.yearBuilt"]).toMatchObject({ verdict: "correct", got: 1978 });
  expect(cells?.["rooms.name"]).toMatchObject({ verdict: "correct", got: ["Kitchen"] });
  expect(cells?.["rooms.floorArea"]).toMatchObject({ verdict: "correct", got: [12] });
});

test("unwrapped leaf descriptions reach prompt guidance at single-envelope paths", async () => {
  const { chat } = await runFixture();

  expectSinglyEnvelopedRequests(chat.calls);
  const request = chat.calls[0];
  if (request === undefined) throw new Error("the stub received no request");
  const system = request.messages.find((message) => message.role === "system")?.content ?? "";
  expect(system).toContain("The year the home was constructed.");
  expect(system).toContain("The room's spoken name.");
  expect(system).toContain("The room's floor area in square metres.");
  expect(system).toContain("yearBuilt.value");
  expect(system).toContain("name.value");
  expect(system).toContain("floorArea.value");
  expect(system).not.toContain("value.value");
});

test("the real Snugg corpus schema reaches stub chat without a double envelope", async () => {
  const loaded = loadCorpus(SNUGG_CORPUS);
  const first = loaded.cases[0];
  if (first === undefined) throw new Error("the Snugg corpus has no case");
  const corpus = { ...loaded, cases: [first] };
  const content = JSON.stringify(generateShapedValue(enveloped(corpus.schema)));
  const chat = scriptedChat(() => ({ content }));

  const results = await runEval(corpus, chat, SETTINGS);

  expectSinglyEnvelopedRequests(chat.calls);
  expect(results).toHaveLength(1);
  expect(results[0]?.status, results[0]?.status === "failed" ? results[0].error : undefined).toBe(
    "extracted",
  );
});
