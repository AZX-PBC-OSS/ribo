import { enveloped } from "../../provenance/enveloped.js";
import type { ChatClient, ChatRequest } from "../../phases/chat-client.js";
import type { ExtractionTarget } from "../extractor.js";
import { z } from "zod";
import { describe, expect, test } from "vitest";

import { generateShapedValue } from "../shape/shape-generate.js";
import { perGroupPlan } from "../strategies/per-group.js";
import { schemaExtractor } from "../strategies/schema-extractor.js";
import { describeExtraction } from "./describe-extraction.js";
import { MAX_NULLABLE_UNIONS_PER_CALL, splitExtractionSchema } from "./split-schema.js";
import type { SplitOptions } from "./split-schema.js";

/**
 * @file The agreement test (describe-extraction-design.md §5): the report is
 * only worth having if it cannot drift from what construction does, so over a
 * corpus covering every branch the split takes — object of groups, mixed
 * groups plus one loose leaf, flat object, non-object, empty object,
 * collection groups, and a group no piece can fit — crossed with no caps /
 * union cap only / byte cap / both, this suite asserts the report against the
 * REAL constructions:
 *
 *   - no refusal: `perGroupPlan` over a fake chat constructs, and on the
 *     per-group path its per-key piece counts are the report's; a
 *     `schemaExtractor` over a counting chat runs one extraction and its
 *     request count is one on the single-shot path and the reported piece
 *     count on the per-group path;
 *   - refusal: the real construction throws, and the message equals the
 *     report's.
 *
 * The per-key comparison is scoped to the per-group path on purpose:
 * `perGroupPlan` splits unconditionally while the report's single-shot row is
 * the one call `schemaExtractor` would make instead — the two constructors
 * differ by design (ADR 0014), and the single-shot arm's agreement is the
 * request count.
 */

const leaf = () => z.string().nullable().optional();

// --- The corpus ---------------------------------------------------------------

/** A leaf priced out of every piece: seventeen `.nullable()` wrappers = 17 unions. */
const overweight = (() => {
  let fat: z.ZodType = z.string();
  for (let i = 0; i < 17; i++) fat = fat.nullable();
  return z.strictObject({ g: z.strictObject({ fat }) });
})();

const corpus: Record<string, z.ZodType> = {
  groups: enveloped(
    z
      .object({
        alpha: z.object({ a1: leaf(), a2: leaf() }).strict().optional(),
        beta: z.object({ b1: leaf(), b2: leaf() }).strict().optional(),
        delta: z.object({ d1: leaf(), d2: leaf() }).strict().optional(),
      })
      .strict(),
  ),
  mixed: enveloped(
    z
      .object({
        alpha: z.object({ a1: leaf(), a2: leaf() }).strict().optional(),
        beta: z.object({ b1: leaf(), b2: leaf() }).strict().optional(),
        note: leaf(),
      })
      .strict(),
  ),
  flat: enveloped(z.object({ f1: leaf(), f2: leaf(), f3: leaf(), f4: leaf() }).strict()),
  // A top-level array of group objects — the split doc's "top-level array of
  // envelopes", taken from a real derivation.
  nonObject: enveloped(
    z.object({ hvac: z.array(z.object({ h1: leaf(), h2: leaf() }).strict()).optional() }).strict(),
  ).shape.hvac,
  empty: z.strictObject({}),
  collections: enveloped(
    z
      .object({
        hvac: z.array(z.object({ h1: leaf(), h2: leaf() }).strict()).optional(),
        dhw: z.array(z.object({ w1: leaf() }).strict()).optional(),
      })
      .strict(),
  ),
  overweight,
};

/**
 * The cap matrix. `bytes: 900` was chosen against the fixtures' measured
 * renderings: above every single-leaf piece (≈490 chars) and every
 * collections group, below the `groups`/`mixed`/`flat` wholes — so the byte
 * path runs everywhere and partitioning happens where the cell comments say.
 */
const capSets: Record<string, SplitOptions> = {
  none: {},
  unions: { maxNullableUnionsPerGroup: 3 },
  bytes: { maxSerializedCharsPerGroup: 900 },
  both: { maxNullableUnionsPerGroup: 3, maxSerializedCharsPerGroup: 900 },
};

// --- The harness ----------------------------------------------------------------

const transcript = { text: "The auditor noted every field aloud.", annotations: {} };

/** The options the presets would hand the split: the union cap defaults to 16. */
const effectiveCaps = (caps: SplitOptions): SplitOptions => ({
  maxNullableUnionsPerGroup: caps.maxNullableUnionsPerGroup ?? MAX_NULLABLE_UNIONS_PER_CALL,
  ...(caps.maxSerializedCharsPerGroup === undefined
    ? {}
    : { maxSerializedCharsPerGroup: caps.maxSerializedCharsPerGroup }),
});

