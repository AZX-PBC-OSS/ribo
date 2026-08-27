import { describe, expect, test } from "vitest";

import type { Extractor, ExtractionResult } from "./extractor.js";

// The test runs in Vitest's node environment, but `ribo-core` is a browser library and
// does not include `@types/node`. Declaring `process` locally keeps the test scoped
// rather than widening the package's tsconfig for a single Node-specific assertion.
declare const process: {
  on(event: "unhandledRejection", handler: (reason: unknown) => void): void;
  off(event: "unhandledRejection", handler: (reason: unknown) => void): void;
};
import {
  acceptAnySuccess,
  terminalFallsThrough,
  type ArbiterInput,
  type ExtractionArbiter,
} from "./arbitration.js";
import { raceExtractor } from "./race-extractor.js";

function makeExtractor<F>(
  id: string,
  fields: F,
  options: {
    calls?: number;
    engine?: string;
    throws?: unknown;
    extract?: (transcript: string) => Promise<ExtractionResult<F>>;
  } = {},
): Extractor<F> & { calls: readonly string[] } {
  const calls: string[] = [];
  return {
    // Avoid `async` so a caller-supplied deferred promise is returned directly, without an extra
    // async-function promise wrapping the resolution. That keeps the engine's `.then` handler on
    // the same promise the test resolves, so one microtask flush is enough to observe it.
    extract: (transcript: string) => {
      calls.push(transcript);
      if (options.extract) return options.extract(transcript);
      if (options.throws !== undefined) return Promise.reject(options.throws);
      return Promise.resolve({
        fields,
        usage: { calls: options.calls ?? 1, engine: options.engine },
      } as ExtractionResult<F>);
    },
    get calls() {
      return calls;
    },
  };
}

function makeDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve: (value: T) => void;
  let reject: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve: resolve!, reject: reject! };
}

/**
 * Yield to the event loop so every pending microtask (including the engine's
 * settlement handler and its subsequent `await wake.promise` continuation) runs
 * before the test asserts. A single `await Promise.resolve()` is not enough: the
 * wake continuation is queued by the settlement handler after the test's own yield
 * was already scheduled.
 */
