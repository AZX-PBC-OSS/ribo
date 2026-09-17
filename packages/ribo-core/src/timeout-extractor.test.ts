import { describe, expect, test } from "vitest";

import type { AnnotatedTranscript } from "./annotated-transcript.js";
import { CancellationError, isCancellation } from "./cancellation.js";
import type { ExtractOptions, Extractor, ExtractionResult } from "./extractor.js";
import { ExtractionTimeoutError, timeoutExtractor } from "./timeout-extractor.js";
import type { ScheduleTimer } from "./connectivity.js";

// The test runs in Vitest's node environment, but `ribo-core` is a browser library and
// does not include `@types/node`. Declaring `process` locally keeps the test scoped
// rather than widening the package's tsconfig for a single Node-specific assertion.
declare const process: {
  on: (event: "unhandledRejection", handler: (reason: unknown) => void) => void;
  off: (event: "unhandledRejection", handler: (reason: unknown) => void) => void;
};

type Fields = { value: number };

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function makeDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * A hand-written pending stub: `extract` returns a promise that stays pending until the
 * test resolves or rejects it, and records the options it received. `FakeExtractor`
 * resolves immediately, so it can only serve the success-path case and cannot be held
 * pending while the timer fires.
 */
function makeHeldStub() {
  const received: (ExtractOptions | undefined)[] = [];
  let held: Deferred<ExtractionResult<Fields>> | undefined;
  const extractor: Extractor<Fields> = {
    extract(
      _transcript: AnnotatedTranscript,
      options?: ExtractOptions,
    ): Promise<ExtractionResult<Fields>> {
      received.push(options);
      held = makeDeferred<ExtractionResult<Fields>>();
      return held.promise;
    },
  };
  return {
    extractor,
    received,
    get held() {
      return held!;
    },
  };
}

/** A `scheduleTimer` double that captures the callback rather than scheduling it. */
function makeCapturedTimer() {
  let callback: (() => void) | undefined;
  let clearCalls = 0;
  const scheduleTimer: ScheduleTimer = (fn, _delayMs) => {
    callback = fn;
    return () => {
      clearCalls += 1;
    };
  };
  return {
    scheduleTimer,
    fire: () => callback?.(),
    get clearCalls() {
      return clearCalls;
    },
  };
}

function result(fields: Fields, calls = 1): ExtractionResult<Fields> {
  return { fields, usage: { calls } };
}

const transcript: AnnotatedTranscript = { text: "the transcript", annotations: {} };

function flushMacrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("timeoutExtractor", () => {
  test("an inner extractor that resolves before the timer fires returns its result unchanged and the clear function was called", async () => {
    const timer = makeCapturedTimer();
    const stub = makeHeldStub();
    const composed = timeoutExtractor(stub.extractor, {
      timeoutMs: 5_000,
      scheduleTimer: timer.scheduleTimer,
    });

    const pending = composed.extract(transcript);
    const accepted = result({ value: 9 });
    stub.held.resolve(accepted);
    const returned = await pending;

    expect(returned).toBe(accepted);
    expect(timer.clearCalls).toBe(1);
  });

  test("the clear function is also called when the inner rejects", async () => {
    const timer = makeCapturedTimer();
    const stub = makeHeldStub();
    const composed = timeoutExtractor(stub.extractor, {
      timeoutMs: 5_000,
      scheduleTimer: timer.scheduleTimer,
    });

    const pending = composed.extract(transcript);
    stub.held.reject(new Error("inner failed"));
    await expect(pending).rejects.toThrow("inner failed");
    expect(timer.clearCalls).toBe(1);
  });

  test("the clear function is also called when the timer fires", async () => {
    const timer = makeCapturedTimer();
    const stub = makeHeldStub();
    const composed = timeoutExtractor(stub.extractor, {
      timeoutMs: 5_000,
      scheduleTimer: timer.scheduleTimer,
    });

    const pending = composed.extract(transcript);
    timer.fire();
    await expect(pending).rejects.toBeInstanceOf(ExtractionTimeoutError);
    expect(timer.clearCalls).toBe(1);
  });

  test("firing the timer rejects with ExtractionTimeoutError whose message names the budget, even though the pending stub never settles", async () => {
    const timer = makeCapturedTimer();
    const stub = makeHeldStub();
    const composed = timeoutExtractor(stub.extractor, {
      timeoutMs: 1_234,
      scheduleTimer: timer.scheduleTimer,
    });

    const pending = composed.extract(transcript);
    timer.fire();

    // The stub's promise is still pending — an await-then-convert shape could not
    // reject here, which is exactly what this assertion distinguishes.
    const error = await pending.then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ExtractionTimeoutError);
    expect((error as ExtractionTimeoutError).message).toContain("1234");
  });

  test("when the timer fires, the signal the stub received is already aborted at the moment of rejection", async () => {
    const timer = makeCapturedTimer();
    const stub = makeHeldStub();
    const composed = timeoutExtractor(stub.extractor, {
      timeoutMs: 5_000,
      scheduleTimer: timer.scheduleTimer,
    });

    const pending = composed.extract(transcript);
    timer.fire();
    await expect(pending).rejects.toBeInstanceOf(ExtractionTimeoutError);

    const received = stub.received[0]!;
    expect(received.signal).toBeDefined();
    expect(received.signal?.aborted).toBe(true);
  });

  test("a stub that rejects with its own cancellation-branded error after the timer fired still surfaces as ExtractionTimeoutError", async () => {
    const timer = makeCapturedTimer();
    const stub = makeHeldStub();
    const composed = timeoutExtractor(stub.extractor, {
      timeoutMs: 5_000,
      scheduleTimer: timer.scheduleTimer,
    });

    const pending = composed.extract(transcript);
    timer.fire();
    const error = await pending.then(
      () => null,
      (caught: unknown) => caught,
    );
    // The deadline elapsed while the caller's signal is intact — a different event
    // from a caller cancellation, whatever the stub says later.
    stub.held.reject(new CancellationError("stub gave up"));
    await flushMacrotask();

    expect(error).toBeInstanceOf(ExtractionTimeoutError);
  });

  test("isCancellation(new ExtractionTimeoutError(...)) is false", () => {
    expect(isCancellation(new ExtractionTimeoutError(5_000))).toBe(false);
  });

  test("when the caller's signal aborts, the inner cancellation propagates unchanged rather than becoming a timeout", async () => {
    const timer = makeCapturedTimer();
    const stub = makeHeldStub();
    const composed = timeoutExtractor(stub.extractor, {
      timeoutMs: 5_000,
      scheduleTimer: timer.scheduleTimer,
    });
    const controller = new AbortController();

    const pending = composed.extract(transcript, { signal: controller.signal });
    controller.abort();
    const cancellation = new CancellationError("the caller stopped this");
    stub.held.reject(cancellation);

    await expect(pending).rejects.toBe(cancellation);
  });

  test("when the caller's signal aborts and the timer fires in the same tick, the caller's cancellation wins (abort first)", async () => {
    const timer = makeCapturedTimer();
    const stub = makeHeldStub();
    const composed = timeoutExtractor(stub.extractor, {
      timeoutMs: 5_000,
      scheduleTimer: timer.scheduleTimer,
    });
    const controller = new AbortController();

    const pending = composed.extract(transcript, { signal: controller.signal });
    controller.abort();
    timer.fire();

    const error = await pending.then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBe(controller.signal.reason);
    expect(error).not.toBeInstanceOf(ExtractionTimeoutError);
  });

  test("when the timer fires and the caller's signal aborts in the same tick, the caller's cancellation still wins (timer first)", async () => {
    const timer = makeCapturedTimer();
    const stub = makeHeldStub();
    const composed = timeoutExtractor(stub.extractor, {
      timeoutMs: 5_000,
      scheduleTimer: timer.scheduleTimer,
    });
    const controller = new AbortController();

    const pending = composed.extract(transcript, { signal: controller.signal });
    timer.fire();
    controller.abort();

    const error = await pending.then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBe(controller.signal.reason);
    expect(error).not.toBeInstanceOf(ExtractionTimeoutError);
  });

  test("no unhandled rejection is produced when the timer wins and the inner later rejects", async () => {
    const unhandled: unknown[] = [];
    const handler = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", handler);
    try {
      const timer = makeCapturedTimer();
      const stub = makeHeldStub();
      const composed = timeoutExtractor(stub.extractor, {
        timeoutMs: 5_000,
        scheduleTimer: timer.scheduleTimer,
      });

      const pending = composed.extract(transcript);
      timer.fire();
      await expect(pending).rejects.toBeInstanceOf(ExtractionTimeoutError);

      stub.held.reject(new Error("the abort landed late"));
      await flushMacrotask();
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", handler);
    }
  });

  test("a non-positive timeoutMs is rejected at construction, naming the value", () => {
    const stub = makeHeldStub();
    expect(() =>
      timeoutExtractor(stub.extractor, { timeoutMs: 0, scheduleTimer: () => () => {} }),
    ).toThrow(RangeError);
    expect(() =>
      timeoutExtractor(stub.extractor, { timeoutMs: 0, scheduleTimer: () => () => {} }),
    ).toThrow(/0/);
    expect(() =>
      timeoutExtractor(stub.extractor, { timeoutMs: -5, scheduleTimer: () => () => {} }),
    ).toThrow(/-5/);
  });
});