/**
 * A ChatClient that records every request and answers each with a generated
 * value admissible by that piece's schema. Dispatch is on the request's own
 * `json_schema.schema` RENDERING, not its name: the plan names an
 * unpartitioned loose piece `${name}` with no group infix
 * (`per-group.ts`'s "" arm) — the same name the single-shot path gives the
 * whole-schema request — so on a mixed schema a name-keyed map cannot hold
 * both answers. Two entries share a rendering only when their schemas are
 * identical, and then one generated value parses for both. An unexpected
 * request schema throws here rather than passing on a canned `{}` that never
 * parses; the labels listed in the error are the plan's own piece names.
 */
function pieceChat(
  name: string,
  schema: z.ZodType,
  caps: SplitOptions,
): {
  chat: ChatClient;
  requests: ChatRequest[];
} {
  const render = (piece: z.ZodType): string =>
    JSON.stringify(z.toJSONSchema(piece, { target: "draft-2020-12" }));
  const content = new Map<string, string>();
  const labels: string[] = [];
  const add = (label: string, piece: z.ZodType): void => {
    content.set(render(piece), JSON.stringify(generateShapedValue(piece)));
    labels.push(label);
  };
  add(name, schema);
  for (const entry of splitExtractionSchema(schema, effectiveCaps(caps))) {
    const partSuffix = entry.part === undefined ? "" : `-${entry.part}`;
    const pieceName =
      entry.key === "" ? `${name}${partSuffix}` : `${name}-${entry.key}${partSuffix}`;
    add(pieceName, entry.schema);
  }
  const requests: ChatRequest[] = [];
  return {
    requests,
    chat: {
      complete: (request) => {
        requests.push(request);
        const answer = content.get(JSON.stringify(request.response_format.json_schema.schema));
        if (answer === undefined) {
          throw new Error(
            `unexpected request schema (name "${request.response_format.json_schema.name}") — the ` +
              `construction sent a piece this test did not predict: ${labels.join(", ")}`,
          );
        }
        return Promise.resolve({ content: answer, finishReason: "stop" as const });
      },
    },
  };
}

/**
 * The corpus is heterogeneous, so the target is typed at the erased level the
 * strategies' own implementations use — the cast names that, nothing more.
 */
const targetFor = (name: string, schema: z.ZodType): ExtractionTarget<Record<string, unknown>> =>
  ({
    name,
    extractionSchema: schema,
    instructions: "Extract the fields.",
    examples: [],
  }) as ExtractionTarget<Record<string, unknown>>;

/** Per-key piece counts out of a constructed plan: an array entry is a partitioned key. */
const planPieceCounts = (plan: {
  groups: Record<string, unknown>;
  unwrapped?: unknown;
}): Record<string, number> => {
  const counts = Object.fromEntries(
    Object.entries(plan.groups).map(([key, entry]) => [
      key,
      Array.isArray(entry) ? entry.length : 1,
    ]),
  );
  // The plan's unwrapped slot is the report's `""` piece(s): fold it in under
  // the internal marker so both sides speak the split's per-key vocabulary.
  if (plan.unwrapped !== undefined) {
    counts[""] = Array.isArray(plan.unwrapped) ? plan.unwrapped.length : 1;
  }
  return counts;
};

/** Per-key piece counts out of the report's piece rows. */
const reportPieceCounts = (
  pieces: readonly { key: string }[] | undefined,
): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const piece of pieces ?? []) counts[piece.key] = (counts[piece.key] ?? 0) + 1;
  return counts;
};

// --- The matrix -----------------------------------------------------------------

describe("the matrix exercises every branch it exists for", () => {
  // A coverage pin, not a behaviour assertion: the per-cell table records WHICH
  // path each corpus × caps cell takes, so a fixture edit that shrinks the
  // coverage (a cell quietly going single-shot, a refusal going away) fails
  // here and forces the edit to re-justify the branch it dropped. The piece
  // counts were hand-derived from the fixtures' measured renderings.
  const cell = (schema: z.ZodType, caps: SplitOptions): string => {
    const report = describeExtraction({ extractionSchema: schema, ...caps });
    if (report.refusal !== undefined) return `refusal:${report.refusal.stage}`;
    return `${report.callShape}:${report.pieces?.length ?? 0}`;
  };
  const table = Object.fromEntries(
    Object.entries(corpus).map(([name, schema]) => [
      name,
      Object.fromEntries(
        Object.entries(capSets).map(([capsName, caps]) => [capsName, cell(schema, caps)]),
      ),
    ]),
  );

  test("call shape, piece count or refusal per cell", () => {
    expect(table).toEqual({
      // 12 unions, whole 2003 chars: default fits; union cap 3 halves every
      // group; byte cap 900 fits every group but not the whole.
      groups: {
        none: "single-shot:1",
        unions: "per-group:6",
        bytes: "per-group:3",
        both: "per-group:6",
      },
      // 10 unions, whole 1630: the default fits, so single-shot. The mixed
      // split (ADR 0023) carries the groups beside the loose leaf — under the
      // union cap each 4-union group halves and the loose leaf rides one ""
      // piece (5); the byte cap fits each group whole but not the whole
      // schema (3); both caps partition the groups the same way unions alone
      // do (5). The live run's §3 refusal is gone.
      mixed: {
        none: "single-shot:1",
        unions: "per-group:5",
        bytes: "per-group:3",
        both: "per-group:5",
      },
      flat: {
        none: "single-shot:1",
        unions: "per-group:1",
        bytes: "per-group:2",
        both: "per-group:4",
      },
      // 4 unions, 682 chars: only the union cap 3 selects per-group, and the
      // split still answers one "" entry — a non-object partitions under no
      // cap.
      nonObject: {
        none: "single-shot:1",
        unions: "per-group:1",
        bytes: "single-shot:1",
        both: "per-group:1",
      },
      empty: {
        none: "single-shot:1",
        unions: "single-shot:1",
        bytes: "single-shot:1",
        both: "single-shot:1",
      },
      // 6 unions over two arrays: the union cap halves hvac; the byte cap
      // fits both groups but not the whole.
      collections: {
        none: "single-shot:1",
        unions: "per-group:3",
        bytes: "per-group:2",
        both: "per-group:3",
      },
      // 17 unions in one leaf: refused under EVERY cap set — the union-only
      // message under `none`/`unions`, the two-cap message where a byte cap
      // rides along, so both refusal wordings are pinned against reality.
      overweight: {
        none: "refusal:split",
        unions: "refusal:split",
        bytes: "refusal:split",
        both: "refusal:split",
      },
    });
  });
});

