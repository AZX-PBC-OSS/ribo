import { describe, expect, test } from "vitest";

import type { AnnotatedTranscript } from "../capture/annotated-transcript.js";
import { CancellationError } from "../async/cancellation.js";
import type { ExtractOptions, Extractor, ExtractionResult } from "./extractor.js";
import { retryExtractor } from "./retry-extractor.js";
import { TerminalError } from "../storage/backoff.js";
import { SchemaParseError } from "./schema-parse-error.js";

// The test runs in Vitest's node environment, but `ribo-core` is a browser library and
// does not include `@types/node`. Declaring `process` locally keeps the test scoped
// rather than widening the package's tsconfig for a single Node-specific assertion.
declare const process: {
  on: (event: "unhandledRejection", handler: (reason: unknown) => void) => void;
  off: (event: "unhandledRejection", handler: (reason: unknown) => void) => void;
};

type Fields = { value: number };

/**
 * A stub `Extractor` whose `extract` is backed by a scripted queue of outcomes.
 * `FakeExtractor` cannot serve here — it always resolves, so it can never produce a
 * second attempt. The stub records the options it was called with on every call, so a
 * test can assert the caller's `ExtractOptions` reached it on each attempt.
 */
function makeScriptedExtractor(script: readonly (Error | ExtractionResult<Fields>)[]) {
  const calls: (ExtractOptions | undefined)[] = [];
  let index = 0;
  const extractor: Extractor<Fields> = {
    extract(
      _transcript: AnnotatedTranscript,
      options?: ExtractOptions,
    ): Promise<ExtractionResult<Fields>> {
      calls.push(options);
      const outcome = script[index]!;
      index += 1;
      return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
    },
  };
  return { extractor, calls };
}

/** A `delay` double that records the milliseconds it was asked to wait and never waits. */
function makeRecordingDelay() {
  const delays: number[] = [];
  return { delays, delay: (ms: number): Promise<void> => (delays.push(ms), Promise.resolve()) };
}

function result(
  fields: Fields,
  calls: number,
  extra: { engine?: string } = {},
): ExtractionResult<Fields> {
  return { fields, usage: { calls, ...extra } };
}

const transcript: AnnotatedTranscript = { text: "the transcript", annotations: {} };

// Compile-time check that retryExtractor returns an Extractor for a concrete field type.
const _retryCheck: Extractor<Fields> = retryExtractor({
  extract: async () => result({ value: 1 }, 1),
});
void _retryCheck;

