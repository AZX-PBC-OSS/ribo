import { z } from "zod";
import { describe, expect, test } from "vitest";

import { commitAttempt } from "./proposal-commit.js";
import type { CommitRefusal } from "./proposal-commit.js";
import type { ShapeOperation } from "./shape-operation.js";
import { deriveExtractionShapePartially } from "./shape-operations.js";
import type { InventoryDeclarations } from "./leaf-inventory.js";

/**
 * @file The commit rule: folding one attempt's operations into the committed
 * set. The fixture is a small schema of the three kinds the proposer sees —
 * an object group with a retype target, an array-of-objects group, and a
 * ground leaf — plus a nested object for the conspired-emptiness case. Every
 * test asserts, through `expectCommittedClean`, that whatever `committed`
 * comes back still derives with zero refusals: the invariant the resuming
 * loop rests on.
 */

const schema = z.object({
  g: z.object({
    a: z.string(),
    b: z.string(),
    x: z.string(),
    inner: z.object({ c: z.string(), d: z.string() }),
  }),
  h: z.array(z.object({ name: z.string(), qty: z.string() })),
  top: z.string(),
});

const expectCommittedClean = (
  target: z.ZodObject,
  declarations: InventoryDeclarations,
  committed: readonly ShapeOperation[],
): void => {
  const { refusals } = deriveExtractionShapePartially(target, {
    ...declarations,
    operations: committed,
  });
  expect(refusals).toEqual([]);
};

