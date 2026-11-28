/**
 * @file The corpus proposal engine's behaviour, over a scripted stub chat —
 * no real model, no network, no credential.
 *
 * Pinned here: the grounded scalar value, the scalar absence, the two-row
 * collection pivoted to the ordinals the scorer reads, a leaf missing from
 * one row omitting that ordinal, an empty collection becoming proposed
 * absences, nested collection rows flattening in document order, a quote
 * found only in the second input naming that input, and the collection-path
 * walk's scalar / single-array / nested-array answers.
 */
import { expect, test } from "vitest";
import { z } from "zod";

import type { ChatClient, ChatRequest } from "@azx/ribo-core";
import { walkLeafInventory } from "@azx/ribo-core";

import { walkCollectionPaths } from "./corpus/collection-paths.js";
import type { CollectionPathEntry } from "./corpus/collection-paths.js";
import { proposeCase } from "./corpus/propose.js";
import { joinCaseInputTexts } from "./eval/case-text.js";
import { readProducedLeaf } from "./eval/score-fields.js";
import { ExpectationEntrySchema } from "./index.js";
import type { ExpectationEntry } from "./index.js";

/** The test corpus's schema: scalar leaves, one collection, one nested collection. */
const corpusSchema = z.object({
  home: z.object({
    address: z.string(),
    yearBuilt: z.number(),
    occupied: z.boolean(),
  }),
  heating: z.object({ fuel: z.enum(["gas", "electric", "oil"]) }),
  upgrades: z.array(z.object({ measure: z.string(), cost: z.number() })),
  zones: z.array(z.object({ rooms: z.array(z.object({ name: z.string() })) })),
});

const inventory = walkLeafInventory(corpusSchema);
const allLeafPaths = inventory.map((entry) => entry.path);

const inputs = [
  {
    file: "notes.txt",
    kind: "text" as const,
    text: "The home is at 14 Maple Street, built 1928.\n",
  },
  {
    file: "visit.txt",
    kind: "transcript" as const,
    text: "Heating runs on gas. Attic insulation top-up quoted at 1800. Air sealing quoted at 400.\n",
  },
];
const caseText = joinCaseInputTexts(inputs);

/** A scripted stub transport: one recorded request per scripted reply. */
const scriptedChat = (
  contents: readonly string[],
): { readonly chat: ChatClient; readonly requests: ChatRequest[] } => {
  const requests: ChatRequest[] = [];
  return {
    requests,
    chat: {
      async complete(request) {
        requests.push(request);
        const content = contents[requests.length - 1];
        if (content === undefined) throw new Error("unexpected propose call");
        return { content };
      },
    },
  };
};

/** One propose round over the fixture with the given scripted replies. */
const propose = async (
  contents: readonly string[],
  overrides?: { readonly unanswered?: readonly string[] },
) => {
  const { chat, requests } = scriptedChat(contents);
  const result = await proposeCase({
    schema: corpusSchema,
    leafInventory: inventory,
    unanswered: overrides?.unanswered ?? allLeafPaths,
    inputs,
    caseText,
    schemaDocument: { openapi: "3.0.0", info: { title: "Fixture" } },
    options: {
      chat,
      model: "stub-proposer",
      backend: "openai-compatible",
      clock: () => new Date("2026-01-01T00:00:00.000Z"),
    },
  });
  return { result, requests };
};

/** An item proposing a quoted value. */
const valueItem = (path: string, value: string | number | boolean, quote: string) => ({
  path,
  value,
  quote,
});

/** A collection cell proposing a quoted value, named by the leaf's full path. */
const valueCell = (leaf: string, value: string | number | boolean, quote: string) => ({
  leaf,
  value,
  quote,
});

/** Assert the entry is asserted, and hand back its typed shape. */
const asAsserted = (
  entry: ExpectationEntry | undefined,
): Extract<ExpectationEntry, { status: "asserted" }> => {
  if (entry === undefined) throw new Error("the expected entry is missing");
  if (entry.status !== "asserted") throw new Error("the expected entry is not asserted");
  return entry;
};

/** Assert the entry is declared-absent, and hand back its typed shape. */
const asAbsent = (
  entry: ExpectationEntry | undefined,
): Extract<ExpectationEntry, { status: "declared-absent" }> => {
  if (entry === undefined) throw new Error("the expected entry is missing");
  if (entry.status !== "declared-absent")
    throw new Error("the expected entry is not declared-absent");
  return entry;
};

test("a scalar value becomes a pending asserted entry whose evidence names the input it quotes", async () => {
  const { result } = await propose([
    JSON.stringify({
      items: [valueItem("home.address", "14 Maple Street", "14 Maple Street")],
      collections: [],
    }),
  ]);
  if (!result.success) throw new Error("the proposal round failed");
  const entry = asAsserted(result.entries["home.address"]);
  expect(entry.value).toBe("14 Maple Street");
  expect(entry.review).toBe("pending");
  expect(entry.proposal).toMatchObject({
    status: "asserted",
    value: "14 Maple Street",
    evidence: { quote: "14 Maple Street", input: "notes.txt" },
    backend: "openai-compatible",
    model: "stub-proposer",
    proposedAt: "2026-01-01T00:00:00.000Z",
  });
  // The entry parses against the shape the loader reads — propose writes
  // corpus-format entries, not a private variant.
  expect(() => ExpectationEntrySchema.parse(entry)).not.toThrow();
});

