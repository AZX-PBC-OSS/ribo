import { z } from "zod";
import { describe, expect, test } from "vitest";

import { proposeShapeOperations } from "./operations-proposer.js";
import { deriveExtractionShapePartially } from "./shape-operations.js";
import type { ShapeOperation } from "./shape-operation.js";
import type { ChatClient, ChatCompletion, ChatRequest } from "../../phases/chat-client.js";

/**
 * @file The proposer emits `partition`: the wire branch is an array of
 * `{label, fields}` pairs (the Helix structured-output route rejects records,
 * the same constraint `moves`' pairs answer), converted to the record form the
 * applier takes; the directive carries the partition bullet and its two
 * composition lines; a committed partition tags its fields `[part: <label>]`
 * on a resume turn's field list; and a wire partition whose parts repeat a
 * label is refused at the conversion — the record cannot carry the duplicate,
 * so it is never handed to the applier and is reported like any other
 * not-committed operation.
 */

const schema = z.object({
  g: z.object({
    a: z.string().nullable().optional(),
    b: z.string().nullable().optional(),
    c: z.string().nullable().optional(),
    d: z.string().nullable().optional(),
  }),
  h: z.array(
    z.object({
      name: z.string().nullable().optional(),
      qty: z.string().nullable().optional(),
    }),
  ),
  top: z.string().nullable().optional(),
});

/** A ChatClient that records every request and replays a script of completions or errors. */
function scriptedChat(script: readonly (ChatCompletion | Error)[]): {
  chat: ChatClient;
  requests: ChatRequest[];
} {
  const requests: ChatRequest[] = [];
  const chat: ChatClient = {
    complete: (request) => {
      requests.push(request);
      const step = script[requests.length - 1];
      if (step === undefined) return Promise.reject(new Error("scripted chat exhausted"));
      return step instanceof Error ? Promise.reject(step) : Promise.resolve(step);
    },
  };
  return { chat, requests };
}

const completion = (body: unknown): ChatCompletion => ({
  content: JSON.stringify(body),
  finishReason: "stop",
});

/**
 * The wire format carries a partition's parts as an array of `{label, fields}`
 * pairs (and a regroup/nest's moves as `{from, to}` pairs — see
 * `proposedOperationsSchema`'s header); the returned operations carry the
 * record forms. Scripts are written as {@link ShapeOperation}s and converted
 * here.
 */
const wireOps = (operations: readonly ShapeOperation[]): unknown => ({
  operations: operations.map((op) => {
    if (op.op === "regroup" || op.op === "nest") {
      return { ...op, moves: Object.entries(op.moves).map(([from, to]) => ({ from, to })) };
    }
    if (op.op === "partition") {
      return {
        ...op,
        parts: Object.entries(op.parts).map(([label, fields]) => ({ label, fields: [...fields] })),
      };
    }
    return op;
  }),
});

const proposeOptions = (chat: ChatClient, context: string) => ({
  chat,
  model: "m",
  context,
  instructions: "",
  // A scripted step that runs out must not stall on real backoff sleeps.
  networkRetryDelay: () => Promise.resolve(),
});

/** Review Focus 4: whatever path the loop took, the returned list applies cleanly. */
const expectCleanDerive = (target: z.ZodObject, operations: readonly ShapeOperation[]): void => {
  const { refusals } = deriveExtractionShapePartially(target, { operations });
  expect(refusals).toEqual([]);
};

type JsonSchemaNode = Record<string, unknown>;

/**
 * Depth-first search for the response schema's partition branch: the object
 * schema whose `op` discriminator is the literal "partition" (rendered as a
 * `const`, or as a one-member `enum`).
 */
const findPartitionBranch = (node: unknown): JsonSchemaNode | undefined => {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findPartitionBranch(item);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (node === null || typeof node !== "object") return undefined;
  const record = node as JsonSchemaNode;
  const properties = record["properties"] as JsonSchemaNode | undefined;
  const op = properties?.["op"] as JsonSchemaNode | undefined;
  const members = op?.["enum"] as readonly unknown[] | undefined;
  if (op !== undefined && (op["const"] === "partition" || members?.[0] === "partition")) {
    return record;
  }
  for (const value of Object.values(record)) {
    const found = findPartitionBranch(value);
    if (found !== undefined) return found;
  }
  return undefined;
};

/**
 * Count the record keywords a closed object branch may not carry, walking a
 * JSON-Schema subtree: every `propertyNames`, and every `additionalProperties`
 * whose value is anything other than `false` (a closed object renders exactly
 * `false`; an open one is a record, which the route rejects).
 */