async function yieldToEventLoop(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// Compile-time check that raceExtractor returns an Extractor for a concrete field type.
const _raceCheck: Extractor<{ value: number }> = raceExtractor(
  [{ strategy: "x", extractor: makeExtractor("x", { value: 1 }) }],
  terminalFallsThrough,
);
void _raceCheck;

describe("raceExtractor", () => {
  test("a rejected loser after an early accept does not surface as an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const handler = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", handler);
    try {
      const loserDeferred = makeDeferred<ExtractionResult<{ value: number }>>();
      const loser = makeExtractor(
        "loser",
        { value: 1 },
        {
          extract: async () => loserDeferred.promise,
        },
      );
      const winner = makeExtractor("winner", { value: 2 });
      const extractor = raceExtractor(
        [
          { strategy: "slow", extractor: loser },
          { strategy: "fast", extractor: winner },
        ],
        acceptAnySuccess,
      );

      const result = await extractor.extract("the transcript");

      expect(result.fields).toEqual({ value: 2 });
      expect(result.usage).toEqual({ calls: 1, strategy: "fast" });
      expect(loser.calls).toEqual(["the transcript"]);
      expect(winner.calls).toEqual(["the transcript"]);

      // The slow candidate rejects *after* the fast one has already won. The
      // engine must have attached a rejection handler to the slow promise, or
      // this surfaces as an unhandled rejection and the test fails on the
      // assertion below.
      loserDeferred.reject(new Error("slow lost"));

      // Give Node's unhandled-rejection check a turn to fire if the handler is
      // missing. A bare microtask flush is not enough; the event is emitted on
      // the next macrotick.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", handler);
    }
  });

  test("an arbiter that accepts the first landed outcome returns before the slower candidate settles", async () => {
    const slowDeferred = makeDeferred<ExtractionResult<{ value: number }>>();
    const slow = makeExtractor(
      "slow",
      { value: 1 },
      {
        extract: async () => slowDeferred.promise,
      },
    );
    const fast = makeExtractor("fast", { value: 2 });
    const extractor = raceExtractor(
      [
        { strategy: "slow", extractor: slow },
        { strategy: "fast", extractor: fast },
      ],
      acceptAnySuccess,
    );

    const result = await extractor.extract("the transcript");

    expect(result.fields).toEqual({ value: 2 });
    expect(result.usage).toEqual({ calls: 1, strategy: "fast" });
    // Extraction returned before the slow candidate ever settled.
  });

  test("outcomes accumulate in settlement order, not dispatch order", async () => {
    const seenInputs: Array<{
      outcomes: ArbiterInput<{ value: number }>["outcomes"];
      exhausted: boolean;
    }> = [];
    const arbiter: ExtractionArbiter<{ value: number }> = (input) => {
      // Snapshot the input so later pushes do not mutate what we observed.
      seenInputs.push({ outcomes: [...input.outcomes], exhausted: input.exhausted });
      return { continue: true };
    };

    const slowDeferred = makeDeferred<ExtractionResult<{ value: number }>>();
    const slow = makeExtractor(
      "slow",
      { value: 1 },
      {
        extract: async () => slowDeferred.promise,
      },
    );
    const fastDeferred = makeDeferred<ExtractionResult<{ value: number }>>();
    const fast = makeExtractor(
      "fast",
      { value: 2 },
      {
        extract: async () => fastDeferred.promise,
      },
    );
    const extractor = raceExtractor(
      [
        { strategy: "slow", extractor: slow },
        { strategy: "fast", extractor: fast },
      ],
      arbiter,
    );

    const extractPromise = extractor.extract("the transcript");
    // The arbiter always returns `continue`, so the extraction will eventually
    // reject with a TypeError at exhaustion. Attach a handler now so that waiting
    // for intermediate states is not reported as an unhandled rejection.
    extractPromise.catch(() => {});

    // Fast settles first even though it was dispatched second.
    fastDeferred.resolve({ fields: { value: 2 }, usage: { calls: 1 } });
    await yieldToEventLoop();
    expect(seenInputs).toHaveLength(1);
    expect(seenInputs[0]!.outcomes[0]!.candidate).toBe("fast");
    expect(seenInputs[0]!.exhausted).toBe(false);

    slowDeferred.resolve({ fields: { value: 1 }, usage: { calls: 1 } });
    await yieldToEventLoop();
    expect(seenInputs).toHaveLength(2);
    expect(seenInputs[1]!.outcomes[0]!.candidate).toBe("fast");
    expect(seenInputs[1]!.outcomes[1]!.candidate).toBe("slow");
    expect(seenInputs[1]!.exhausted).toBe(true);

    // The arbiter never accepted, so exhaustion throws.
    await expect(extractPromise).rejects.toThrow(TypeError);
  });

  test("exhausted is false while any candidate is in flight and true once all have settled", async () => {
    const exhaustedFlags: boolean[] = [];
    const arbiter: ExtractionArbiter<{ value: number }> = (input) => {
      exhaustedFlags.push(input.exhausted);
      return { continue: true };
    };

    const slowDeferred = makeDeferred<ExtractionResult<{ value: number }>>();
    const slow = makeExtractor(
      "slow",
      { value: 1 },
      {
        extract: async () => slowDeferred.promise,
      },
    );
    const fast = makeExtractor("fast", { value: 2 });
    const extractor = raceExtractor(
      [
        { strategy: "slow", extractor: slow },
        { strategy: "fast", extractor: fast },
      ],
      arbiter,
    );

    const extractPromise = extractor.extract("the transcript");
    // The arbiter always returns `continue`; silence the eventual exhaustion TypeError
    // so intermediate `exhausted` values can be observed without unhandled rejection noise.
    extractPromise.catch(() => {});

    await yieldToEventLoop();
    expect(exhaustedFlags).toEqual([false]);

    slowDeferred.resolve({ fields: { value: 1 }, usage: { calls: 1 } });
    await yieldToEventLoop();
    expect(exhaustedFlags).toEqual([false, true]);

    await expect(extractPromise).rejects.toThrow(TypeError);
  });

  test("usage.strategy names the accepted candidate, not the first-started one", async () => {
    const slowDeferred = makeDeferred<ExtractionResult<{ value: number }>>();
    const slow = makeExtractor(
      "slow",
      { value: 1 },
      {
        extract: async () => slowDeferred.promise,
      },
    );
    const fast = makeExtractor("fast", { value: 2 });
    const extractor = raceExtractor(
      [
        { strategy: "slow", extractor: slow },
        { strategy: "fast", extractor: fast },
      ],
      acceptAnySuccess,
    );

    const result = await extractor.extract("the transcript");

    expect(result.fields).toEqual({ value: 2 });
    expect(result.usage).toEqual({ calls: 1, strategy: "fast" });
  });

  test("duplicate strategy identifiers throw at construction", () => {
    expect(() =>
      raceExtractor(
        [
          { strategy: "same", extractor: makeExtractor("a", {}) },
          { strategy: "same", extractor: makeExtractor("b", {}) },
        ],
        acceptAnySuccess,
      ),
    ).toThrow(TypeError);

    expect(() =>
      raceExtractor(
        [
          { strategy: "same", extractor: makeExtractor("a", {}) },
          { strategy: "same", extractor: makeExtractor("b", {}) },
        ],
        acceptAnySuccess,
      ),
    ).toThrow(/same/);
  });

  test("an empty candidate list throws at construction", () => {
    expect(() => raceExtractor([], acceptAnySuccess)).toThrow(TypeError);
  });
});