test("a scalar absence becomes a pending declared-absent entry with no value and no evidence", async () => {
  const { result } = await propose([
    JSON.stringify({ items: [{ path: "home.occupied", absent: true }], collections: [] }),
  ]);
  if (!result.success) throw new Error("the proposal round failed");
  const entry = asAbsent(result.entries["home.occupied"]);
  expect(entry.review).toBe("pending");
  expect(entry.proposal).toEqual({
    status: "declared-absent",
    backend: "openai-compatible",
    model: "stub-proposer",
    proposedAt: "2026-01-01T00:00:00.000Z",
  });
  expect(() => ExpectationEntrySchema.parse(entry)).not.toThrow();
});

test("a two-row collection pivots to the ordinal-keyed value and evidence the scorer reads", async () => {
  const { result } = await propose([
    JSON.stringify({
      items: [],
      collections: [
        {
          path: "upgrades",
          rows: [
            {
              cells: [
                valueCell("upgrades.measure", "attic insulation top-up", "Attic insulation top-up"),
                valueCell("upgrades.cost", 1800, "quoted at 1800"),
              ],
            },
            {
              cells: [
                valueCell("upgrades.measure", "air sealing", "Air sealing"),
                valueCell("upgrades.cost", 400, "quoted at 400"),
              ],
            },
          ],
        },
      ],
    }),
  ]);
  if (!result.success) throw new Error("the proposal round failed");
  const measure = asAsserted(result.entries["upgrades.measure"]);
  expect(measure.value).toEqual({ "0": "attic insulation top-up", "1": "air sealing" });
  expect(measure.proposal).toMatchObject({
    status: "asserted",
    evidence: {
      "0": { quote: "Attic insulation top-up", input: "visit.txt" },
      "1": { quote: "Air sealing", input: "visit.txt" },
    },
  });
  const cost = asAsserted(result.entries["upgrades.cost"]);
  expect(cost.value).toEqual({ "0": 1800, "1": 400 });
  expect(() => ExpectationEntrySchema.parse(measure)).not.toThrow();
  expect(() => ExpectationEntrySchema.parse(cost)).not.toThrow();
});

test("a leaf missing from one row omits that row's ordinal", async () => {
  const { result } = await propose([
    JSON.stringify({
      items: [],
      collections: [
        {
          path: "upgrades",
          rows: [
            {
              cells: [
                valueCell("upgrades.measure", "attic insulation top-up", "Attic insulation top-up"),
                valueCell("upgrades.cost", 1800, "quoted at 1800"),
              ],
            },
            { cells: [valueCell("upgrades.measure", "air sealing", "Air sealing")] },
          ],
        },
      ],
    }),
  ]);
  if (!result.success) throw new Error("the proposal round failed");
  expect(asAsserted(result.entries["upgrades.measure"]).value).toEqual({
    "0": "attic insulation top-up",
    "1": "air sealing",
  });
  const cost = asAsserted(result.entries["upgrades.cost"]);
  expect(cost.value).toEqual({ "0": 1800 });
  expect(cost.proposal).toMatchObject({
    evidence: { "0": { quote: "quoted at 1800", input: "visit.txt" } },
  });
});

test("an empty collection becomes proposed absences for every leaf under it", async () => {
  const { result } = await propose([
    JSON.stringify({ items: [], collections: [{ path: "upgrades", rows: [] }] }),
  ]);
  if (!result.success) throw new Error("the proposal round failed");
  for (const path of ["upgrades.measure", "upgrades.cost"]) {
    const entry = asAbsent(result.entries[path]);
    if (entry.proposal === undefined) throw new Error("the proposed absence carries no proposal");
    expect(entry.proposal.status).toBe("declared-absent");
    expect(() => ExpectationEntrySchema.parse(entry)).not.toThrow();
  }
});