describe("commitAttempt", () => {
  test("1.1 — empty committed, all incoming valid: all committed, no refusals", () => {
    const incoming: ShapeOperation[] = [
      { op: "retype", path: "g.a", to: "number" },
      { op: "drop", path: "top" },
    ];
    const { committed, refused } = commitAttempt(schema, {}, [], incoming);
    expect(committed).toEqual(incoming);
    expect(refused).toEqual([]);
    expectCommittedClean(schema, {}, committed);
  });

  test("1.2 — a duplicate pair of drops: the applied one commits, the refused one is reported", () => {
    const first: ShapeOperation = { op: "drop", path: "g.a" };
    const second: ShapeOperation = { op: "drop", path: "g.a" };
    const { committed, refused } = commitAttempt(schema, {}, [], [first, second]);
    expect(committed).toEqual([first]);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.operation).toBe(second);
    expectCommittedClean(schema, {}, committed);
  });

  test("1.3 — culprits not committed: a retype refused naming its drop leaves both out", () => {
    const drop: ShapeOperation = { op: "drop", path: "g.a" };
    const retype: ShapeOperation = { op: "retype", path: "g.a", to: "number" };
    const { committed, refused } = commitAttempt(schema, {}, [], [drop, retype]);
    expect(committed).toEqual([]);
    expect(refused).toHaveLength(2);
    const retypeRefusal = refused.find((r) => r.operation === retype)!;
    expect(retypeRefusal.reason).toContain('retype names "g.a"');
    expect(retypeRefusal.cause).toEqual({ kind: "operation", operation: drop, index: 0 });
    expectCommittedClean(schema, {}, committed);
  });

  test("1.4 — set conflict: two regroups on one group, neither committed, both reported", () => {
    const rg1: ShapeOperation = { op: "regroup", group: "g", moves: { a: "n.a" } };
    const rg2: ShapeOperation = { op: "regroup", group: "g", moves: { b: "n.b" } };
    const { committed, refused } = commitAttempt(schema, {}, [], [rg1, rg2]);
    expect(committed).toEqual([]);
    expect(refused).toHaveLength(2);
    expect(refused.map((r) => r.operation)).toEqual([rg1, rg2]);
    expectCommittedClean(schema, {}, committed);
  });

  test("1.5 — an incoming operation identical to a committed one, moves keys reordered, is ignored", () => {
    const committedRg: ShapeOperation = {
      op: "regroup",
      group: "g",
      moves: { a: "n.a", b: "n.b" },
    };
    const incomingRg: ShapeOperation = {
      op: "regroup",
      group: "g",
      moves: { b: "n.b", a: "n.a" },
    };
    const { committed, refused } = commitAttempt(schema, {}, [committedRg], [incomingRg]);
    expect(committed).toEqual([committedRg]);
    expect(refused).toEqual([]);
    expectCommittedClean(schema, {}, committed);
  });

  test("1.6 — a drop on a path a committed retype retyped: the retype stays, the drop is refused against it", () => {
    const committedRetype: ShapeOperation = { op: "retype", path: "g.a", to: "number" };
    const drop: ShapeOperation = { op: "drop", path: "g.a" };
    const { committed, refused } = commitAttempt(schema, {}, [committedRetype], [drop]);
    expect(committed).toEqual([committedRetype]);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.operation).toBe(drop);
    expect(refused[0]!.reason).toContain("would invalidate an already-applied operation: ");
    expect(refused[0]!.conflictsWithCommitted).toBe(committedRetype);
    expectCommittedClean(schema, {}, committed);
  });

  test("1.7 — a second regroup on a committed regroup's group: the committed one stays, the incoming is refused against it", () => {
    const committedRg: ShapeOperation = { op: "regroup", group: "g", moves: { a: "n.a" } };
    const incomingRg: ShapeOperation = { op: "regroup", group: "g", moves: { b: "n.b" } };
    const { committed, refused } = commitAttempt(schema, {}, [committedRg], [incomingRg]);
    expect(committed).toEqual([committedRg]);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.operation).toBe(incomingRg);
    expect(refused[0]!.conflictsWithCommitted).toBe(committedRg);
    expectCommittedClean(schema, {}, committed);
  });

  test("1.8 — a declaration conflict: the sibling commits, the declared drop reports the declaration cause", () => {
    const declarations: InventoryDeclarations = { requiredOnCreate: { g: ["a"] } };
    const dropA: ShapeOperation = { op: "drop", path: "g.a" };
    const dropB: ShapeOperation = { op: "drop", path: "g.b" };
    const { committed, refused } = commitAttempt(schema, declarations, [], [dropA, dropB]);
    expect(committed).toEqual([dropB]);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.operation).toBe(dropA);
    expect(refused[0]!.cause).toEqual({
      kind: "declaration",
      declaration: "requiredOnCreate",
      group: "g",
      leaf: "a",
    });
    expectCommittedClean(schema, declarations, committed);
  });

  test("1.9 — order: previous committed first, then newly committed in incoming order", () => {
    const previous: ShapeOperation = { op: "drop", path: "top" };
    const retype: ShapeOperation = { op: "retype", path: "g.a", to: "number" };
    const dropQty: ShapeOperation = { op: "drop", path: "h.qty" };
    const { committed } = commitAttempt(schema, {}, [previous], [retype, dropQty]);
    expect(committed).toEqual([previous, retype, dropQty]);
    expectCommittedClean(schema, {}, committed);
  });

  test("1.10 — reported cause indexes are positions in incoming, not in the combined array", () => {
    const committedDrop: ShapeOperation = { op: "drop", path: "g.x" };
    const dropA: ShapeOperation = { op: "drop", path: "g.a" };
    const retype: ShapeOperation = { op: "retype", path: "g.a", to: "number" };
    const { committed, refused } = commitAttempt(schema, {}, [committedDrop], [dropA, retype]);
    expect(committed).toEqual([committedDrop]);
    const retypeRefusal = refused.find((r) => r.operation === retype)!;
    // The cause's raw index in the combined array is 1; reported is the
    // culprit's position in the delta the model sent.
    expect(retypeRefusal.cause).toEqual({ kind: "operation", operation: dropA, index: 0 });
    expectCommittedClean(schema, {}, committed);
  });

  test("1.13 — a drop that conspires with a committed regroup to empty an object: no throw, refused against the regroup", () => {
    const committedRg: ShapeOperation = { op: "regroup", group: "g", moves: { "inner.c": "c" } };
    const drop: ShapeOperation = { op: "drop", path: "g.inner.d" };
    const { committed, refused } = commitAttempt(schema, {}, [committedRg], [drop]);
    expect(committed).toEqual([committedRg]);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.operation).toBe(drop);
    expect(refused[0]!.reason).toContain('the object at "g.inner" has no fields left');
    expect(refused[0]!.conflictsWithCommitted).toBe(committedRg);
    expectCommittedClean(schema, {}, committed);
  });

  test("1.14 — a throwing candidate: the throw is caught, the clean sibling commits, the thrower is reported", () => {
    const drop: ShapeOperation = { op: "drop", path: "top" };
    // Destination "x" is a stationary leaf of g — today the applier throws
    // "internal — a validated move destination was not free."
    const badRg: ShapeOperation = { op: "regroup", group: "g", moves: { a: "x" } };
    const { committed, refused } = commitAttempt(schema, {}, [], [drop, badRg]);
    expect(committed).toEqual([drop]);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.operation).toBe(badRg);
    expect(refused[0]!.reason).toContain("a validated move destination was not free");
    expectCommittedClean(schema, {}, committed);
  });

  test("1.15 — a schema defect: commitAttempt rethrows the applier's message", () => {
    const defective = z.object({ e: z.object({}) });
    expect(() => commitAttempt(defective, {}, [], [])).toThrow(/has no fields left/);
  });

  test("1.11 — a retype on a path a committed drop removed: reported against the drop, no cause", () => {
    const committedDrop: ShapeOperation = { op: "drop", path: "g.a" };
    const retype: ShapeOperation = { op: "retype", path: "g.a", to: "number" };
    const { committed, refused } = commitAttempt(schema, {}, [committedDrop], [retype]);
    expect(committed).toEqual([committedDrop]);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.operation).toBe(retype);
    expect(refused[0]!.cause).toBeUndefined();
    expect(refused[0]!.conflictsWithCommitted).toBe(committedDrop);
    expectCommittedClean(schema, {}, committed);
  });

  test("1.12 — every not-committed incoming operation appears in refused exactly once", () => {
    const expectRefusedOnce = (
      refused: readonly CommitRefusal[],
      incoming: readonly ShapeOperation[],
      committed: readonly ShapeOperation[],
    ): void => {
      for (const op of incoming) {
        const reports = refused.filter((r) => r.operation === op).length;
        if (committed.includes(op)) expect(reports).toBe(0);
        else expect(reports).toBe(1);
      }
    };

    // 1.2's duplicate pair.
    {
      const first: ShapeOperation = { op: "drop", path: "g.a" };
      const second: ShapeOperation = { op: "drop", path: "g.a" };
      const { committed, refused } = commitAttempt(schema, {}, [], [first, second]);
      expectRefusedOnce(refused, [first, second], committed);
    }
    // 1.3's culprit pair — both refused.
    {
      const drop: ShapeOperation = { op: "drop", path: "g.a" };
      const retype: ShapeOperation = { op: "retype", path: "g.a", to: "number" };
      const { committed, refused } = commitAttempt(schema, {}, [], [drop, retype]);
      expectRefusedOnce(refused, [drop, retype], committed);
    }
    // 1.4's set conflict.
    {
      const rg1: ShapeOperation = { op: "regroup", group: "g", moves: { a: "n.a" } };
      const rg2: ShapeOperation = { op: "regroup", group: "g", moves: { b: "n.b" } };
      const { committed, refused } = commitAttempt(schema, {}, [], [rg1, rg2]);
      expectRefusedOnce(refused, [rg1, rg2], committed);
    }
    // 1.6's committed-conflict drop.
    {
      const committedRetype: ShapeOperation = { op: "retype", path: "g.a", to: "number" };
      const drop: ShapeOperation = { op: "drop", path: "g.a" };
      const { committed, refused } = commitAttempt(schema, {}, [committedRetype], [drop]);
      expectRefusedOnce(refused, [drop], committed);
    }
    // 1.7's duplicate regroup against a committed one.
    {
      const committedRg: ShapeOperation = { op: "regroup", group: "g", moves: { a: "n.a" } };
      const incomingRg: ShapeOperation = { op: "regroup", group: "g", moves: { b: "n.b" } };
      const { committed, refused } = commitAttempt(schema, {}, [committedRg], [incomingRg]);
      expectRefusedOnce(refused, [incomingRg], committed);
    }
    // 1.8's declaration conflict.
    {
      const declarations: InventoryDeclarations = { requiredOnCreate: { g: ["a"] } };
      const dropA: ShapeOperation = { op: "drop", path: "g.a" };
      const dropB: ShapeOperation = { op: "drop", path: "g.b" };
      const { committed, refused } = commitAttempt(schema, declarations, [], [dropA, dropB]);
      expectRefusedOnce(refused, [dropA, dropB], committed);
    }
    // 1.11's retype against a committed drop.
    {
      const committedDrop: ShapeOperation = { op: "drop", path: "g.a" };
      const retype: ShapeOperation = { op: "retype", path: "g.a", to: "number" };
      const { committed, refused } = commitAttempt(schema, {}, [committedDrop], [retype]);
      expectRefusedOnce(refused, [retype], committed);
    }
  });
});
