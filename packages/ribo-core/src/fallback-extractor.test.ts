import { describe, expect, test } from "vitest";

import type { Extractor, ExtractionResult } from "./extractor.js";
import { TerminalQueueError, isTransientFailure } from "./queue/backoff.js";
import { acceptAnySuccess, terminalFallsThrough } from "./arbitration.js";
import { fallbackExtractor } from "./fallback-extractor.js";

function makeExtractor<F>(
  id: string,
  fields: F,
  options: { calls?: number; engine?: string; throws?: unknown } = {},
): Extractor<F> & { calls: readonly string[] } {
  const calls: string[] = [];
  return {
    extract: async (transcript: string) => {
      calls.push(transcript);
      if (options.throws !== undefined) throw options.throws;
      return {
        fields,
        usage: { calls: options.calls ?? 1, engine: options.engine },
      } as ExtractionResult<F>;
    },
    get calls() {
      return calls;
    },
  };
}

// Compile-time check that fallbackExtractor returns an Extractor for a concrete field type.
const _fallbackCheck: Extractor<{ value: number }> = fallbackExtractor(
  [{ strategy: "x", extractor: makeExtractor("x", { value: 1 }) }],
  terminalFallsThrough,
);
void _fallbackCheck;

describe("fallbackExtractor", () => {
  test("a terminal error from the first candidate falls through to a successful second", async () => {
    const first = makeExtractor(
      "first",
      { value: 1 },
      {
        throws: new TerminalQueueError("truncated"),
      },
    );
    const second = makeExtractor("second", { value: 2 });
    const extractor = fallbackExtractor(
      [
        { strategy: "tier1", extractor: first },
        { strategy: "tier2", extractor: second },
      ],
      terminalFallsThrough,
    );

    const result = await extractor.extract("the transcript");

    expect(result.fields).toEqual({ value: 2 });
    expect(result.usage).toEqual({ calls: 1, strategy: "tier2" });
    expect(first.calls).toEqual(["the transcript"]);
    expect(second.calls).toEqual(["the transcript"]);
  });

  test("usage.strategy names the first candidate when it succeeds", async () => {
    const first = makeExtractor("first", { value: 1 });
    const second = makeExtractor("second", { value: 2 });
    const extractor = fallbackExtractor(
      [
        { strategy: "tier1", extractor: first },
        { strategy: "tier2", extractor: second },
      ],
      terminalFallsThrough,
    );

    const result = await extractor.extract("the transcript");

    expect(result.fields).toEqual({ value: 1 });
    expect(result.usage).toEqual({ calls: 1, strategy: "tier1" });
    expect(second.calls).toEqual([]);
  });

  test("usage.calls and usage.engine survive strategy stamping", async () => {
    const first = makeExtractor(
      "first",
      { value: 1 },
      {
        throws: new TerminalQueueError("truncated"),
      },
    );
    const second = makeExtractor("second", { value: 2 }, { calls: 7, engine: "managed" });
    const extractor = fallbackExtractor(
      [
        { strategy: "tier1", extractor: first },
        { strategy: "tier2", extractor: second },
      ],
      terminalFallsThrough,
    );

    const result = await extractor.extract("the transcript");

    expect(result.usage).toEqual({ calls: 7, engine: "managed", strategy: "tier2" });
  });

  test("giveUp propagates the arbiter's error unchanged", async () => {
    const sentinel = Object.assign(new Error("service unavailable"), { status: 503 });
    const extractor = fallbackExtractor(
      [{ strategy: "only", extractor: makeExtractor("only", { value: 1 }, { throws: sentinel }) }],
      terminalFallsThrough,
    );

    await expect(extractor.extract("the transcript")).rejects.toBe(sentinel);
    expect(isTransientFailure(sentinel)).toBe(true);
  });

  test("continue at exhaustion throws a TypeError naming the arbiter", async () => {
    const extractor = fallbackExtractor(
      [{ strategy: "only", extractor: makeExtractor("only", { value: 1 }) }],
      () => ({ continue: true }),
    );

    await expect(extractor.extract("the transcript")).rejects.toThrow(TypeError);
    await expect(extractor.extract("the transcript")).rejects.toThrow(/arbiter/);
  });

  test("accept with a synthesised result throws a TypeError", async () => {
    const extractor = fallbackExtractor(
      [{ strategy: "only", extractor: makeExtractor("only", { value: 1 }) }],
      (input) => {
        const outcome = input.outcomes[0];
        if (outcome === undefined || outcome.result === undefined) {
          throw new Error("unexpected error outcome");
        }
        return {
          accept: { ...outcome.result, usage: { calls: 99 } },
        };
      },
    );

    await expect(extractor.extract("the transcript")).rejects.toThrow(TypeError);
    await expect(extractor.extract("the transcript")).rejects.toThrow(/result/);
  });

  test("later candidates are not invoked once one is accepted", async () => {
    const first = makeExtractor("first", { value: 1 });
    const second = makeExtractor("second", { value: 2 });
    const extractor = fallbackExtractor(
      [
        { strategy: "tier1", extractor: first },
        { strategy: "tier2", extractor: second },
      ],
      acceptAnySuccess,
    );

    const result = await extractor.extract("the transcript");

    expect(result.fields).toEqual({ value: 1 });
    expect(first.calls).toEqual(["the transcript"]);
    expect(second.calls).toEqual([]);
  });

  test("duplicate strategy identifiers throw at construction", () => {
    expect(() =>
      fallbackExtractor(
        [
          { strategy: "same", extractor: makeExtractor("a", {}) },
          { strategy: "same", extractor: makeExtractor("b", {}) },
        ],
        terminalFallsThrough,
      ),
    ).toThrow(TypeError);

    expect(() =>
      fallbackExtractor(
        [
          { strategy: "same", extractor: makeExtractor("a", {}) },
          { strategy: "same", extractor: makeExtractor("b", {}) },
        ],
        terminalFallsThrough,
      ),
    ).toThrow(/same/);
  });

  test("an empty candidate list throws at construction", () => {
    expect(() => fallbackExtractor([], terminalFallsThrough)).toThrow(TypeError);
  });
});