test("nested collection rows flatten in document order under exactly the keys the scorer reads", async () => {
  // The nested fixture: two inner rows across one outer instance's worth of
  // text, in document order.
  const nestedInputs = [
    inputs[0]!,
    {
      file: "visit.txt",
      kind: "transcript" as const,
      text: "Zones: the living room and the kitchen were seen.\n",
    },
  ];
  const requests: ChatRequest[] = [];
  const chat: ChatClient = {
    async complete(request) {
      requests.push(request);
      return {
        content: JSON.stringify({
          items: [],
          collections: [
            {
              path: "zones.rooms",
              rows: [
                { cells: [valueCell("zones.rooms.name", "Living room", "the living room")] },
                { cells: [valueCell("zones.rooms.name", "Kitchen", "the kitchen")] },
              ],
            },
          ],
        }),
      };
    },
  };
  const result = await proposeCase({
    schema: corpusSchema,
    leafInventory: inventory,
    unanswered: allLeafPaths,
    inputs: nestedInputs,
    caseText: joinCaseInputTexts(nestedInputs),
    schemaDocument: { openapi: "3.0.0" },
    options: {
      chat,
      model: "stub-proposer",
      backend: "openai-compatible",
      clock: () => new Date("2026-01-01T00:00:00.000Z"),
    },
  });
  if (!result.success) throw new Error("the nested proposal failed");
  const entry = asAsserted(result.entries["zones.rooms.name"]);
  // Flat ordinals in document order — the pivot the scorer reads, not nested keys.
  expect(Object.keys(entry.value)).toEqual(["0", "1"]);
  expect(entry.value).toEqual({ "0": "Living room", "1": "Kitchen" });
  // And those are exactly the values the scorer's array-transparent read
  // produces from a run's fields over the same nested shape.
  const produced = readProducedLeaf(
    { zones: [{ rooms: [{ name: "Living room" }] }, { rooms: [{ name: "Kitchen" }] }] },
    "zones.rooms.name",
    true,
  );
  expect(produced.inArray).toBe(true);
  expect(produced.values).toEqual(["Living room", "Kitchen"]);
  expect(requests).toHaveLength(1);
});

test("a quote found only in the second input names that input", async () => {
  const { result } = await propose([
    JSON.stringify({
      items: [valueItem("heating.fuel", "gas", "Heating runs on gas")],
      collections: [],
    }),
  ]);
  if (!result.success) throw new Error("the proposal round failed");
  const entry = asAsserted(result.entries["heating.fuel"]);
  expect(entry.proposal).toMatchObject({
    evidence: { quote: "Heating runs on gas", input: "visit.txt" },
  });
});

test("a stub-chat run over the multi-input fixture leaves no leaf silently skipped", async () => {
  const { result } = await propose([
    JSON.stringify({
      items: [
        valueItem("home.address", "14 Maple Street", "14 Maple Street"),
        { path: "home.occupied", absent: true },
      ],
      collections: [
        {
          path: "upgrades",
          rows: [{ cells: [valueCell("upgrades.measure", "air sealing", "Air sealing")] }],
        },
      ],
    }),
  ]);
  if (!result.success) throw new Error("the proposal round failed");
  const answered = new Set(Object.keys(result.entries));
  const named = new Set(result.unproposed.map((leaf) => leaf.path));
  for (const path of allLeafPaths) {
    expect(answered.has(path) || named.has(path)).toBe(true);
  }
  // Every entry is a well-formed pending entry.
  for (const entry of Object.values(result.entries)) {
    expect(entry.review).toBe("pending");
    expect(() => ExpectationEntrySchema.parse(entry)).not.toThrow();
  }
});

test("a case with no unanswered leaf makes no call", async () => {
  const chat: ChatClient = {
    complete: async () => {
      throw new Error("no call is owed for a case with nothing to ask");
    },
  };
  const result = await proposeCase({
    schema: corpusSchema,
    leafInventory: inventory,
    unanswered: [],
    inputs,
    caseText,
    schemaDocument: { openapi: "3.0.0" },
    options: { chat, model: "stub-proposer", backend: "openai-compatible" },
  });
  expect(result).toEqual({ success: true, entries: {}, unproposed: [] });
});

test("the initial request carries the schema document, the asked leaves and the case text", async () => {
  const { requests } = await propose([JSON.stringify({ items: [], collections: [] })], {
    unanswered: ["home.address", "heating.fuel", "upgrades.measure"],
  });
  expect(requests).toHaveLength(1);
  const user = requests[0]!.messages.at(-1)!.content;
  expect(user).toContain('"openapi"');
  expect(user).toContain("- home.address (string)");
  expect(user).toContain('- heating.fuel (enum: "gas" | "electric" | "oil")');
  expect(user).toContain('- upgrades.measure (string) — collection "upgrades"');
  expect(user).toContain("--- BEGIN CASE TEXT ---");
  expect(user).toContain("14 Maple Street");
  expect(requests[0]!.responseFormat.json_schema.name).toBe("ribo_corpus_propose");
  expect(requests[0]!.responseFormat.json_schema.strict).toBe(true);
});

// --- The collection-path walk ---

const entryForPath = (
  entries: readonly CollectionPathEntry[],
  path: string,
): CollectionPathEntry => {
  const entry = entries.find((candidate) => candidate.path === path);
  if (entry === undefined) throw new Error(`the walk produced no entry for "${path}"`);
  return entry;
};

test("the collection-path walk pins scalar, single-array and nested-array membership", () => {
  const entries = walkCollectionPaths(corpusSchema);
  // A scalar leaf has no collection path at all.
  expect(entryForPath(entries, "home.address")).toEqual({ path: "home.address" });
  // A leaf under one array names that array.
  expect(entryForPath(entries, "upgrades.measure")).toEqual({
    path: "upgrades.measure",
    collectionPath: "upgrades",
  });
  // A leaf under nested arrays names its NEAREST array ancestor.
  expect(entryForPath(entries, "zones.rooms.name")).toEqual({
    path: "zones.rooms.name",
    collectionPath: "zones.rooms",
  });
});
