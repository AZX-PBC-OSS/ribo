import { z } from "zod";
import { describe, expect, test } from "vitest";

import { proposeShapeOperations } from "./operations-proposer.js";
import { deriveExtractionShape } from "./shape-operations.js";
import { reshapedExtractor } from "./reshaped-extractor.js";
import { scopedInstanceExtractor } from "../scoped-instance/instance-fill.js";
import { partitionLabelLine } from "../schema/split-schema.js";
import { buildReviewRequest } from "../../review/review.js";
import type { ShapeOperation } from "./shape-operation.js";
import type { ChatClient, ChatCompletion, ChatRequest } from "../../phases/chat-client.js";
import type { Transcript } from "../../capture/transcript.js";
import type { ExtractionTarget } from "../extractor.js";
import type { Roster, RosterCandidate } from "../inventory-types.js";

/**
 * @file The pair through the REAL pipeline, no stubs between the stages (spec
 * §8): a scripted proposer chat returns a partition of a collection into two
 * parts, the derivation applies it, the scoped-instance extractor fills it
 * batched over a fixed two-instance roster — the second part's reply listing
 * the instances in REVERSE order — `reshapedExtractor` maps the result back,
 * and `buildReviewRequest` presents it. Review must see each part's values on
 * the right instance, two batched calls (one per part), the second part's
 * label line on its request, and no `instanceId` anywhere in the review paths.
 */

const systemValues = z
  .object({
    make: z.string().nullable().optional(),
    fuel: z.string().nullable().optional(),
    rating: z.string().nullable().optional(),
    year: z.string().nullable().optional(),
  })
  .strict();

const schema = z
  .object({
    systems: z.array(systemValues).optional(),
  })
  .strict();

type Values = z.infer<typeof schema>;

const TRANSCRIPT =
  "The gas furnace in the basement dates to 1998 and is rated 80. " +
  "The electric air handler in the attic is a 2020 unit rated 5.";

const transcript: Transcript = { recordingId: "rec-1", text: TRANSCRIPT, engine: "fake" };

/** A current roster candidate; the discriminator defaults to the mention span. */
const current = (mentionSpan: string, discriminator = mentionSpan): RosterCandidate => ({
  mentionSpan,
  discriminator,
  distinguishedBy: null,
  eligibility: "current",
  eligibilitySpan: null,
});

const ROSTER: Roster = {
  systems: [
    current("The gas furnace in the basement", "Basement furnace"),
    current("The electric air handler in the attic", "Attic air handler"),
  ],
};

const env = (value: string, span: string = value) => ({
  value,
  sourceSpan: span,
  confidence: 1,
});

/** The identity part's leaves of one `systems` element, enveloped. */
const identityPart = (make: string, fuel: string): Record<string, unknown> => ({
  make: env(make),
  fuel: env(fuel),
});

/** The output part's leaves of one `systems` element, enveloped. */
const outputPart = (rating: string, year: string): Record<string, unknown> => ({
  rating: env(rating),
  year: env(year),
});

/** A batched reply body: one element per `[id, fields]` pair, in the order given. */
const batchedReply = (
  key: string,
  elements: readonly (readonly [string, Record<string, unknown>])[],
): Record<string, unknown> => ({
  [key]: elements.map(([instanceId, fields]) => ({ instanceId, ...fields })),
});

/** A ChatClient that records every request and replays a script of completions. */
function scriptedChat(script: readonly ChatCompletion[]): {
  chat: ChatClient;
  requests: ChatRequest[];
} {
  const requests: ChatRequest[] = [];
  const chat: ChatClient = {
    complete: (request) => {
      requests.push(request);
      const step = script[requests.length - 1];
      if (step === undefined) return Promise.reject(new Error("scripted chat exhausted"));
      return Promise.resolve(step);
    },
  };
  return { chat, requests };
}

const completion = (body: unknown): ChatCompletion => ({
  content: JSON.stringify(body),
  finishReason: "stop",
});

/**
 * The proposer's wire format carries a partition's parts as `{label, fields}`
 * pairs; the returned operations carry the record form. Scripts are written as
 * {@link ShapeOperation}s and converted here (the same conversion
 * `operations-proposer-partition.test.ts` uses).
 */
const wireOps = (operations: readonly ShapeOperation[]): unknown => ({
  operations: operations.map((op) => {
    if (op.op === "partition") {
      return {
        ...op,
        parts: Object.entries(op.parts).map(([label, fields]) => ({ label, fields: [...fields] })),
      };
    }
    return op;
  }),
});

/** A ChatClient dispatching on the request name, recording every request. */
function fakeChat(respond: (requestName: string) => unknown): {
  chat: ChatClient;
  requests: ChatRequest[];
} {
  const requests: ChatRequest[] = [];
  return {
    requests,
    chat: {
      complete: (request): Promise<ChatCompletion> => {
        requests.push(request);
        return Promise.resolve({
          content: JSON.stringify(respond(request.response_format.json_schema.name)),
          finishReason: "stop",
        });
      },
    },
  };
}