describe("describeExtraction agrees with construction over the corpus × caps matrix", () => {
  for (const [corpusName, schema] of Object.entries(corpus)) {
    for (const [capsName, caps] of Object.entries(capSets)) {
      test(`${corpusName} × ${capsName}`, async () => {
        const report = describeExtraction({ extractionSchema: schema, ...caps });
        const buildPlan = (): unknown =>
          perGroupPlan({
            target: targetFor("corpus", schema),
            chat: pieceChat("corpus", schema, caps).chat,
            model: "m",
            ...(caps.maxNullableUnionsPerGroup === undefined
              ? {}
              : { maxNullableUnionsPerGroup: caps.maxNullableUnionsPerGroup }),
            ...(caps.maxSerializedCharsPerGroup === undefined
              ? {}
              : { maxSerializedCharsPerGroup: caps.maxSerializedCharsPerGroup }),
          });
        const buildSchemaExtractor = (chat: ChatClient): unknown =>
          schemaExtractor({
            extractionSchema: schema as ExtractionTarget<
              Record<string, unknown>
            >["extractionSchema"],
            name: "corpus",
            instructions: "Extract the fields.",
            chat,
            model: "m",
            ...(caps.maxNullableUnionsPerGroup === undefined
              ? {}
              : { maxNullableUnionsPerGroup: caps.maxNullableUnionsPerGroup }),
            ...(caps.maxSerializedCharsPerGroup === undefined
              ? {}
              : { maxSerializedCharsPerGroup: caps.maxSerializedCharsPerGroup }),
          });

        if (report.refusal !== undefined) {
          // Refusal either way: construction throws, with the report's message.
          expect(buildPlan).toThrow(report.refusal.message);
          expect(() => buildSchemaExtractor(pieceChat("corpus", schema, caps).chat)).toThrow(
            report.refusal.message,
          );
          expect(report.pieces).toBeUndefined();
          return;
        }

        // No refusal: the plan constructs, and on the per-group path the
        // report's pieces ARE the split's entries — key, part and parts in
        // sequence — and the plan's per-key piece counts.
        expect(report.pieces).toBeDefined();
        const plan = buildPlan() as { groups: Record<string, unknown>; unwrapped?: unknown };
        if (report.callShape === "per-group") {
          const split = splitExtractionSchema(schema, effectiveCaps(caps));
          expect(report.pieces?.map((p) => [p.key, p.part, p.parts])).toEqual(
            split.map((entry) => [entry.key, entry.part, entry.parts]),
          );
          expect(reportPieceCounts(report.pieces)).toEqual(planPieceCounts(plan));
        }

        // The selection: one request single-shot, one per piece per-group.
        if (corpusName === "nonObject" && report.callShape === "per-group") {
          // A top-level ARRAY through the per-group combinator constructs but
          // its run cannot merge: `groupedExtractor`'s "" arm assigns fields
          // into a record, and an array's fields are not a record. That is
          // pre-existing library behaviour the report does not claim to fix —
          // the agreement asserted here is that CONSTRUCTION matches.
          expect(() => buildSchemaExtractor(pieceChat("corpus", schema, caps).chat)).not.toThrow();
          return;
        }
        const { chat, requests } = pieceChat("corpus", schema, caps);
        const extractor = buildSchemaExtractor(chat) as {
          extract: (t: typeof transcript) => Promise<unknown>;
        };
        await extractor.extract(transcript);
        expect(requests).toHaveLength(
          report.callShape === "single-shot" ? 1 : report.pieces!.length,
        );
      });
    }
  }
});
