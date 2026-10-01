import { ChatError } from "../../phases/chat-client.js";
import type { ChatClient, ChatCompletion, ChatRequest } from "../../phases/chat-client.js";
import { z } from "zod";
import { describe, expect, test } from "vitest";

import { proposeShapeOperations } from "./operations-proposer.js";
import { deriveExtractionShapePartially } from "./shape-operations.js";
import type { ShapeOperation } from "./shape-operation.js";

/**
 * @file The resuming proposer: a repair reply that contains only the fixes
 * must not discard the operations that already applied — the measured
 * collapse the proposer-resume design answers (448 proposed, 2 refused, the
 * one-operation repair answer zeroed the other 446). These tests pin the
 * resume loop: every parsed attempt is folded into a committed set, a turn
 * with refusals or an outright failure is answered with a FRESH resume
 * request — system prompt, the field list tagged with what is applied and
 * locked, then the feedback — and exhaustion returns the committed set.
 * Every test asserts through `expectCleanDerive` that the returned list
 * derives with zero refusals, whatever path the loop took.
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

/** The wide fixture the collapse tests use: enough leaves for a proposal of thirty-plus operations. */
const wideLeaves = (prefix: string, count: number) =>
  Object.fromEntries(
    Array.from({ length: count }, (_, i) => [
      `${prefix}${i}`,
      z.string().nullable().optional() as z.ZodType,
    ]),
  );
const wideSchema = z.object({
  alpha: z.object(wideLeaves("a", 20)),
  beta: z.object(wideLeaves("b", 20)),
});

