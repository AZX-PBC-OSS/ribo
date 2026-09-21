import { expect, test } from "vitest";

import type { PhaseItemOutcome, PhaseOutput } from "./phase-outcome.js";

// Small helpers constructing each arm, so the union stays genuinely exclusive and the
// round-trip tests read as calls rather than inline literals. Each returns the NARROWED
// branch rather than the union — a caller that builds one of these knows which branch it
// built, matching `arbitration.ts`'s `resultOutcome`/`errorOutcome`.
type StringBoolOutcome = PhaseItemOutcome<string, boolean>;
type ResultArm = Extract<StringBoolOutcome, { outcome: "result" }>;
type ErrorArm = Extract<StringBoolOutcome, { outcome: "error" }>;

const resultOutcome = (item: string, output: PhaseOutput<boolean>): ResultArm => ({
  outcome: "result",
  item,
  output,
});

const errorOutcome = (item: string, error: unknown): ErrorArm => ({
  outcome: "error",
  item,
  error,
});

test("a result outcome round-trips its members", () => {
  const outcome = resultOutcome("group-a", { value: true, usage: { calls: 1 } });
  expect(outcome.outcome).toBe("result");
  expect(outcome.item).toBe("group-a");
  expect(outcome.output).toEqual({ value: true, usage: { calls: 1 } });
});

test("an error outcome round-trips its members", () => {
  const cause = new Error("boom");
  const outcome = errorOutcome("group-b", cause);
  expect(outcome.outcome).toBe("error");
  expect(outcome.item).toBe("group-b");
  expect(outcome.error).toBe(cause);
});

test("narrowing on the outcome discriminant works without a cast", () => {
  const settled: readonly PhaseItemOutcome<string, boolean>[] = [
    resultOutcome("a", { value: true }),
    errorOutcome("b", new Error("boom")),
  ];
  const values: boolean[] = [];
  const errors: unknown[] = [];
  for (const outcome of settled) {
    if (outcome.outcome === "result") {
      const value: boolean = outcome.output.value;
      values.push(value);
    } else {
      errors.push(outcome.error);
    }
  }
  expect(values).toEqual([true]);
  expect(errors).toHaveLength(1);
});

test("on the error arm, error is present and reading output is a compile error", () => {
  const outcome: PhaseItemOutcome<string, boolean> = errorOutcome("b", new Error("boom"));
  if (outcome.outcome === "error") {
    expect(outcome.error).toBeInstanceOf(Error);
    // The member genuinely does not exist on the error arm — the directive is the
    // assertion (an unused one fails the build with TS2578). See
    // extraction-observer.test.ts for the house pattern.
    // @ts-expect-error — the error arm carries no `output`.
    void outcome.output;
  }
});

test("the result arm's exclusivity is pinned by write, not by read", () => {
  const outcome = resultOutcome("a", { value: true });
  if (outcome.outcome === "result") {
    // `error?: never` makes the member EXIST on the result arm — reading it yields
    // `undefined` and compiles clean, so pinning exclusivity with a read produces an
    // unused `@ts-expect-error` and fails the build with TS2578. The member being
    // `never` is what makes this WRITE an error, and the write is the pin.
    // @ts-expect-error — a result outcome cannot be assigned an error.
    outcome.error = new Error("nope");
  }
});

test("the result arm's exclusivity is pinned by construction too", () => {
  // @ts-expect-error — an object literal carrying both a result and an error does not
  // compile: the two arms are exclusive at construction, not merely at reads.
  const both: PhaseItemOutcome<string, boolean> = {
    outcome: "result",
    item: "a",
    output: { value: true },
    error: new Error("nope"),
  };
  void both;
});
