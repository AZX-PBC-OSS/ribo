import {
  enveloped,
  extractGroups,
  generateShapedValue,
  MAX_NULLABLE_UNIONS_PER_CALL,
  perGroupExtractor,
  presenceNarrowedExtractor,
  presencePhase,
  schemaExtractor,
  singleShotExtractor,
  consensusExtractor,
  splitExtractionSchema,
} from "@azx/ribo-core";
import type { ChatClient, ChatRequest, ExtractionTarget } from "@azx/ribo-core";
import { z } from "zod";
import { expect, test } from "vitest";

import { inspectSchema } from "./index.js";

/**
 * @file The agreement tests (design §10): the report's call counts are only
 * worth having if they equal what the real strategies actually request. For
 * each strategy the report models, the real barrel-exported strategy runs to
 * completion over a counting `ChatClient` stub — the idiom of
 * `schema-extractor.test.ts` (requests pushed as they arrive, responses
 * generated with `generateShapedValue`, dispatched on the request's own
 * `json_schema.schema` rendering) — and the stub's observed count is asserted
 * POSITIVELY equal to the reported number: every test fails if the stub
 * observed nothing, so a run that drives no call can never pass vacuously.
 *
 * The stub is written over the public `ChatClient` interface. `fakeChat` is
 * not barrel-exported and is not reached for. No test makes a model call.
 *
 * Two documents. The per-group agreement uses the MIXED one — two groups
 * beside one loose top-level leaf — so the plan carries the unwrapped `""`
 * entry the call model must count. The others use the all-groups one: the
 * presence-narrowed composition (and consensus, which walks per-leaf
 * envelopes through top-level groups) refuses a schema with loose top-level
 * leaves at construction, so the mixed document is outside what those
 * strategies accept.
 */

const group = (description: string, a: string, b: string) => ({
  type: "object",
  description,
  properties: {
    [a]: { type: "string", description: a, nullable: true },
    [b]: { type: "number", description: b, nullable: true },
  },
  required: [a, b],
});

const allGroupsDocument = {
  type: "object",
  description: "A service-visit audit",
  properties: {
    home: group("Home overview", "address", "yearBuilt"),
    site: group("Site", "orientation", "storeys"),
  },
  required: ["home", "site"],
};

const mixedDocument = {
  ...allGroupsDocument,
  properties: {
    ...allGroupsDocument.properties,
    notes: { type: "string", description: "Freeform notes", nullable: true },
  },
  required: ["home", "site", "notes"],
};

const transcript = { text: "The auditor noted every field aloud.", annotations: {} };

/** The document fixtures are plain literals; the converter wants its JSONSchema type. */
const asJsonSchema = (document: object): Parameters<typeof z.fromJSONSchema>[0] =>
  document as Parameters<typeof z.fromJSONSchema>[0];

const converted = (doc: unknown): z.ZodObject =>
  z.fromJSONSchema(asJsonSchema(doc as object), { defaultTarget: "openapi-3.0" }) as z.ZodObject;

/** The derived extraction schema — the enveloped form the strategies run on. */
const derived = (doc: unknown): z.ZodType => enveloped(converted(doc));

const render = (schema: z.ZodType): string =>
  JSON.stringify(z.toJSONSchema(schema, { target: "draft-2020-12" }));

const targetFor = (name: string, doc: unknown): ExtractionTarget<Record<string, unknown>> =>
  ({
    name,
    extractionSchema: derived(doc),
    instructions: "Extract the fields.",
    examples: [],
  }) as ExtractionTarget<Record<string, unknown>>;

/**
 * A ChatClient that records every request and answers each with a value
 * admissible by that piece's schema: presence calls (name
 * `<group>-presence`) get an all-present map — the all-present worst case the
 * presence-narrowed bound is an equality in; every other call is answered
 * from a map keyed on the request's own `json_schema.schema` rendering,
 * covering the whole schema and every split piece. An unexpected request
 * throws rather than passing a canned answer that never parses.
 */
function countingChat(
  name: string,
  doc: unknown,
  caps: { maxNullableUnionsPerGroup?: number },
): { chat: ChatClient; requests: ChatRequest[] } {
  const schema = derived(doc);
  const content = new Map<string, string>();
  content.set(render(schema), JSON.stringify(generateShapedValue(schema)));
  for (const entry of splitExtractionSchema(schema, {
    maxNullableUnionsPerGroup: caps.maxNullableUnionsPerGroup ?? MAX_NULLABLE_UNIONS_PER_CALL,
  })) {
    content.set(render(entry.schema), JSON.stringify(generateShapedValue(entry.schema)));
  }
  const groups = new Map<string, string>();
  const presenceAnswer = (groupKey: string): string | undefined => {
    if (groups.size === 0) {
      // The presence walk refuses a schema with loose top-level leaves; a
      // presence call only ever arrives for a schema it accepts.
      for (const group of extractGroups(z.toJSONSchema(schema, { target: "draft-2020-12" }))) {
        groups.set(
          group.key,
          JSON.stringify(Object.fromEntries(group.leaves.map((leaf) => [leaf.key, true]))),
        );
      }
    }
    return groups.get(groupKey);
  };
  const requests: ChatRequest[] = [];
  return {
    requests,
    chat: {
      complete: (request) => {
        requests.push(request);
        const schemaName = request.responseFormat.json_schema.name;
        if (schemaName.endsWith("-presence")) {
          const answer = presenceAnswer(schemaName.slice(0, -"-presence".length));
          if (answer === undefined) throw new Error(`unexpected presence group: ${schemaName}`);
          return Promise.resolve({ content: answer, finishReason: "stop" as const });
        }
        const answer = content.get(JSON.stringify(request.responseFormat.json_schema.schema));
        if (answer === undefined) {
          throw new Error(
            `unexpected request schema (name "${schemaName}") — the strategy sent a piece ` +
              "this test did not predict",
          );
        }
        return Promise.resolve({ content: answer, finishReason: "stop" as const });
      },
    },
  };
}

