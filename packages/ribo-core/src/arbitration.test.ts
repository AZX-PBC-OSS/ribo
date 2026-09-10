import { describe, expect, expectTypeOf, test } from "vitest";

import type { ExtractionResult } from "./extractor.js";
import { TerminalQueueError, isTransientFailure } from "./queue/backoff.js";
import { SchemaParseError } from "./schema-parse-error.js";
import {
  acceptAnySuccess,
  errorOutcome,
  resultOutcome,
  terminalFallsThrough,
  type ArbiterInput,
  type ErrorOutcome,
  type ExtractionArbiter,
  type ExtractionOutcome,
  type ResultOutcome,
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
    const outcome = { candidate: "a", error: boom, result: undefined, outcome: "error" as const };

    expectGiveUp(terminalFallsThrough(makeInput([outcome], true)), boom);
    expectGiveUp(acceptAnySuccess(makeInput([outcome], true)), boom);
  });

  // `throw undefined` is legal, so an error outcome may carry no error value at all.
  // It must still be an error, never a success.
  test("an error outcome whose error is undefined is still an error", () => {
    const outcome = { candidate: "a", error: undefined, outcome: "error" as const };

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

  test("falls through on a schema parse error even though it is transient", () => {
    // A schema miss is sampled: the same request can pass zod on re-send, so it
    // must stay transient (the queue keeps retrying). But it is also a shape
    // mismatch, so the ladder should move on to a different strategy rather than
    // sampling the same shape indefinitely.
    const schemaError = new SchemaParseError(
      "did not match the schema: equipment: expected object",
    );
    expect(isTransientFailure(schemaError)).toBe(true);

    expectContinue(terminalFallsThrough(makeInput([errorOutcome("a", schemaError)])));
  });

  // `continue` is illegal at exhaustion — the engine rejects it as a caller bug. An
  // earlier version checked the schema-parse branch before the exhaustion branch, so a
  // ladder whose candidates ALL sampled badly returned `continue` on the last call and
  // died with a TypeError instead of surfacing the parse error. This is the primary
  // case the arbiter exists for, so it is pinned rather than left to the engine.
  test("gives up, not continues, when every candidate failed schema parse and the ladder is exhausted", () => {
    const first = new SchemaParseError("tier1 did not match the schema");
    const second = new SchemaParseError("tier2 did not match the schema");

    expectGiveUp(
      terminalFallsThrough(
        makeInput([errorOutcome("tier1", first), errorOutcome("tier2", second)], true),
      ),
      first,
    );
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

describe("outcome tag", () => {
  test("resultOutcome() stamps outcome: 'result'", () => {
    const outcome = resultOutcome("a", makeResult({ value: 1 }));
    expect(outcome.outcome).toBe("result");
  });

  test("errorOutcome() stamps outcome: 'error'", () => {
    const outcome = errorOutcome("a", new Error("boom"));
    expect(outcome.outcome).toBe("error");
  });

  test("switch on outcome.outcome narrows each arm to its own members with no cast", () => {
    const outcomes: readonly ExtractionOutcome<{ value: number }>[] = [
      resultOutcome("a", makeResult({ value: 1 })),
      errorOutcome("b", new Error("boom")),
    ];

    for (const outcome of outcomes) {
      switch (outcome.outcome) {
        case "result":
          // Narrowed to ResultOutcome — result is accessible.
          expect(outcome.result.fields).toEqual({ value: 1 });
          break;
        case "error":
          // Narrowed to ErrorOutcome — error is accessible.
          expect(outcome.error).toBeInstanceOf(Error);
          break;
      }
    }
  });

  test("Extract<ExtractionOutcome<F>, { outcome: 'result' }> is ResultOutcome<F>", () => {
    expectTypeOf<
      Extract<ExtractionOutcome<{ value: number }>, { outcome: "result" }>
    >().toEqualTypeOf<ResultOutcome<{ value: number }>>();
  });

  test("Extract<ExtractionOutcome<F>, { outcome: 'error' }> is ErrorOutcome<F>", () => {
    expectTypeOf<
      Extract<ExtractionOutcome<{ value: number }>, { outcome: "error" }>
    >().toEqualTypeOf<ErrorOutcome<{ value: number }>>();
  });

  test("an inline object literal missing the tag is rejected", () => {
    // @ts-expect-error — the `outcome` tag is required, so only
    // resultOutcome()/errorOutcome() construct outcomes. A literal missing
    // `outcome` must not type-check; if this directive goes unused (TS2578)
    // the tag has been lost and the guarantee is gone.
    const _: ExtractionOutcome<{ value: number }> = {
      candidate: "a",
      result: makeResult({ value: 1 }),
    };
    void _;
  });
});