const alphaDrops: ShapeOperation[] = Array.from({ length: 15 }, (_, i) => ({
  op: "drop" as const,
  path: `alpha.a${i}`,
}));
const betaRetypes: ShapeOperation[] = Array.from({ length: 15 }, (_, i) => ({
  op: "retype" as const,
  path: `beta.b${i}`,
  to: "number" as const,
}));
/** A duplicate regroup pair on one group — both are refused as a set conflict. */
const regroupA: ShapeOperation = { op: "regroup", group: "alpha", moves: { a15: "extra.a15" } };
const regroupB: ShapeOperation = { op: "regroup", group: "alpha", moves: { a15: "spare.a15" } };

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
 * The wire format carries a regroup/nest's moves as an array of `{from, to}`
 * pairs (see `proposedOperationsSchema`'s header); the returned operations
 * carry the record form. Scripts are written as {@link ShapeOperation}s and
 * converted here.
 */
const wireOps = (operations: readonly ShapeOperation[]): unknown => ({
  operations: operations.map((op) =>
    op.op === "regroup" || op.op === "nest"
      ? { ...op, moves: Object.entries(op.moves).map(([from, to]) => ({ from, to })) }
      : op,
  ),
});

/** Review Focus 4: whatever path the loop took, the returned list applies cleanly. */
const expectCleanDerive = (target: z.ZodObject, operations: readonly ShapeOperation[]): void => {
  const { refusals } = deriveExtractionShapePartially(target, { operations });
  expect(refusals).toEqual([]);
};

const proposeOptions = (chat: ChatClient, context: string) => ({
  chat,
  model: "m",
  context,
  instructions: "",
});

describe("proposer — the resume", () => {
  test("3.1 — the collapse: a resume reply containing only the fix keeps every committed operation", async () => {
    // The measured defect: 30+ valid operations and one duplicate regroup
    // pair on attempt 1; the repair answers with just the corrected regroup.
    // The re-proposing loop returned that one operation and discarded the
    // rest; the resuming loop commits the 30 and folds the fix in.
    const { chat, requests } = scriptedChat([
      completion(wireOps([...alphaDrops, ...betaRetypes, regroupA, regroupB])),
      completion(wireOps([regroupA])),
    ]);

    const ops = await proposeShapeOperations(wideSchema, proposeOptions(chat, "collapse"));

    expect(ops).toEqual([...alphaDrops, ...betaRetypes, regroupA]);
    expect(requests).toHaveLength(2);
    expectCleanDerive(wideSchema, ops);
  });

  test("3.2 — the resume request is fresh: system, user, user; no assistant turn; the same system prompt", async () => {
    const { chat, requests } = scriptedChat([
      completion(wireOps([{ op: "drop", path: "g.ghost" }])),
      completion(wireOps([])),
    ]);

    const ops = await proposeShapeOperations(schema, proposeOptions(chat, "fresh-request"));

    expect(ops).toEqual([]);
    expect(requests).toHaveLength(2);
    expect(requests[0]!.messages.map((m) => m.role)).toEqual(["system", "user"]);
    const resume = requests[1]!;
    expect(resume.messages.map((m) => m.role)).toEqual(["system", "user", "user"]);
    expect(resume.messages[0]).toEqual(requests[0]!.messages[0]);
    expectCleanDerive(schema, ops);
  });

  test("3.3 — the resume field list tags what the committed operations did", async () => {
    const committed1: ShapeOperation[] = [
      { op: "drop", path: "g.a" },
      { op: "retype", path: "g.b", to: "number" },
      { op: "regroup", group: "g", moves: { c: "n.c" } },
    ];
    const { chat, requests } = scriptedChat([
      completion(wireOps([...committed1, { op: "drop", path: "g.ghost" }])),
      completion(wireOps([])),
    ]);

    const ops = await proposeShapeOperations(schema, proposeOptions(chat, "tagged-list"));

    expect(ops).toEqual(committed1);
    expect(requests).toHaveLength(2);
    const fieldList = requests[1]!.messages[1]!;
    expect(fieldList.role).toBe("user");
    expect(fieldList.content).toContain("    - a (string) [dropped]");
    expect(fieldList.content).toContain("    - b (string) [retyped → number]");
    expect(fieldList.content).toContain("    - c (string) [moved → g.n.c]");
    // The FIRST request's field list carries no applied tags.
    expect(requests[0]!.messages[1]!.content).not.toContain("[dropped]");
    expectCleanDerive(schema, ops);
  });

  test("3.4 — the feedback names each refused operation and ends with the new-operations-only instruction", async () => {
    const { chat, requests } = scriptedChat([
      completion(
        wireOps([
          { op: "drop", path: "g.ghost" },
          { op: "retype", path: "g.nope", to: "number" },
        ]),
      ),
      completion(wireOps([])),
    ]);

    const ops = await proposeShapeOperations(schema, proposeOptions(chat, "feedback"));

    expect(ops).toEqual([]);
    const feedback = requests[1]!.messages.at(-1)!;
    expect(feedback.role).toBe("user");
    expect(feedback.content).toContain('- drop "g.ghost":');
    expect(feedback.content).toContain('- retype "g.nope":');
    expect(feedback.content).toContain("only NEW operations");
    expect(feedback.content.trimEnd().endsWith("An empty list means you are done.")).toBe(true);
    expectCleanDerive(schema, ops);
  });

  test("3.12 — an operation conflicting with a committed one is told the committed one is locked, never to retract it", async () => {
    const dropA: ShapeOperation = { op: "drop", path: "g.a" };
    const { chat, requests } = scriptedChat([
      // Attempt 1 commits the drop of g.a; the ghost drop is refused.
      completion(wireOps([dropA, { op: "drop", path: "g.ghost" }])),
      // The resume reply retypes g.a — a path the committed drop removed.
      completion(wireOps([{ op: "retype", path: "g.a", to: "number" }])),
      completion(wireOps([])),
    ]);

    const ops = await proposeShapeOperations(schema, proposeOptions(chat, "locked-conflict"));

    expect(ops).toEqual([dropA]);
    expect(requests).toHaveLength(3);
    const feedback = requests[2]!.messages.at(-1)!;
    expect(feedback.content).toContain(
      'conflicts with the already-applied drop "g.a", which is locked',
    );
    expect(feedback.content).not.toContain("retract");
    expectCleanDerive(schema, ops);
  });

  test("3.5 — a resume reply repeating every committed operation plus the fix commits no duplicates and ends the loop", async () => {
    const { chat, requests } = scriptedChat([
      completion(wireOps([...alphaDrops, ...betaRetypes, regroupA, regroupB])),
      completion(wireOps([...alphaDrops, ...betaRetypes, regroupA])),
    ]);

    const ops = await proposeShapeOperations(wideSchema, proposeOptions(chat, "repeated"));

    // The same list as 3.1: the repeated committed operations are ignored,
    // the fix folds in, and no extra repair turn follows.
    expect(ops).toEqual([...alphaDrops, ...betaRetypes, regroupA]);
    expect(requests).toHaveLength(2);
    expectCleanDerive(wideSchema, ops);
  });

  test("3.6 — a resume reply that is not JSON commits nothing new; the next request carries the JSON feedback", async () => {
    const dropA: ShapeOperation = { op: "drop", path: "g.a" };
    const regroupC: ShapeOperation = { op: "regroup", group: "g", moves: { c: "n.c" } };
    const regroupD: ShapeOperation = { op: "regroup", group: "g", moves: { d: "n.d" } };
    const { chat, requests } = scriptedChat([
      completion(wireOps([dropA, regroupC, regroupD])),
      { content: "{not-json", finishReason: "stop" },
      completion(wireOps([regroupC])),
    ]);

    const ops = await proposeShapeOperations(schema, proposeOptions(chat, "json-resume"));

    expect(ops).toEqual([dropA, regroupC]);
    expect(requests).toHaveLength(3);
    const feedback = requests[2]!.messages.at(-1)!;
    expect(feedback.content).toContain("not valid JSON");
    expectCleanDerive(schema, ops);
  });

  test("3.7 — exhaustion returns the committed set plus the last reply's clean operations", async () => {
    const dropA: ShapeOperation = { op: "drop", path: "g.a" };
    const dropB: ShapeOperation = { op: "drop", path: "g.b" };
    const { chat, requests } = scriptedChat([
      completion(wireOps([dropA, { op: "drop", path: "g.ghost" }])),
      completion(wireOps([{ op: "drop", path: "g.ghost2" }, dropB])),
    ]);

    const ops = await proposeShapeOperations(schema, {
      ...proposeOptions(chat, "exhaustion"),
      maxRepairAttempts: 1,
    });

    expect(ops).toEqual([dropA, dropB]);
    expect(requests).toHaveLength(2);
    expectCleanDerive(schema, ops);
  });

  test("3.8 — transport exhaustion on the resume turn returns attempt 1's committed operations", async () => {
    const dropA: ShapeOperation = { op: "drop", path: "g.a" };
    const limited = ChatError.http(429, "openAiChat: 429 from /chat/completions");
    const { chat, requests } = scriptedChat([
      completion(wireOps([dropA, { op: "drop", path: "g.ghost" }])),
      limited,
      limited,
      limited,
    ]);

    const ops = await proposeShapeOperations(schema, {
      ...proposeOptions(chat, "transport-resume"),
      networkRetryDelay: () => Promise.resolve(),
    });

    expect(ops).toEqual([dropA]);
    // The initial call plus the resume turn's three network tries.
    expect(requests).toHaveLength(4);
    expectCleanDerive(schema, ops);
  });

  test("3.9 — transport exhaustion on the first attempt returns []", async () => {
    const limited = ChatError.http(429, "openAiChat: 429 from /chat/completions");
    const { chat, requests } = scriptedChat([limited, limited, limited]);

    const ops = await proposeShapeOperations(schema, {
      ...proposeOptions(chat, "transport-first"),
      networkRetryDelay: () => Promise.resolve(),
    });

    expect(ops).toEqual([]);
    expect(requests).toHaveLength(3);
    expectCleanDerive(schema, ops);
  });

  test("3.10 — an empty resume reply with refusals outstanding returns the committed list, with no further call", async () => {
    const dropA: ShapeOperation = { op: "drop", path: "g.a" };
    const { chat, requests } = scriptedChat([
      completion(wireOps([dropA, { op: "drop", path: "g.ghost" }])),
      completion(wireOps([])),
    ]);

    const ops = await proposeShapeOperations(schema, proposeOptions(chat, "empty-resume"));

    expect(ops).toEqual([dropA]);
    expect(requests).toHaveLength(2);
    expectCleanDerive(schema, ops);
  });

  test("3.13 — a proposal whose regroup makes the applier throw: no throw out, the rest commits, the regroup is fed back with the thrown message", async () => {
    // A regroup moving a leaf onto a STATIONARY leaf throws inside the
    // applier ("a validated move destination was not free"). The commit rule
    // attributes the throw to that operation; the loop must not let it out.
    const dropTop: ShapeOperation = { op: "drop", path: "top" };
    const badRegroup: ShapeOperation = { op: "regroup", group: "g", moves: { a: "b" } };
    const { chat, requests } = scriptedChat([
      completion(wireOps([dropTop, badRegroup])),
      completion(wireOps([])),
    ]);

    const ops = await proposeShapeOperations(schema, proposeOptions(chat, "throwing-regroup"));

    expect(ops).toEqual([dropTop]);
    expect(requests).toHaveLength(2);
    const feedback = requests[1]!.messages.at(-1)!;
    expect(feedback.content).toContain('- regroup "g":');
    expect(feedback.content).toContain("a validated move destination was not free");
    expectCleanDerive(schema, ops);
  });

  test("3.11 — the directive gains the resume paragraph between the last composition rule and the cap paragraph, both intact", async () => {
    const { chat, requests } = scriptedChat([completion(wireOps([]))]);

    const ops = await proposeShapeOperations(schema, proposeOptions(chat, "directive"));

    const system = requests[0]!.messages.find((m) => m.role === "system")!.content;
    // Long distinctive substrings pinned from either side of the insertion
    // point: the last composition rule and the cap paragraph that follows it.
    const before =
      "a drop that removes what a declaration names is refused: never drop a field tagged [required on create] or [identifying], a group tagged [provenance: ...], or a group containing a tagged field.";
    const after =
      "There is no cap on the number of operations. Decide freely which to propose; the schema packing, if your proposal is large, is a downstream concern.";
    expect(system).toContain(before);
    expect(system).toContain(after);
    const paragraph = system.slice(system.indexOf(before) + before.length, system.indexOf(after));
    expect(paragraph).toContain("[dropped]");
    expect(paragraph).toContain("[retyped → number]");
    expect(paragraph).toContain("[moved → ");
    expect(paragraph).toContain("applied and locked");
    expect(paragraph).toMatch(/new operations only/i);
    expectCleanDerive(schema, ops);
  });

  test("3.14 — a schema defect never throws out: the resume turn renders without deriving an empty committed set", async () => {
    // An empty group is a schema defect the applier throws on. The first
    // attempt's fold throws and is folded into feedback; rendering the resume
    // turn's field list must not derive the (empty) committed set, or the same
    // throw escapes the loop.
    const defective = z.object({
      e: z.object({}),
      top: z.string().nullable().optional(),
    });
    const { chat, requests } = scriptedChat([
      completion(wireOps([{ op: "drop", path: "top" }])),
      completion(wireOps([])),
    ]);

    const ops = await proposeShapeOperations(defective, {
      ...proposeOptions(chat, "schema-defect"),
      maxRepairAttempts: 1,
    });

    expect(ops).toEqual([]);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.messages.at(-1)!.content).toContain(
      "would not produce a valid extraction shape",
    );
  });

  test("3.15 — a culprit in the same reply is not called applied: it was never committed", async () => {
    const { chat, requests } = scriptedChat([
      completion(
        wireOps([
          { op: "drop", path: "g.a" },
          { op: "retype", path: "g.a", to: "number" },
        ]),
      ),
      completion(wireOps([])),
    ]);

    await proposeShapeOperations(schema, proposeOptions(chat, "culprit-wording"));

    const feedback = requests[1]!.messages.at(-1)!.content;
    const retypeLine = feedback.split("\n").find((line) => line.startsWith('- retype "g.a"'))!;
    expect(retypeLine).toContain('drop "g.a" at index 0');
    expect(retypeLine).not.toContain("the applied");
    expect(retypeLine).toContain("not applied either");
  });
});