test("single-shot: schemaExtractor makes exactly the reported one request", async () => {
  const report = inspectSchema(allGroupsDocument);
  expect(report.callShape).toBe("single-shot");
  expect(report.calls?.singleShot).toBe(1);

  const { chat, requests } = countingChat("visit-agreement", allGroupsDocument, {});
  const extractor = schemaExtractor({
    schema: converted(allGroupsDocument),
    name: "visit-agreement",
    instructions: "Extract the fields.",
    chat,
    model: "fake-model",
  });
  await extractor.extract(transcript);

  // Positive equality: the stub observed the one request the report named.
  expect(requests.length).toBeGreaterThanOrEqual(1);
  expect(requests.length).toBe(report.calls?.singleShot);
});

test("per-group: perGroupExtractor receives exactly one request per reported plan entry", async () => {
  const caps = { maxNullableUnionsPerGroup: 3 };
  const report = inspectSchema(mixedDocument, caps);
  expect(report.callShape).toBe("per-group");
  // The mixed split: home partitions (2), site partitions (2), the loose leaf
  // rides the unwrapped "" entry (1).
  expect(report.calls?.perGroup).toBe(5);

  const { chat, requests } = countingChat("visit-agreement", mixedDocument, caps);
  const extractor = perGroupExtractor({
    target: targetFor("visit-agreement", mixedDocument),
    chat,
    model: "fake-model",
    ...caps,
  });
  await extractor.extract(transcript);

  // Pieces AND the unwrapped entry both — five requests, one per plan entry.
  expect(requests.length).toBeGreaterThanOrEqual(1);
  expect(requests.length).toBe(report.calls?.perGroup);
});

test("presence-narrowed: the all-present worst case receives exactly the reported bound", async () => {
  const report = inspectSchema(allGroupsDocument);
  const groups = extractGroups(
    z.toJSONSchema(derived(allGroupsDocument), { target: "draft-2020-12" }),
  );
  expect(groups.length).toBeGreaterThanOrEqual(1);
  expect(report.calls?.presenceNarrowedAtMost).toBe(groups.length * 2);

  const { chat, requests } = countingChat("visit-agreement", allGroupsDocument, {});
  const extractor = presenceNarrowedExtractor(
    presencePhase({
      groups,
      chat: {
        ...chat,
        engine: "fake-engine",
        capability: () => Promise.resolve({ status: "ready" as const }),
      },
      model: "fake-model",
    }),
    { target: targetFor("visit-agreement", allGroupsDocument), groups, chat, model: "fake-model" },
  );
  await extractor.extract(transcript);

  // Every group present: one presence call per group (the phase's plan is
  // never empty) plus one fill call per group — the bound as an equality.
  expect(requests.length).toBeGreaterThanOrEqual(1);
  expect(requests.length).toBe(report.calls?.presenceNarrowedAtMost);
});

test("consensus: the stub receives the reported per-candidate count summed over candidates", async () => {
  const report = inspectSchema(allGroupsDocument);
  expect(report.calls?.consensusPerCandidate).toBe(1);
  const candidates = 2;

  const { chat, requests } = countingChat("visit-agreement", allGroupsDocument, {});
  const extractor = consensusExtractor(
    [
      singleShotExtractor({
        target: targetFor("visit-agreement", allGroupsDocument),
        chat,
        model: "fake-model",
      }),
      singleShotExtractor({
        target: targetFor("visit-agreement", allGroupsDocument),
        chat,
        model: "fake-model",
      }),
    ],
    { target: targetFor("visit-agreement", allGroupsDocument) },
  );
  await extractor.extract(transcript);

  // One attempt per candidate, summed: the reported per-candidate count times
  // the stated candidate list.
  expect(requests.length).toBeGreaterThanOrEqual(1);
  expect(requests.length).toBe(candidates * (report.calls?.consensusPerCandidate ?? -1));
});

test("the plan-construction stub chat is never called: a grouped report builds call-free", () => {
  // If perGroupPlan construction ever dialled the stub, its error would
  // propagate and this test would fail — the report is a dry run.
  const report = inspectSchema(allGroupsDocument);
  expect(typeof report.calls?.perGroup).toBe("number");
});
