import { describe, expect, test } from "vitest";

import { CancellationError } from "./cancellation.js";
import { retryAsync } from "./retry-async.js";
import { TerminalQueueError } from "./queue/backoff.js";
import { SchemaParseError } from "./schema-parse-error.js";

/**
 * A scripted `work` function: resolves or rejects from a queue of outcomes, recording
 * the attempt number of every call. The retry policy's behavioural assertions, ported
 * from `retry-extractor.test.ts`, drive this rather than an extractor — `retryAsync`
 * retries any async work whose `run` is not an `Extractor`, which is the whole reason
 * the policy was extracted.
 */
function makeScriptedWork(script: readonly (Error | string)[]) {
  const calls: number[] = [];
  let index = 0;
  const work = async (attempt: number): Promise<string> => {
    calls.push(attempt);
    const outcome = script[index]!;
    index += 1;
    return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
  };
  return { work, calls };
}

/** A `delay` double that records the milliseconds it was asked to wait and never waits. */
function makeRecordingDelay() {
  const delays: number[] = [];
  return { delays, delay: (ms: number): Promise<void> => (delays.push(ms), Promise.resolve()) };
}

/** The canonical transient failure: a 503 the way a transport reports one. */
function transient503(): Error {
  return Object.assign(new Error("service unavailable"), { status: 503 });
}

