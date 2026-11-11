import { describe, expect, test } from "vitest";

import type { ChatClient, ChatRequest, ExtractionTarget } from "@azx/ribo-core";
import {
  describeExtraction,
  generateShapedValue,
  MAX_NULLABLE_UNIONS_PER_CALL,
  perGroupPlan,
  schemaExtractor,
  splitExtractionSchema,
  type SplitOptions,
} from "@azx/ribo-core";

import { SCHEMA_SERIALIZED_CHAR_CAP, snuggExtractionSchema } from "./schema.js";
import type { SnuggValues } from "./schema.js";

/**
 * @file The adapter half of `describe-extraction-agreement.test.ts`
 * (describe-extraction-design.md §5). The extractor package's corpus is
 * synthetic because dependencies point inward — it cannot import this
 * adapter. So the identical comparison runs here over the real
 * `snuggExtractionSchema`: the report against what `perGroupPlan` and
 * `schemaExtractor` actually build, under the adapter's own route caps.
 */

/** The options the presets would hand the split: the union cap defaults to 16. */
const effectiveCaps = (caps: SplitOptions): SplitOptions => ({
  maxNullableUnionsPerGroup: caps.maxNullableUnionsPerGroup ?? MAX_NULLABLE_UNIONS_PER_CALL,
  ...(caps.maxSerializedCharsPerGroup === undefined
    ? {}
    : { maxSerializedCharsPerGroup: caps.maxSerializedCharsPerGroup }),
});

/**
 * A ChatClient that records every request and answers each with a generated
 * value admissible by that piece's schema — the name→piece naming is the
 * plan's own, so an unexpected request name throws rather than passing on a
 * canned `{}` that never parses.
 */
function pieceChat(
  name: string,
  caps: SplitOptions,
): {
  chat: ChatClient;
  requests: ChatRequest[];
} {
  const content = new Map<string, string>();
  for (const entry of splitExtractionSchema(snuggExtractionSchema, effectiveCaps(caps))) {
    const partSuffix = entry.part === undefined ? "" : `-${entry.part}`;
    const pieceName =
      entry.key === "" ? `${name}${partSuffix}` : `${name}-${entry.key}${partSuffix}`;
    content.set(pieceName, JSON.stringify(generateShapedValue(entry.schema)));
  }
  const requests: ChatRequest[] = [];
  return {
    requests,
    chat: {
      complete: (request) => {
        requests.push(request);
        const answer = content.get(request.responseFormat.json_schema.name);
        if (answer === undefined) {
          throw new Error(
            `unexpected request name "${request.responseFormat.json_schema.name}" — the ` +
              "construction sent a piece this test did not predict",
          );
        }
        return Promise.resolve({ content: answer, finishReason: "stop" as const });
      },
    },
  };
}

const target: ExtractionTarget<SnuggValues> = {
  name: "snugg",
  extractionSchema: snuggExtractionSchema,
  instructions: "Extract the audit fields.",
  examples: [],
};

const transcript = {
  text: "The auditor walked the house and read every field aloud.",
  annotations: {},
};

describe("describeExtraction agrees with construction over the real Snugg Pro schema", () => {
  const capSets: Record<string, SplitOptions> = {
    // The presets' default: union cap 16, no byte cap.
    none: {},
    // The platform route's own byte ceiling beside the default union cap.
    routeBytes: { maxSerializedCharsPerGroup: SCHEMA_SERIALIZED_CHAR_CAP },
    // A tighter union cap beside the byte ceiling — the pieces must change.
    both: { maxNullableUnionsPerGroup: 8, maxSerializedCharsPerGroup: SCHEMA_SERIALIZED_CHAR_CAP },
  };

  for (const [capsName, caps] of Object.entries(capSets)) {
    test(`caps: ${capsName}`, async () => {
      const report = describeExtraction({ extractionSchema: snuggExtractionSchema, ...caps });

      // The real schema never refuses under its own route's caps.
      expect(report.refusal).toBeUndefined();
      expect(report.path).toBe("grouped");
      expect(report.callShape).toBe("per-group");
      expect(report.pieces).toBeDefined();

      // The report's pieces ARE the split's entries — key, part and parts in
      // sequence — measured with the split's own measures.
      const split = splitExtractionSchema(snuggExtractionSchema, effectiveCaps(caps));
      expect(report.pieces?.map((p) => [p.key, p.part, p.parts])).toEqual(
        split.map((entry) => [entry.key, entry.part, entry.parts]),
      );

      // The plan constructs, and its per-key piece counts are the report's.
      const plan = perGroupPlan({
        target,
        chat: pieceChat("snugg", caps).chat,
        model: "m",
        ...(caps.maxNullableUnionsPerGroup === undefined
          ? {}
          : { maxNullableUnionsPerGroup: caps.maxNullableUnionsPerGroup }),
        ...(caps.maxSerializedCharsPerGroup === undefined
          ? {}
          : { maxSerializedCharsPerGroup: caps.maxSerializedCharsPerGroup }),
      });
      const planCounts = Object.fromEntries(
        Object.entries(plan.groups as Record<string, unknown>).map(([key, entry]) => [
          key,
          Array.isArray(entry) ? entry.length : 1,
        ]),
      );
      const reportCounts: Record<string, number> = {};
      for (const piece of report.pieces ?? []) {
        reportCounts[piece.key] = (reportCounts[piece.key] ?? 0) + 1;
      }
      expect(reportCounts).toEqual(planCounts);

      // A schemaExtractor over a counting chat runs one request per reported
      // piece — the per-group path; the Snugg schema is past every cap.
      const { chat, requests } = pieceChat("snugg", caps);
      const extractor = schemaExtractor<SnuggValues>({
        extractionSchema: snuggExtractionSchema,
        name: "snugg",
        instructions: "Extract the audit fields.",
        chat,
        model: "m",
        ...(caps.maxNullableUnionsPerGroup === undefined
          ? {}
          : { maxNullableUnionsPerGroup: caps.maxNullableUnionsPerGroup }),
        ...(caps.maxSerializedCharsPerGroup === undefined
          ? {}
          : { maxSerializedCharsPerGroup: caps.maxSerializedCharsPerGroup }),
      });
      await extractor.extract(transcript);
      expect(requests).toHaveLength(report.pieces?.length ?? 0);
    });
  }

  test("the tighter union cap produces strictly more pieces — the matrix cell matters", () => {
    const relaxed = describeExtraction({ extractionSchema: snuggExtractionSchema });
    const tighter = describeExtraction({
      extractionSchema: snuggExtractionSchema,
      maxNullableUnionsPerGroup: 8,
    });
    expect(tighter.pieces?.length).toBeGreaterThan(relaxed.pieces?.length ?? 0);
  });

  test("every reported piece measures under the route's own caps", () => {
    const report = describeExtraction({
      extractionSchema: snuggExtractionSchema,
      maxSerializedCharsPerGroup: SCHEMA_SERIALIZED_CHAR_CAP,
    });
    for (const piece of report.pieces ?? []) {
      expect(piece.nullableUnions).toBeLessThanOrEqual(MAX_NULLABLE_UNIONS_PER_CALL);
      expect(piece.serializedChars).toBeLessThan(SCHEMA_SERIALIZED_CHAR_CAP);
    }
  });
});