const requestName = (request: ChatRequest): string => request.response_format.json_schema.name;

describe("the partition pair through the real pipeline", () => {
  test("a proposed partition drives batched fill end to end: review sees each part's values on the right instance", async () => {
    // 1 — The proposer: one scripted reply, a partition of `systems` into two parts.
    const proposer = scriptedChat([
      completion(
        wireOps([
          {
            op: "partition",
            group: "systems",
            parts: { identity: ["make", "fuel"], output: ["rating", "year"] },
          },
        ]),
      ),
    ]);
    const operations = await proposeShapeOperations(schema, {
      chat: proposer.chat,
      model: "m",
      context: "partition-pipeline",
      instructions: "Audit the schema for a home-energy audit dictation.",
      networkRetryDelay: () => Promise.resolve(),
    });
    const shape = deriveExtractionShape(schema, { operations });
    // The derivation recorded the cut the split will follow.
    expect(shape.partitions).toEqual({
      systems: { identity: ["make", "fuel"], output: ["rating", "year"] },
    });

    // 2 — The scoped-instance extractor in batched mode, over the derived shape.
    // `DerivedExtractionShape.extractionSchema` is typed loose (`z.ZodObject`), but the
    // artifact was derived from THIS schema one step above, so its runtime type is that
    // schema's enveloped form — the seam `operations-proposer.test.ts`'s pipeline test
    // bridges the same way for `schemaExtractor`.
    const extractionSchema =
      shape.extractionSchema as unknown as ExtractionTarget<Values>["extractionSchema"];
    const { chat, requests } = fakeChat((name) => {
      // The identity part's reply is in roster order; the OUTPUT part's reply
      // lists the instances REVERSED. Merge is by roster id or not at all.
      if (name === "audit-systems-fill-0-batched") {
        return batchedReply("systems", [
          ["systems-1", identityPart("furnace", "gas")],
          ["systems-2", identityPart("air handler", "electric")],
        ]);
      }
      if (name === "audit-systems-fill-1-batched") {
        return batchedReply("systems", [
          ["systems-2", outputPart("5", "2020")],
          ["systems-1", outputPart("80", "1998")],
        ]);
      }
      throw new Error(`unexpected request ${name}`);
    });
    const inner = scopedInstanceExtractor<Values>({
      target: {
        name: "audit",
        extractionSchema,
        instructions: "Extract the fields.",
        examples: [],
      },
      chat,
      model: "m",
      inventory: async () => ROSTER,
      buildFillInstructions: (groupKey) => `Fill ${groupKey}.`,
      partitions: shape.partitions,
      fill: "batched",
      delay: () => Promise.resolve(),
    });
    const result = await reshapedExtractor<Values, Values>(inner, shape).extract({
      text: TRANSCRIPT,
      annotations: {},
    });

    // 5.2 — two batched fill calls were made, one per part.
    expect(requests.map(requestName).sort()).toEqual([
      "audit-systems-fill-0-batched",
      "audit-systems-fill-1-batched",
    ]);
    // 5.3 — the second part's call carries that part's label line.
    const secondPart = requests.find((r) => requestName(r) === "audit-systems-fill-1-batched");
    expect(secondPart).toBeDefined();
    expect(secondPart!.messages[0]!.content).toContain(partitionLabelLine("systems", "output"));

    // 3 — Reversal into the patch, then review over it.
    const review = buildReviewRequest(result.fields, transcript, shape.patchSchema);

    // 5.1 — both parts' values landed on the right instance. The reversed
    // second reply means a merge by arrival order would put systems-2's output
    // values on systems-1; by id, k1 is the furnace with rating 80 / year 1998.
    // A concrete expected value cannot pass for an absent field, so each read
    // asserts presence too.
    expect(review.fields["systems[k1].make"]?.extracted.value).toBe("furnace");
    expect(review.fields["systems[k1].fuel"]?.extracted.value).toBe("gas");
    expect(review.fields["systems[k1].rating"]?.extracted.value).toBe("80");
    expect(review.fields["systems[k1].year"]?.extracted.value).toBe("1998");
    expect(review.fields["systems[k2].make"]?.extracted.value).toBe("air handler");
    expect(review.fields["systems[k2].fuel"]?.extracted.value).toBe("electric");
    expect(review.fields["systems[k2].rating"]?.extracted.value).toBe("5");
    expect(review.fields["systems[k2].year"]?.extracted.value).toBe("2020");
    // 5.4 — no review field path contains `instanceId`.
    for (const path of Object.keys(review.fields)) {
      expect(path).not.toContain("instanceId");
    }
  });
});