describe("retryAsync", () => {
  test("a first-attempt success calls work once, with attempt 1", async () => {
    const { work, calls } = makeScriptedWork(["ok"]);
    await expect(retryAsync(work)).resolves.toBe("ok");
    expect(calls).toEqual([1]);
  });

  test("a transient failure followed by a success calls twice and returns the second value", async () => {
    const { work, calls } = makeScriptedWork([transient503(), "second"]);
    const composed = retryAsync(work, { delay: () => Promise.resolve() });

    await expect(composed).resolves.toBe("second");
    expect(calls).toEqual([1, 2]);
  });

  test("exhausting maxRetries rejects with the last error, not the first", async () => {
    const first = new Error("first");
    const second = new Error("second");
    const third = new Error("third");
    const { work } = makeScriptedWork([first, second, third]);
    const composed = retryAsync(work, { maxRetries: 2, delay: () => Promise.resolve() });

    await expect(composed).rejects.toBe(third);
  });

  test("a TerminalQueueError rethrows immediately after one call", async () => {
    const terminal = new TerminalQueueError("deterministic failure");
    const { work, calls } = makeScriptedWork([terminal, "never"]);
    const composed = retryAsync(work, { delay: () => Promise.resolve() });

    await expect(composed).rejects.toBe(terminal);
    expect(calls).toEqual([1]);
  });

  test("a CancellationError rethrows immediately after one call", async () => {
    const cancellation = new CancellationError("the caller stopped this");
    const { work, calls } = makeScriptedWork([cancellation, "never"]);
    const composed = retryAsync(work, { delay: () => Promise.resolve() });

    await expect(composed).rejects.toBe(cancellation);
    expect(calls).toEqual([1]);
  });

  test("a 400-status error rethrows immediately after one call (isTransientFailure is false)", async () => {
    const badRequest = Object.assign(new Error("bad request"), { status: 400 });
    const { work, calls } = makeScriptedWork([badRequest, "never"]);
    const composed = retryAsync(work, { delay: () => Promise.resolve() });

    await expect(composed).rejects.toBe(badRequest);
    expect(calls).toEqual([1]);
  });

  test("a SchemaParseError is retried", async () => {
    const { work, calls } = makeScriptedWork([
      new SchemaParseError("the response violated the schema"),
      "second",
    ]);
    const composed = retryAsync(work, { delay: () => Promise.resolve() });

    await expect(composed).resolves.toBe("second");
    expect(calls).toEqual([1, 2]);
  });

  test("delay is called once per retry and never before the first attempt", async () => {
    const { work, calls } = makeScriptedWork([
      new Error("flaky once"),
      new Error("flaky twice"),
      "third",
    ]);
    const { delays, delay } = makeRecordingDelay();
    const composed = retryAsync(work, { maxRetries: 2, delay });

    await expect(composed).resolves.toBe("third");
    expect(calls).toEqual([1, 2, 3]);
    expect(delays).toHaveLength(2);
  });

  test("a first-attempt success never delays", async () => {
    const { work } = makeScriptedWork(["ok"]);
    const { delays, delay } = makeRecordingDelay();

    await retryAsync(work, { delay });

    expect(delays).toHaveLength(0);
  });

  test("delay receives a number, not an exact value (fullJitterDelay is randomised)", async () => {
    const { work } = makeScriptedWork([transient503(), "second"]);
    const { delays, delay } = makeRecordingDelay();

    await retryAsync(work, { delay });

    expect(typeof delays[0]).toBe("number");
  });

  test("an already-aborted signal throws a CancellationError with zero calls", async () => {
    const { work, calls } = makeScriptedWork(["never"]);
    const controller = new AbortController();
    controller.abort();

    await expect(retryAsync(work, { signal: controller.signal })).rejects.toBeInstanceOf(
      CancellationError,
    );
    expect(calls).toEqual([]);
  });

  test("onAttempt fires once per started attempt, receiving 1 for the first", async () => {
    const { work } = makeScriptedWork([transient503(), transient503(), "third"]);
    const attempts: number[] = [];
    const composed = retryAsync(work, {
      maxRetries: 2,
      delay: () => Promise.resolve(),
      onAttempt: (attempt) => attempts.push(attempt),
    });

    await composed;

    expect(attempts).toEqual([1, 2, 3]);
  });

  test("onAttempt does not fire for an attempt the pre-attempt abort check prevented", async () => {
    const boom = transient503();
    const { work, calls } = makeScriptedWork([boom]);
    const controller = new AbortController();
    const attempts: number[] = [];
    // The abort lands during the backoff sleep, so attempt 2 never starts. The
    // rejection is the previous attempt's error — the verbatim pre-attempt policy.
    const delay = async () => {
      controller.abort();
    };

    await expect(
      retryAsync(work, {
        maxRetries: 1,
        delay,
        signal: controller.signal,
        onAttempt: (attempt) => attempts.push(attempt),
      }),
    ).rejects.toBe(boom);
    expect(attempts).toEqual([1]);
    expect(calls).toEqual([1]);
  });

  test("an abort during the backoff sleep surfaces the previous attempt's error, not a CancellationError", async () => {
    // The divergence this whole extraction exists to pin. A transient failure, then the
    // signal aborts while the loop is asleep in its backoff, then the loop reaches its
    // pre-attempt check: the caller receives the 503 that actually happened — the
    // previous attempt's error — and NOT a fresh CancellationError. Paraphrasing the
    // pre-attempt block as "throw a CancellationError" fails exactly this test while
    // passing every other assertion in this file and every assertion in
    // `retry-extractor.test.ts`.
    const boom = transient503();
    const { work, calls } = makeScriptedWork([boom]);
    const controller = new AbortController();
    const delay = async () => {
      controller.abort();
    };

    await expect(
      retryAsync(work, { maxRetries: 1, delay, signal: controller.signal }),
    ).rejects.toBe(boom);
    expect(calls).toEqual([1]);
  });

  test("an already-aborted signal with a previous non-Error rejection still throws CancellationError", async () => {
    // The verbatim policy rethrows the previous attempt's error only when it is an
    // `Error` — a non-Error sentinel rejection must not be rethrown by the abort check;
    // a fresh CancellationError carries the news instead.
    const sentinel = "not an error";
    let index = 0;
    const calls: number[] = [];
    const controller = new AbortController();
    const delay = async () => {
      controller.abort();
    };
    const work = async (attempt: number): Promise<string> => {
      calls.push(attempt);
      index += 1;
      if (index === 1) throw sentinel;
      return "never";
    };

    await expect(
      retryAsync(work, { maxRetries: 1, delay, signal: controller.signal }),
    ).rejects.toBeInstanceOf(CancellationError);
    expect(calls).toEqual([1]);
  });
});
