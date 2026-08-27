import { describe, expect, test } from "vitest";

import type { ExtractionResult } from "./extractor.js";
import { TerminalQueueError, isTransientFailure } from "./queue/backoff.js";
import {
  acceptAnySuccess,
  errorOutcome,
  resultOutcome,
  terminalFallsThrough,
  type ArbiterInput,
  type ExtractionArbiter,
} from "./arbitration.js";

function makeResult<F>(fields: F): ExtractionResult<F> {
  return { fields, usage: { calls: 1 } };
}

function makeInput<F>(outcomes: ArbiterInput<F>["outcomes"], exhausted = false): ArbiterInput<F> {
  return { outcomes, exhausted };
}

type Verdict = ReturnType<ExtractionArbiter<unknown>>;

function expectContinue(verdict: Verdict): void {
  expect(verdict).toEqual({ continue: true });
}

function expectGiveUp(verdict: Verdict, error: unknown): void {
  expect(verdict).toEqual({ giveUp: error });
  if ("giveUp" in verdict) {
    expect(verdict.giveUp).toBe(error);
  }
}

function expectAccept(verdict: Verdict, result: ExtractionResult<unknown>): void {
  expect(verdict).toEqual({ accept: result });
  if ("accept" in verdict) {
    expect(verdict.accept).toBe(result);
  }
}

// Compile-time check that the default arbiters satisfy the contract for a
// concrete field type, not just `unknown`.
const _arbiterCheck: ExtractionArbiter<{ value: number }> = terminalFallsThrough;
const _anySuccessCheck: ExtractionArbiter<{ value: number }> = acceptAnySuccess;
void _arbiterCheck;
void _anySuccessCheck;

describe("outcome discrimination", () => {
  // An earlier implementation discriminated on key presence (`"result" in outcome`).
  // `result?: never` permits an explicit `undefined`, so this error outcome read as a
  // SUCCESS and the arbiter returned `{ accept: undefined }` — accepting a result that
  // does not exist while swallowing the error. Guards now test the VALUE.
  test("an error outcome carrying an explicit result: undefined is not a success", () => {
    const boom = Object.assign(new Error("service unavailable"), { status: 503 });
    const outcome = { candidate: "a", error: boom, result: undefined };

    expectGiveUp(terminalFallsThrough(makeInput([outcome], true)), boom);
    expectGiveUp(acceptAnySuccess(makeInput([outcome], true)), boom);
  });

  // `throw undefined` is legal, so an error outcome may carry no error value at all.
  // It must still be an error, never a success.
  test("an error outcome whose error is undefined is still an error", () => {
    const outcome = { candidate: "a", error: undefined };

    expectGiveUp(terminalFallsThrough(makeInput([outcome], true)), undefined);
  });
});

describe("terminalFallsThrough", () => {
  test("falls through on a terminal error and gives up on a transient 503", () => {
    const terminal = new TerminalQueueError("truncated");
    const transient = Object.assign(new Error("service unavailable"), { status: 503 });

    expect(isTransientFailure(terminal)).toBe(false);
    expect(isTransientFailure(transient)).toBe(true);

    expectContinue(terminalFallsThrough(makeInput([errorOutcome("a", terminal)])));
    expectGiveUp(terminalFallsThrough(makeInput([errorOutcome("a", transient)])), transient);
  });

  test("gives up on a bare Error with no status", () => {
    const error = new Error("network down");
    expect(isTransientFailure(error)).toBe(true);

    expectGiveUp(terminalFallsThrough(makeInput([errorOutcome("a", error)])), error);
  });

  test("gives up with the first error at exhaustion after two terminal failures", () => {
    const first = new TerminalQueueError("first");
    const second = new TerminalQueueError("second");

    expectContinue(terminalFallsThrough(makeInput([errorOutcome("a", first)])));
    expectGiveUp(
      terminalFallsThrough(makeInput([errorOutcome("a", first), errorOutcome("b", second)], true)),
      first,
    );
  });

  test("accepts a result that appears after an earlier failure", () => {
    const fields = { value: 1 };
    const result = makeResult(fields);
    const error = new TerminalQueueError("bad");

    expectAccept(
      terminalFallsThrough(makeInput([errorOutcome("a", error), resultOutcome("b", result)])),
      result,
    );
  });
});

describe("acceptAnySuccess", () => {
  test("continues past terminal and transient errors where terminalFallsThrough would give up", () => {
    const terminal = new TerminalQueueError("bad");
    const transient = Object.assign(new Error("service unavailable"), { status: 503 });

    expectContinue(acceptAnySuccess(makeInput([errorOutcome("a", terminal)])));
    expectContinue(acceptAnySuccess(makeInput([errorOutcome("a", transient)])));
  });

  test("gives up with the first error at exhaustion when only failures landed", () => {
    const first = new Error("first");
    const second = new Error("second");

    expectContinue(acceptAnySuccess(makeInput([errorOutcome("a", first)])));
    expectGiveUp(
      acceptAnySuccess(makeInput([errorOutcome("a", first), errorOutcome("b", second)], true)),
      first,
    );
  });

  test("accepts a result that appears after an earlier failure", () => {
    const fields = { value: 2 };
    const result = makeResult(fields);
    const error = new Error("bad");

    expectAccept(
      acceptAnySuccess(makeInput([errorOutcome("a", error), resultOutcome("b", result)])),
      result,
    );
  });
});