describe("retryExtractor", () => {
  test("a first-attempt success calls the inner extractor once and returns its result by identity", async () => {
    const accepted = result({ value: 1 }, 1);
    const { extractor, calls } = makeScriptedExtractor([accepted]);
    const composed = retryExtractor(extractor);

    const returned = await composed.extract(transcript);

    expect(calls).toHaveLength(1);
    expect(returned).toBe(accepted);
  });

  test("a transient failure followed by a success calls twice and returns the second attempt's fields", async () => {
    const { extractor, calls } = makeScriptedExtractor([
      new Error("flaky"),
      result({ value: 42 }, 1),
    ]);
    const composed = retryExtractor(extractor, { delay: () => Promise.resolve() });

    const returned = await composed.extract(transcript);

    expect(calls).toHaveLength(2);
    expect(returned.fields).toEqual({ value: 42 });
  });

  test("exhausting maxRetries rejects with the last error, not the first", async () => {
    const first = new Error("first");
    const second = new Error("second");
    const third = new Error("third");
    const { extractor } = makeScriptedExtractor([first, second, third]);
    const composed = retryExtractor(extractor, {
      maxRetries: 2,
      delay: () => Promise.resolve(),
    });

    await expect(composed.extract(transcript)).rejects.toBe(third);
  });

  test("a TerminalError rejects immediately after one call", async () => {
    const terminal = new TerminalError("deterministic failure");
    const { extractor, calls } = makeScriptedExtractor([terminal, result({ value: 1 }, 1)]);
    const composed = retryExtractor(extractor, { delay: () => Promise.resolve() });

    await expect(composed.extract(transcript)).rejects.toBe(terminal);
    expect(calls).toHaveLength(1);
  });

  test("a CancellationError rejects immediately after one call", async () => {
    const cancellation = new CancellationError("the caller stopped this");
    const { extractor, calls } = makeScriptedExtractor([cancellation, result({ value: 1 }, 1)]);
    const composed = retryExtractor(extractor, { delay: () => Promise.resolve() });

    await expect(composed.extract(transcript)).rejects.toBe(cancellation);
    expect(calls).toHaveLength(1);
  });

  test("a 400-status error rejects immediately after one call (isTransientFailure is false)", async () => {
    const badRequest = Object.assign(new Error("bad request"), { status: 400 });
    const { extractor, calls } = makeScriptedExtractor([badRequest, result({ value: 1 }, 1)]);
    const composed = retryExtractor(extractor, { delay: () => Promise.resolve() });

    await expect(composed.extract(transcript)).rejects.toBe(badRequest);
    expect(calls).toHaveLength(1);
  });

  test("a SchemaParseError is retried", async () => {
    const { extractor, calls } = makeScriptedExtractor([
      new SchemaParseError("the response violated the schema"),
      result({ value: 1 }, 1),
    ]);
    const composed = retryExtractor(extractor, { delay: () => Promise.resolve() });

    const returned = await composed.extract(transcript);

    expect(calls).toHaveLength(2);
    expect(returned.fields).toEqual({ value: 1 });
  });

  test("the delay function is called once per retry and never before the first attempt", async () => {
    const { extractor, calls } = makeScriptedExtractor([
      new Error("flaky once"),
      new Error("flaky twice"),
      result({ value: 7 }, 1),
    ]);
    const { delays, delay } = makeRecordingDelay();
    const composed = retryExtractor(extractor, { maxRetries: 2, delay });

    const returned = await composed.extract(transcript);

    expect(returned.fields).toEqual({ value: 7 });
    expect(calls).toHaveLength(3);
    expect(delays).toHaveLength(2);
  });

  test("a first-attempt success never delays", async () => {
    const { extractor } = makeScriptedExtractor([result({ value: 1 }, 1)]);
    const { delays, delay } = makeRecordingDelay();
    const composed = retryExtractor(extractor, { delay });

    await composed.extract(transcript);

    expect(delays).toHaveLength(0);
  });

  test("delay receives a number, not an exact value (fullJitterDelay is randomised)", async () => {
    const { extractor } = makeScriptedExtractor([new Error("flaky"), result({ value: 1 }, 1)]);
    const { delays, delay } = makeRecordingDelay();
    const composed = retryExtractor(extractor, { delay });

    await composed.extract(transcript);

    expect(typeof delays[0]).toBe("number");
  });

  test("an already-aborted signal rejects with a CancellationError without calling the inner extractor", async () => {
    const { extractor, calls } = makeScriptedExtractor([result({ value: 1 }, 1)]);
    const composed = retryExtractor(extractor);
    const controller = new AbortController();
    controller.abort();

    await expect(
      composed.extract(transcript, { signal: controller.signal }),
    ).rejects.toBeInstanceOf(CancellationError);
    expect(calls).toHaveLength(0);
  });

  test("the caller's ExtractOptions, signal included, reaches the stub on every attempt", async () => {
    const { extractor, calls } = makeScriptedExtractor([
      new Error("flaky once"),
      new Error("flaky twice"),
      result({ value: 1 }, 1),
    ]);
    const composed = retryExtractor(extractor, { maxRetries: 2, delay: () => Promise.resolve() });
    const controller = new AbortController();
    // `deadline` rides along as a regression pin: the forward is verbatim
    // (`toBe(options)` below already proves the whole bag is handed through),
    // so a new member reaches the stub on every attempt unmodified.
    const options: ExtractOptions = { signal: controller.signal, deadline: 1_234_567_890 };

    await composed.extract(transcript, options);

    expect(calls).toHaveLength(3);
    for (const recorded of calls) {
      expect(recorded).toBe(options);
      expect(recorded?.deadline).toBe(1_234_567_890);
    }
  });

  test("a first-attempt success returns the inner usage object by identity", async () => {
    const accepted = result({ value: 1 }, 4);
    const { extractor } = makeScriptedExtractor([accepted]);
    const composed = retryExtractor(extractor);

    const returned = await composed.extract(transcript);

    expect(returned.usage).toBe(accepted.usage);
  });

  test("a retried success returns the accepted attempt's result by identity, and undercounts usage.calls", async () => {
    // This pins a KNOWN LIMITATION, not a feature. A rejected attempt carries no
    // `ExtractionUsage`, so the wrapper has nothing to add and cannot report the calls
    // the failed attempts burned. Two calls were made here; the result says one.
    //
    // The identity assertion is what makes this test bind: an implementation that
    // rebuilt the result to "sum" across attempts would fail `toBe`, and such an
    // implementation is exactly what this file used to contain — summing that always
    // equalled the single resolving attempt's own count, so no value-based assertion
    // could ever have caught it.
    const accepted = result({ value: 1 }, 1, { engine: "test-engine" });
    const { extractor, calls } = makeScriptedExtractor([new Error("flaky once"), accepted]);
    const composed = retryExtractor(extractor, { maxRetries: 2, delay: () => Promise.resolve() });

    const returned = await composed.extract(transcript);

    expect(calls).toHaveLength(2);
    expect(returned).toBe(accepted);
    expect(returned.usage.calls).toBe(1);
    expect(returned.usage.engine).toBe("test-engine");
  });

  test("an unhandled rejection from the inner extractor never surfaces when the run rejects", async () => {
    const unhandled: unknown[] = [];
    const handler = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", handler);
    try {
      const { extractor } = makeScriptedExtractor([
        Object.assign(new Error("flaky"), { status: 503 }),
        Object.assign(new Error("flaky"), { status: 503 }),
        Object.assign(new Error("flaky"), { status: 503 }),
      ]);
      const composed = retryExtractor(extractor, {
        maxRetries: 2,
        delay: () => Promise.resolve(),
      });

      await expect(composed.extract(transcript)).rejects.toBeDefined();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", handler);
    }
  });
});
