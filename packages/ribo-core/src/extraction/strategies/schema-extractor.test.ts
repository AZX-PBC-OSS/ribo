import { enveloped } from "../../provenance/enveloped.js";
import { isSpanGrounded } from "../../provenance/provenance.js";
import type { ChatClient, ChatRequest } from "../../phases/chat-client.js";
import { z } from "zod";
import { expect, test } from "vitest";

import { schemaExtractor } from "./schema-extractor.js";

/**
 * @file `schemaExtractor` — the entry point that takes a RAW zod schema.
 *
 * The wave's standard: a newcomer hands over the plain patch schema they wrote,
 * a chat client and a model, and gets an `Extractor` — the `enveloped()`
 * derivation and the single-shot-vs-per-group selection happen inside, off the
 * caller's path. These tests pin both: the result parses against the DERIVED
 * enveloped schema (so the derivation really ran), a schema under the caps goes
 * single-shot (one call), and one past the caps goes per-group (one call per
 * piece).
 */

const visitPatch = z
  .object({
    visit: z
      .object({
        summary: z.string().nullable().optional(),
        durationMinutes: z.number().nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

type VisitValues = z.infer<typeof visitPatch>;

/** A ChatClient that records requests and answers with a canned enveloped payload. */
function fakeChat(respond: (request: ChatRequest) => unknown): {
  chat: ChatClient;
  requests: ChatRequest[];
} {
  const requests: ChatRequest[] = [];
  return {
    chat: {
      complete: (request) => {
        requests.push(request);
        return Promise.resolve({
          content: JSON.stringify(respond(request)),
          finishReason: "stop" as const,
        });
      },
    },
    requests,
  };
}

const visitResponse = (): Record<string, unknown> => ({
  visit: {
    summary: { value: "checked the furnace", confidence: 0.9, sourceSpan: "checked the furnace" },
    durationMinutes: { value: 45, confidence: 0.9, sourceSpan: "45 minutes" },
  },
});

const transcript = { text: "I checked the furnace, took about 45 minutes.", annotations: {} };

test("a raw, un-enveloped schema produces a result that parses against the derived enveloped schema", async () => {
  const { chat } = fakeChat(() => visitResponse());
  const extractor = schemaExtractor({
    schema: visitPatch,
    name: "visit",
    instructions: "Extract the visit fields.",
    chat,
    model: "m",
  });

  const { fields } = await extractor.extract(transcript);

  // The derivation ran: the result is enveloped — parse it against the schema
  // the entry point was supposed to derive, and read an envelope off a leaf.
  const derived = enveloped(visitPatch);
  expect(derived.parse(fields)).toEqual(fields);
  expect(fields.visit.summary.sourceSpan).toBe("checked the furnace");
  // And the span is grounded in the transcript — the whole pipeline worked.
  expect(isSpanGrounded(fields.visit.summary.sourceSpan, transcript.text)).toBe(true);
});

test("a schema under the caps is picked SINGLE-SHOT: one call, named after the target", async () => {
  const { chat, requests } = fakeChat(() => visitResponse());
  const extractor = schemaExtractor({
    schema: visitPatch,
    name: "visit",
    instructions: "Extract the visit fields.",
    chat,
    model: "m",
  });

  await extractor.extract(transcript);

  expect(requests).toHaveLength(1);
  expect(requests[0]!.responseFormat.json_schema.name).toBe("visit");
});

test("a schema past the caps is picked PER-GROUP: one call per piece, merged back together", async () => {
  // Two groups, union cap 3: each group is 4 unions, so both partition — the
  // split the entry point was asked to make rather than one whole-schema call.
  const widePatch = z
    .object({
      alpha: z
        .object({
          a: z.string().nullable().optional(),
          b: z.string().nullable().optional(),
        })
        .strict()
        .optional(),
      beta: z
        .object({
          c: z.string().nullable().optional(),
          d: z.string().nullable().optional(),
        })
        .strict()
        .optional(),
    })
    .strict();

  const responseFor = (key: string, leaf: string): Record<string, unknown> => ({
    [key]: {
      [leaf]: { value: `${leaf} noted`, confidence: 0.8, sourceSpan: `${leaf} noted` },
    },
  });
  const { chat, requests } = fakeChat((request) => {
    const name = request.responseFormat.json_schema.name;
    const [, key, part] = /visit-(alpha|beta)(?:-(\d))?$/.exec(name) ?? [];
    const first = key === "alpha" ? "a" : "c";
    const second = key === "alpha" ? "b" : "d";
    return responseFor(key ?? "alpha", part === undefined ? first : part === "0" ? first : second);
  });

  const extractor = schemaExtractor({
    schema: widePatch,
    name: "visit",
    instructions: "Extract the fields.",
    chat,
    model: "m",
    maxNullableUnionsPerGroup: 3,
  });
  const { fields } = await extractor.extract(transcript);

  expect(requests.length).toBeGreaterThan(1);
  // The merged result still parses against the derived whole.
  expect(enveloped(widePatch).parse(fields)).toEqual(fields);
});

test("an already-enveloped schema is accepted under `extractionSchema` and used as-is", async () => {
  const { chat, requests } = fakeChat(() => visitResponse());
  const extractor = schemaExtractor<VisitValues>({
    extractionSchema: enveloped(visitPatch),
    name: "visit",
    instructions: "Extract the visit fields.",
    chat,
    model: "m",
  });

  const { fields } = await extractor.extract(transcript);
  expect(requests[0]!.responseFormat.json_schema.name).toBe("visit");
  expect(enveloped(visitPatch).parse(fields)).toEqual(fields);
});

test("a target name carrying a colon is refused at construction, naming the character", () => {
  const { chat } = fakeChat(() => visitResponse());
  const build = (): unknown =>
    schemaExtractor({
      schema: visitPatch,
      name: "vi:sit",
      instructions: "Extract the visit fields.",
      chat,
      model: "m",
    });
  expect(build).toThrow(/":" /);
});