const countRecordKeywords = (
  node: unknown,
  found: { propertyNames: number; openRecords: number },
): void => {
  if (Array.isArray(node)) {
    for (const item of node) countRecordKeywords(item, found);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const record = node as JsonSchemaNode;
  if ("propertyNames" in record) found.propertyNames++;
  const additional = record.additionalProperties;
  if (additional !== undefined && additional !== false) found.openRecords++;
  for (const value of Object.values(record)) countRecordKeywords(value, found);
};

describe("proposer — the partition operation", () => {
  test("4.1 — a partition arrives as wire pairs and is returned in the record form the applier takes", async () => {
    const { chat, requests } = scriptedChat([
      completion(
        wireOps([
          {
            op: "partition",
            group: "h",
            parts: { identity: ["name"], measure: ["qty"] },
          },
        ]),
      ),
    ]);

    const ops = await proposeShapeOperations(schema, {
      ...proposeOptions(chat, "wire-pairs"),
      maxRepairAttempts: 0,
    });

    expect(ops).toEqual([
      { op: "partition", group: "h", parts: { identity: ["name"], measure: ["qty"] } },
    ]);
    expect(requests).toHaveLength(1);
    expectCleanDerive(schema, ops);
  });

  test("4.2 — the response schema's partition branch carries parts as an array of pairs, record-free", async () => {
    const { chat, requests } = scriptedChat([completion(wireOps([]))]);

    await proposeShapeOperations(schema, proposeOptions(chat, "wire-schema"));

    const wireSchema = requests[0]!.response_format.json_schema.schema;
    const branch = findPartitionBranch(wireSchema);
    expect(branch).toBeDefined();
    const branchProperties = branch!["properties"] as JsonSchemaNode;
    const parts = branchProperties["parts"] as JsonSchemaNode;
    expect(parts["type"]).toBe("array");
    expect(parts["minItems"]).toBe(1);
    const item = parts["items"] as JsonSchemaNode;
    const itemProperties = item["properties"] as JsonSchemaNode;
    expect(itemProperties["label"]).toBeDefined();
    const fields = itemProperties["fields"] as JsonSchemaNode;
    expect(fields["type"]).toBe("array");
    expect(fields["minItems"]).toBe(1);
    const keywords = { propertyNames: 0, openRecords: 0 };
    countRecordKeywords(branch, keywords);
    expect(keywords.propertyNames).toBe(0);
    expect(keywords.openRecords).toBe(0);
  });

  test("4.3 — the directive gains the partition bullet and both composition lines; everything else is byte-identical", async () => {
    const { chat, requests } = scriptedChat([completion(wireOps([]))]);

    await proposeShapeOperations(schema, proposeOptions(chat, "directive"));

    const system = requests[0]!.messages.find((m) => m.role === "system")!.content;
    // Long distinctive substrings pinned from either side of the additions
    // (as 3.11 does): the opening before the first operation bullet, and the
    // closing paragraphs after the composition rules.
    const before =
      "You are proposing shape operations for the user's schema. The schema below is theirs: " +
      "nothing here changes their data, but the operations you select will produce the " +
      "extraction schema a downstream model is asked to fill. The healthier proposal, the " +
      "cleaner the downstream extraction.\n\n" +
      "The supported operations, and their closed composition rule:";
    const after =
      "On a later turn the field list may reappear with some fields tagged [dropped], " +
      "[retyped → number] or [moved → …]: those operations are already applied and locked. " +
      "Reply then with new operations only — the fixes for what was refused plus anything else " +
      "you intend — and never repeat a tagged one; an empty `operations` array means you are " +
      "done.\n\n" +
      "There is no cap on the number of operations. Decide freely which to propose; the schema " +
      "packing, if your proposal is large, is a downstream concern.\n\n" +
      "If no operations are warranted, respond with an empty `operations` array.";
    expect(system.startsWith(before)).toBe(true);
    expect(system.endsWith(after)).toBe(true);
    // The bullet sits with the operation bullets; the composition lines sit in
    // the composition list that follows them.
    const bullet = "- partition { group, parts: [{ label, fields }] }:";
    const compositionStart = system.indexOf("The operations are a SET, not a sequence.");
    const compositionEnd = system.indexOf("On a later turn the field list may reappear");
    expect(system).toContain(bullet);
    expect(system.indexOf(bullet)).toBeGreaterThan(system.indexOf("- nest {"));
    expect(system.indexOf(bullet)).toBeLessThan(compositionStart);
    expect(system).toContain("at most one partition per group");
    expect(system).toContain("a partitioned group cannot also be regrouped");
    expect(system.indexOf("at most one partition per group")).toBeGreaterThan(compositionStart);
    expect(system.indexOf("a partitioned group cannot also be regrouped")).toBeLessThan(
      compositionEnd,
    );
  });

  test("4.4 — a partition duplicating one field across parts is refused while the valid drop in the same reply commits", async () => {
    const { chat, requests } = scriptedChat([
      completion(
        wireOps([
          { op: "drop", path: "g.a" },
          {
            op: "partition",
            group: "g",
            parts: { heating: ["b", "c"], cooling: ["c", "d"] },
          },
        ]),
      ),
      completion(wireOps([])),
    ]);

    const ops = await proposeShapeOperations(schema, proposeOptions(chat, "field-in-two-parts"));

    expect(ops).toEqual([{ op: "drop", path: "g.a" }]);
    expect(requests).toHaveLength(2);
    const feedback = requests[1]!.messages.at(-1)!;
    expect(feedback.role).toBe("user");
    expect(feedback.content).toContain('- partition "g":');
    expect(feedback.content).toContain('names field "c" in parts "heating" and "cooling"');
    expectCleanDerive(schema, ops);
  });

  test("4.5 — a committed partition tags its fields [part: <label>] in the next resume turn's field list", async () => {
    const { chat, requests } = scriptedChat([
      completion(
        wireOps([
          {
            op: "partition",
            group: "g",
            parts: { heating: ["a", "b"], cooling: ["c"] },
          },
          { op: "drop", path: "g.ghost" },
        ]),
      ),
      completion(wireOps([])),
    ]);

    const ops = await proposeShapeOperations(schema, proposeOptions(chat, "part-tags"));

    expect(ops).toEqual([
      { op: "partition", group: "g", parts: { heating: ["a", "b"], cooling: ["c"] } },
    ]);
    expect(requests).toHaveLength(2);
    const fieldList = requests[1]!.messages[1]!;
    expect(fieldList.role).toBe("user");
    expect(fieldList.content).toContain("    - a (string) [part: heating]");
    expect(fieldList.content).toContain("    - b (string) [part: heating]");
    expect(fieldList.content).toContain("    - c (string) [part: cooling]");
    expect(fieldList.content).toContain("    - d (string) [part: remainder]");
    // The FIRST request's field list carries no applied tags.
    expect(requests[0]!.messages[1]!.content).not.toContain("[part:");
    expectCleanDerive(schema, ops);
  });

  test("4.6 — a partition naming a field a drop in the same reply removes: the partition's feedback line names the drop", async () => {
    const { chat, requests } = scriptedChat([
      completion(
        wireOps([
          { op: "drop", path: "g.a" },
          {
            op: "partition",
            group: "g",
            parts: { heating: ["a", "b"], cooling: ["c"] },
          },
        ]),
      ),
      completion(wireOps([])),
    ]);

    const ops = await proposeShapeOperations(schema, proposeOptions(chat, "drop-cause"));

    const feedback = requests[1]!.messages.at(-1)!.content;
    const partitionLine = feedback.split("\n").find((line) => line.startsWith('- partition "g":'));
    expect(partitionLine).toBeDefined();
    expect(partitionLine).toContain('(caused by your drop "g.a"');
    expectCleanDerive(schema, ops);
  });

  test("4.7 — a wire partition whose parts repeat a label is not handed to the applier: the valid drop in the same reply commits, and the feedback names the duplicate label", async () => {
    const { chat, requests } = scriptedChat([
      completion({
        operations: [
          { op: "drop", path: "g.a" },
          {
            op: "partition",
            group: "g",
            parts: [
              { label: "heating", fields: ["b"] },
              { label: "heating", fields: ["c"] },
            ],
          },
        ],
      }),
      completion(wireOps([])),
    ]);

    const ops = await proposeShapeOperations(schema, proposeOptions(chat, "duplicate-label"));

    // The drop committed; the partition did not — and was not collapsed
    // last-write-wins into a different partition either.
    expect(ops).toEqual([{ op: "drop", path: "g.a" }]);
    expect(requests).toHaveLength(2);
    const feedback = requests[1]!.messages.at(-1)!;
    expect(feedback.role).toBe("user");
    const partitionLine = feedback.content
      .split("\n")
      .find((line) => line.startsWith('- partition "g":'));
    expect(partitionLine).toBeDefined();
    expect(partitionLine).toContain("labels must be unique within a group");
    expect(partitionLine).toContain('"heating"');
    expectCleanDerive(schema, ops);
  });
});
