/**
 * @file The proposal engine's trust boundary, over a scripted stub chat — no
 * real model, no network, no credential.
 *
 * Pinned here: malformed JSON is repaired once and then fails the case alone;
 * a marker-line quote, a cross-input quote, a non-member enum value and an
 * unknown path each drop with a reason while the rest survive; the repair
 * request quotes the problems and never the prior reply; and a quote
 * matching two inputs records the earlier one.
 */
import { expect, test } from "vitest";
import { z } from "zod";

import type { ChatClient, ChatRequest } from "@azx/ribo-core";
import { walkLeafInventory } from "@azx/ribo-core";

import { proposeCase } from "./corpus/propose.js";
import { joinCaseInputTexts } from "./eval/case-text.js";

const corpusSchema = z.object({
  home: z.object({ address: z.string(), yearBuilt: z.number() }),
  heating: z.object({ fuel: z.enum(["gas", "electric", "oil"]) }),
  upgrades: z.array(z.object({ measure: z.string() })),
  note: z.string(),
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
    text: "Heating runs on gas. Attic insulation top-up.\n",
  },
];
const caseText = joinCaseInputTexts(inputs);

/** The capture marker that prefixes the second input in the joined text. */
const marker = /\n===== CAPTURE[^\n]*\n/u.exec(caseText)?.[0] ?? "MISSING MARKER";

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

const propose = async (contents: readonly string[]) => {
  const { chat, requests } = scriptedChat(contents);
  const result = await proposeCase({
    schema: corpusSchema,
    leafInventory: inventory,
    unanswered: allLeafPaths,
    inputs,
    caseText,
    schemaDocument: { openapi: "3.0.0" },
    options: {
      chat,
      model: "stub-proposer",
      backend: "openai-compatible",
      clock: () => new Date("2026-01-01T00:00:00Z"),
    },
  });
  return { result, requests };
};

test("malformed JSON is repaired once, then the case fails alone", async () => {
  const { result, requests } = await propose(["not JSON", "still not JSON"]);
  expect(requests).toHaveLength(2);
  if (result.success) {
    throw new Error("a still-unparseable reply after the repair round cannot succeed the case");
  }
  expect(result.reason).toMatch(/repair/iu);
  expect(result.reason).toMatch(/malformed JSON/iu);
});

test("the repair request quotes the problems and never the prior reply", async () => {
  // A reply that parses as JSON but violates the wire schema: the repair
  // must name the problem and must not carry the offending reply text back.
  const bad = JSON.stringify({ items: "not an array", collections: [] });
  const good = JSON.stringify({
    items: [{ path: "home.address", value: "14 Maple Street", quote: "14 Maple Street" }],
    collections: [],
  });
  const { result, requests } = await propose([bad, good]);
  expect(requests).toHaveLength(2);
  const repair = requests[1]!;
  // The prior reply never travels: no assistant turn, and the offending text
  // appears nowhere in the repair request.
  expect(repair.messages.some((message) => message.role === "assistant")).toBe(false);
  expect(JSON.stringify(repair.messages)).not.toContain("not an array");
  const feedback = repair.messages.at(-1)!.content;
  expect(feedback).toMatch(/items/iu);
  expect(feedback).toMatch(/array/iu);
  expect(feedback).toMatch(/repair 1/iu);
  if (!result.success) throw new Error("the repaired reply should have succeeded the case");
  expect(result.entries["home.address"]).toMatchObject({
    status: "asserted",
    value: "14 Maple Street",
  });
});

test("a marker-line quote, a cross-input quote, a non-member enum value and an unknown path each drop with a reason while the rest survive", async () => {
  const bad = JSON.stringify({
    items: [
      // A quote that IS a capture marker line: markers are not any input's text.
      { path: "home.address", value: "marker", quote: marker.trim() },
      // A quote that matches only the joined text: it spans two inputs and
      // the marker between them, so no single input contains it.
      {
        path: "home.yearBuilt",
        value: 1928,
        quote: `built 1928.${marker.trim()}Heating runs on gas.`,
      },
      // A value outside the leaf's declared vocabulary.
      { path: "heating.fuel", value: "propane", quote: "Heating runs on gas" },
      // A path the schema does not declare.
      { path: "no.such.leaf", value: "anything", quote: "Heating runs on gas" },
      // The survivor: a grounded value for a scalar leaf.
      { path: "note", value: "a grounded note", quote: "Attic insulation top-up" },
    ],
    collections: [],
  });
  const { result } = await propose([bad]);
  if (!result.success) throw new Error("item-level problems must not fail the case");
  // The four dropped paths are named with reasons; nothing else is unproposed.
  expect(result.unproposed.map((leaf) => leaf.path)).toEqual([
    "home.address",
    "home.yearBuilt",
    "heating.fuel",
    "no.such.leaf",
  ]);
  const byPath = new Map(result.unproposed.map((leaf) => [leaf.path, leaf.reason]));
  expect(byPath.get("home.address")).toMatch(/quote|input/iu);
  expect(byPath.get("home.yearBuilt")).toMatch(/quote|input/iu);
  expect(byPath.get("heating.fuel")).toMatch(/enum/iu);
  expect(byPath.get("no.such.leaf")).toMatch(/unknown path/iu);
  // The survivor is written, and none of the dropped values reached any entry.
  expect(result.entries["note"]).toMatchObject({ status: "asserted", value: "a grounded note" });
  expect(JSON.stringify(result.entries)).not.toContain("propane");
  expect(JSON.stringify(result.entries)).not.toContain("CAPTURE");
});

test("a quote matching two inputs records the earlier one", async () => {
  const bothInputs = [
    { file: "first.txt", kind: "text" as const, text: "built 1928 in the first.\n" },
    { file: "second.txt", kind: "transcript" as const, text: "The house was built 1928 too.\n" },
  ];
  const { chat, requests } = scriptedChat([
    JSON.stringify({
      items: [{ path: "note", value: "built 1928", quote: "built 1928" }],
      collections: [],
    }),
  ]);
  const result = await proposeCase({
    schema: corpusSchema,
    leafInventory: inventory,
    unanswered: allLeafPaths,
    inputs: bothInputs,
    caseText: joinCaseInputTexts(bothInputs),
    schemaDocument: { openapi: "3.0.0" },
    options: {
      chat,
      model: "stub-proposer",
      backend: "openai-compatible",
      clock: () => new Date("2026-01-01T00:00:00Z"),
    },
  });
  expect(requests).toHaveLength(1);
  if (!result.success) throw new Error("the proposal round failed");
  const entry = result.entries["note"];
  if (entry?.status !== "asserted") throw new Error("the entry should be asserted");
  expect(entry.proposal).toMatchObject({ evidence: { quote: "built 1928", input: "first.txt" } });
});
