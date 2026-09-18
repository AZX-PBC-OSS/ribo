import { describe, expect, test } from "vitest";

import type { AnnotatedTranscript } from "./annotated-transcript.js";
import { CancellationError, isCancellation } from "./cancellation.js";
import type { ScheduleTimer } from "./connectivity.js";
import type { ExtractOptions, Extractor, ExtractionResult } from "./extractor.js";
import { hedgedExtractor } from "./hedged-extractor.js";
import type { ExtractionHedgeEvent } from "./hedged-extractor.js";

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
 * test resolves or rejects it, and records the options it received — the signal among
 * them, so a test can assert a lane was actually aborted rather than merely discarded.
 * `FakeExtractor` resolves immediately, so it can neither be held pending while the
 * timer fires nor record what it was handed.
 */
function makeHeldStub() {
  const received: (ExtractOptions | undefined)[] = [];
  let held: Deferred<ExtractionResult<Fields>> | undefined;
  let calls = 0;
  const extractor: Extractor<Fields> = {
    extract(
      _transcript: AnnotatedTranscript,
      options?: ExtractOptions,
    ): Promise<ExtractionResult<Fields>> {
      calls += 1;
      received.push(options);
      held = makeDeferred<ExtractionResult<Fields>>();
      return held.promise;
    },
  };
  return {
    extractor,
    received,
    get calls() {
      return calls;
    },
    get held() {
      return held!;
    },
  };
}

/** A `scheduleTimer` double that captures the callback rather than scheduling it. */
function makeCapturedTimer() {
  let callback: (() => void) | undefined;
  let clearCalls = 0;
  let firedCount = 0;
  const delays: number[] = [];
  const scheduleTimer: ScheduleTimer = (fn, delayMs) => {
    callback = fn;
    delays.push(delayMs);
    return () => {
      clearCalls += 1;
    };
  };
  return {
    scheduleTimer,
    fire: () => {
      if (callback === undefined) return;
      firedCount += 1;
      callback();
    },
    get clearCalls() {
      return clearCalls;
    },
    /** The delay every scheduling asked for, in call order. */
    get delays() {
      return delays;
    },
    get firedCount() {
      return firedCount;
    },
  };
}

function result(
  fields: Fields,
  usage: ExtractionResult<Fields>["usage"],
): ExtractionResult<Fields> {
  return { fields, usage };
}

const transcript: AnnotatedTranscript = { text: "the transcript", annotations: {} };

function flushMacrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// Yield microtasks until `predicate` is true. NOT a sleep — `await
// Promise.resolve()` only drains the microtask queue, never the event loop.
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !predicate(); i++) {
    await Promise.resolve();
  }
}

describe("hedgedExtractor", () => {
  test("rule 1 — the primary settles before the timer: its result is returned and the hedge is never invoked", async () => {
    const timer = makeCapturedTimer();
    const primary = makeHeldStub();
    const hedge = makeHeldStub();
    const composed = hedgedExtractor(primary.extractor, hedge.extractor, {
      delay: 5_000,
      scheduleTimer: timer.scheduleTimer,
    });

    const pending = composed.extract(transcript);
    // Dispatch is synchronous, so this already holds before any settling.
    expect(hedge.calls).toBe(0);
    const accepted = result({ value: 9 }, { calls: 1 });
    primary.held.resolve(accepted);
    const returned = await pending;

    expect(returned).toBe(accepted);
    // The case the combinator exists for: the hedge was never called at all.
    expect(hedge.calls).toBe(0);
  });

  test("rule 2 — the timer fires, the primary settles first: the primary's result is returned and the hedge's signal is aborted", async () => {
    const timer = makeCapturedTimer();
    const primary = makeHeldStub();
    const hedge = makeHeldStub();
    const composed = hedgedExtractor(primary.extractor, hedge.extractor, {
      delay: 5_000,
      scheduleTimer: timer.scheduleTimer,
    });

    const pending = composed.extract(transcript);
    timer.fire();
    await waitFor(() => hedge.calls === 1);
    const accepted = result({ value: 9 }, { calls: 1 });
    primary.held.resolve(accepted);
    const returned = await pending;

    expect(returned).toBe(accepted);
    expect(timer.firedCount).toBe(1);
    // The loser is cancelled, not merely discarded.
    expect(hedge.received[0]!.signal?.aborted).toBe(true);
  });

  test("rule 3 — the timer fires, the hedge settles first: the hedge's result is returned and the primary's signal is aborted", async () => {
    const timer = makeCapturedTimer();
    const primary = makeHeldStub();
    const hedge = makeHeldStub();
    const composed = hedgedExtractor(primary.extractor, hedge.extractor, {
      delay: 5_000,
      scheduleTimer: timer.scheduleTimer,
    });

    const pending = composed.extract(transcript);
    timer.fire();
    await waitFor(() => hedge.calls === 1);
    const accepted = result({ value: 7 }, { calls: 2 });
    hedge.held.resolve(accepted);
    const returned = await pending;

    expect(returned).toBe(accepted);
    expect(primary.received[0]!.signal?.aborted).toBe(true);
  });

  test("rule 4 — both lanes have already settled when the race runs: the primary wins, deterministically", async () => {
    const timer = makeCapturedTimer();
    const primary = makeHeldStub();
    const hedge = makeHeldStub();
    const composed = hedgedExtractor(primary.extractor, hedge.extractor, {
      delay: 5_000,
      scheduleTimer: timer.scheduleTimer,
    });

    const pending = composed.extract(transcript);
    timer.fire();
    await waitFor(() => hedge.calls === 1);
    const primaryResult = result({ value: 9 }, { calls: 1 });
    const hedgeResult = result({ value: 7 }, { calls: 2 });
    primary.held.resolve(primaryResult);
    hedge.held.resolve(hedgeResult);
    const returned = await pending;

    // Deterministic, not principled: the primary wins because the caller named it
    // first. `hedged` breaks this tie on privacy — audio not leaving the device —
    // and nothing analogous applies here, so the pin is the outcome alone.
    expect(returned).toBe(primaryResult);
    expect(returned).not.toBe(hedgeResult);
  });

  test("rule 5 — a non-cancellation primary rejection before the timer dispatches the hedge immediately, without waiting for the timer", async () => {
    const timer = makeCapturedTimer();
    const primary = makeHeldStub();
    const hedge = makeHeldStub();
    const composed = hedgedExtractor(primary.extractor, hedge.extractor, {
      delay: 5_000,
      scheduleTimer: timer.scheduleTimer,
    });

    const pending = composed.extract(transcript);
    primary.held.reject(new Error("primary failed"));
    await waitFor(() => hedge.calls === 1);

    // The hedge ran while the timer was still outstanding — no delay was waited
    // out. The timer was scheduled (the delay was asked for) but never fired.
    expect(timer.firedCount).toBe(0);
    expect(timer.delays).toEqual([5_000]);

    const accepted = result({ value: 7 }, { calls: 2 });
    hedge.held.resolve(accepted);
    const returned = await pending;
    expect(returned).toBe(accepted);
  });

  test("rule 6 — the primary rejects after the hedge succeeded: the hedge's result stands", async () => {
    const timer = makeCapturedTimer();
    const primary = makeHeldStub();
    const hedge = makeHeldStub();
    const composed = hedgedExtractor(primary.extractor, hedge.extractor, {
      delay: 5_000,
      scheduleTimer: timer.scheduleTimer,
    });

    const pending = composed.extract(transcript);
    timer.fire();
    await waitFor(() => hedge.calls === 1);
    const hedgeResult = result({ value: 7 }, { calls: 2 });
    hedge.held.resolve(hedgeResult);
    const returned = await pending;

    // The primary's ordinary rejection lands after the run settled; it changes
    // nothing and surfaces nowhere.
    primary.held.reject(new Error("too late"));
    await flushMacrotask();

    expect(returned).toBe(hedgeResult);
  });

  test("rule 7 — both lanes reject: the primary's error propagates, by identity", async () => {
    const timer = makeCapturedTimer();
    const primary = makeHeldStub();
    const hedge = makeHeldStub();
    const composed = hedgedExtractor(primary.extractor, hedge.extractor, {
      delay: 5_000,
      scheduleTimer: timer.scheduleTimer,
    });

    const pending = composed.extract(transcript);
    timer.fire();
    await waitFor(() => hedge.calls === 1);
    const primaryError = new Error("the primary's failure");
    primary.held.reject(primaryError);
    hedge.held.reject(new Error("the hedge's failure"));

    const error = await pending.then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBe(primaryError);
  });

  test("rule 0 — a caller abort that arrives as the primary's rejection is a cancellation, not a hedge trigger", async () => {
    const timer = makeCapturedTimer();
    const primary = makeHeldStub();
    const hedge = makeHeldStub();
    const composed = hedgedExtractor(primary.extractor, hedge.extractor, {
      delay: 5_000,
      scheduleTimer: timer.scheduleTimer,
    });
    const controller = new AbortController();

    const pending = composed.extract(transcript, { signal: controller.signal });
    controller.abort();
    const inner = new Error("the primary's abort artifact");
    primary.held.reject(inner);

    const error = await pending.then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(isCancellation(error, controller.signal)).toBe(true);
    // The caller's own abort reason is the honest error — the primary's inner
    // error never surfaced (timeout-extractor's precedence).
    expect(error).toBe(controller.signal.reason);
    expect(error).not.toBe(inner);
    // No hedge was dispatched into an already-aborted signal.
    expect(hedge.calls).toBe(0);
  });

  test("rule 0 — the primary's own cancellation with the caller's signal intact propagates untouched, and no hedge is dispatched", async () => {
    const timer = makeCapturedTimer();
    const primary = makeHeldStub();
    const hedge = makeHeldStub();
    const composed = hedgedExtractor(primary.extractor, hedge.extractor, {
      delay: 5_000,
      scheduleTimer: timer.scheduleTimer,
    });

    const pending = composed.extract(transcript);
    const cancellation = new CancellationError("the primary gave up");
    primary.held.reject(cancellation);

    const error = await pending.then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toBe(cancellation);
    expect(hedge.calls).toBe(0);
  });

  test("no unhandled rejection when the hedge, cancelled as the loser, rejects late (rule 2)", async () => {
    const unhandled: unknown[] = [];
    const handler = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", handler);
    try {
      const timer = makeCapturedTimer();
      const primary = makeHeldStub();
      const hedge = makeHeldStub();
      const composed = hedgedExtractor(primary.extractor, hedge.extractor, {
        delay: 5_000,
        scheduleTimer: timer.scheduleTimer,
      });

      const pending = composed.extract(transcript);
      timer.fire();
      await waitFor(() => hedge.calls === 1);
      primary.held.resolve(result({ value: 9 }, { calls: 1 }));
      await pending;

      hedge.held.reject(new Error("the hedge's abort landed late"));
      await flushMacrotask();
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", handler);
    }
  });

  test("no unhandled rejection when the primary, cancelled as the loser, rejects late (rule 3) — and it never un-does a successful run", async () => {
    const unhandled: unknown[] = [];
    const handler = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", handler);
    try {
      const timer = makeCapturedTimer();
      const primary = makeHeldStub();
      const hedge = makeHeldStub();
      const composed = hedgedExtractor(primary.extractor, hedge.extractor, {
        delay: 5_000,
        scheduleTimer: timer.scheduleTimer,
      });

      const pending = composed.extract(transcript);
      timer.fire();
      await waitFor(() => hedge.calls === 1);
      const hedgeResult = result({ value: 7 }, { calls: 2 });
      hedge.held.resolve(hedgeResult);
      const returned = await pending;

      // A loser rejection named AbortError would read as a cancellation even with
      // the caller's signal intact — it must be reaped, never surfaced.
      const abortLike = new Error("the primary's abort landed late");
      abortLike.name = "AbortError";
      primary.held.reject(abortLike);
      await flushMacrotask();

      expect(returned).toBe(hedgeResult);
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", handler);
    }
  });
});

describe("hedgedExtractor — the effective deadline", () => {
  const BASE = 1_000_000;

  /** A frozen injectable clock: `now` reads it, `advance` moves it by hand. */
  function makeClock() {
    let now = BASE;
    return {
      now: (): number => now,
      advance: (ms: number): void => {
        now += ms;
      },
      get nowMs() {
        return now;
      },
    };
  }

  test("an inherited deadline already in the past rejects immediately, without calling either lane and without scheduling a timer", async () => {
    const clock = makeClock();
    const timer = makeCapturedTimer();
    const primary = makeHeldStub();
    const hedge = makeHeldStub();
    const composed = hedgedExtractor(primary.extractor, hedge.extractor, {
      delay: 5_000,
      scheduleTimer: timer.scheduleTimer,
      now: clock.now,
    });

    const error = await composed.extract(transcript, { deadline: BASE - 1 }).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/deadline/);
    expect(primary.calls).toBe(0);
    expect(hedge.calls).toBe(0);
    expect(timer.delays).toEqual([]);
  });

  test("both lanes receive the effective deadline — the inherited one, forwarded, not stripped", async () => {
    const clock = makeClock();
    const timer = makeCapturedTimer();
    const primary = makeHeldStub();
    const hedge = makeHeldStub();
    const composed = hedgedExtractor(primary.extractor, hedge.extractor, {
      delay: 5_000,
      scheduleTimer: timer.scheduleTimer,
      now: clock.now,
    });
    const deadline = BASE + 60_000;

    const pending = composed.extract(transcript, { deadline });
    timer.fire();
    await waitFor(() => hedge.calls === 1);

    expect(primary.received[0]!.deadline).toBe(deadline);
    expect(hedge.received[0]!.deadline).toBe(deadline);

    hedge.held.resolve(result({ value: 7 }, { calls: 2 }));
    await pending;
  });

  test("a hedge whose delay would fire past the effective deadline is never dispatched — no timer, no lane, no event", async () => {
    const clock = makeClock();
    const timer = makeCapturedTimer();
    const primary = makeHeldStub();
    const hedge = makeHeldStub();
    const events: ExtractionHedgeEvent[] = [];
    const composed = hedgedExtractor(primary.extractor, hedge.extractor, {
      delay: 5_000,
      scheduleTimer: timer.scheduleTimer,
      now: clock.now,
      onHedge: (event) => events.push(event),
    });

    // The delay would fire the hedge at BASE + 5_000, long past the deadline.
    const pending = composed.extract(transcript, { deadline: BASE + 100 });
    await flushMacrotask();

    expect(timer.delays).toEqual([]);
    expect(hedge.calls).toBe(0);

    // The primary still runs to settlement — the deadline is advisory to the
    // lanes — and the run returns its result with no hedge event.
    const accepted = result({ value: 9 }, { calls: 1 });
    primary.held.resolve(accepted);
    const returned = await pending;
    expect(returned).toBe(accepted);
    expect(events).toEqual([]);
  });

  test("a primary rejection with the hedge's delay past the deadline still dispatches the hedge immediately — the dispatch is not past the deadline", async () => {
    // The deadline gates the TIMER path: a hedge dispatched at its fire time
    // would land past the wall, so no timer is scheduled. Rule 5's failover is
    // different — the primary has already failed, the delay's purpose (do not
    // bill two while the primary looks slow) is moot, and the dispatch happens
    // now, before the deadline, where the call can still finish in time.
    const clock = makeClock();
    const timer = makeCapturedTimer();
    const primary = makeHeldStub();
    const hedge = makeHeldStub();
    const composed = hedgedExtractor(primary.extractor, hedge.extractor, {
      delay: 5_000,
      scheduleTimer: timer.scheduleTimer,
      now: clock.now,
    });

    const pending = composed.extract(transcript, { deadline: BASE + 100 });
    primary.held.reject(new Error("primary failed"));
    await waitFor(() => hedge.calls === 1);

    expect(hedge.calls).toBe(1);
    expect(timer.delays).toEqual([]);

    const accepted = result({ value: 7 }, { calls: 2 });
    hedge.held.resolve(accepted);
    const returned = await pending;
    expect(returned).toBe(accepted);
  });
});

describe("hedgedExtractor — onHedge", () => {
  test("fires once, at settlement, naming the primary as the winner when the timer fired and the primary won (rule 2)", async () => {
    const timer = makeCapturedTimer();
    const primary = makeHeldStub();
    const hedge = makeHeldStub();
    const events: ExtractionHedgeEvent[] = [];
    const composed = hedgedExtractor(primary.extractor, hedge.extractor, {
      delay: 5_000,
      scheduleTimer: timer.scheduleTimer,
      onHedge: (event) => events.push(event),
    });

    const pending = composed.extract(transcript);
    timer.fire();
    await waitFor(() => hedge.calls === 1);
    primary.held.resolve(result({ value: 9 }, { calls: 1 }));
    await pending;

    expect(events).toEqual([{ winner: "primary" }]);
  });

  test("names the hedge as the winner when the hedge won (rule 3)", async () => {
    const timer = makeCapturedTimer();
    const primary = makeHeldStub();
    const hedge = makeHeldStub();
    const events: ExtractionHedgeEvent[] = [];
    const composed = hedgedExtractor(primary.extractor, hedge.extractor, {
      delay: 5_000,
      scheduleTimer: timer.scheduleTimer,
      onHedge: (event) => events.push(event),
    });

    const pending = composed.extract(transcript);
    timer.fire();
    await waitFor(() => hedge.calls === 1);
    hedge.held.resolve(result({ value: 7 }, { calls: 2 }));
    await pending;

    expect(events).toEqual([{ winner: "hedge" }]);
  });

  test("carries no winner when both lanes failed", async () => {
    const timer = makeCapturedTimer();
    const primary = makeHeldStub();
    const hedge = makeHeldStub();
    const events: ExtractionHedgeEvent[] = [];
    const composed = hedgedExtractor(primary.extractor, hedge.extractor, {
      delay: 5_000,
      scheduleTimer: timer.scheduleTimer,
      onHedge: (event) => events.push(event),
    });

    const pending = composed.extract(transcript);
    timer.fire();
    await waitFor(() => hedge.calls === 1);
    primary.held.reject(new Error("the primary's failure"));
    hedge.held.reject(new Error("the hedge's failure"));
    await pending.then(
      () => null,
      () => undefined,
    );

    expect(events).toEqual([{ winner: undefined }]);
  });

  test("does not fire when the primary won before the timer (rule 1)", async () => {
    const timer = makeCapturedTimer();
    const primary = makeHeldStub();
    const hedge = makeHeldStub();
    const events: ExtractionHedgeEvent[] = [];
    const composed = hedgedExtractor(primary.extractor, hedge.extractor, {
      delay: 5_000,
      scheduleTimer: timer.scheduleTimer,
      onHedge: (event) => events.push(event),
    });

    const pending = composed.extract(transcript);
    primary.held.resolve(result({ value: 9 }, { calls: 1 }));
    await pending;

    expect(events).toEqual([]);
  });

  test("a throwing handler does not fail the run", async () => {
    const timer = makeCapturedTimer();
    const primary = makeHeldStub();
    const hedge = makeHeldStub();
    const composed = hedgedExtractor(primary.extractor, hedge.extractor, {
      delay: 5_000,
      scheduleTimer: timer.scheduleTimer,
      onHedge: () => {
        throw new Error("the handler blew up");
      },
    });

    const pending = composed.extract(transcript);
    timer.fire();
    await waitFor(() => hedge.calls === 1);
    const accepted = result({ value: 9 }, { calls: 1 });
    primary.held.resolve(accepted);
    const returned = await pending;

    expect(returned).toBe(accepted);
  });
});

describe("hedgedExtractor — usage", () => {
  test("the winner's usage is returned — the hedge's, with no strategy stamped", async () => {
    const timer = makeCapturedTimer();
    const primary = makeHeldStub();
    const hedge = makeHeldStub();
    const composed = hedgedExtractor(primary.extractor, hedge.extractor, {
      delay: 5_000,
      scheduleTimer: timer.scheduleTimer,
    });

    const pending = composed.extract(transcript);
    timer.fire();
    await waitFor(() => hedge.calls === 1);
    const accepted = result({ value: 7 }, { calls: 2, promptTokens: 30, engine: "hedge-engine" });
    hedge.held.resolve(accepted);
    const returned = await pending;

    expect(returned).toBe(accepted);
    expect(returned.usage).toEqual({ calls: 2, promptTokens: 30, engine: "hedge-engine" });
    // No ids to stamp with: this combinator takes two bare extractors.
    expect("strategy" in returned.usage).toBe(false);
  });

  test("the loser's usage is not added — the primary's usage is the run's, not the sum", async () => {
    const timer = makeCapturedTimer();
    const primary = makeHeldStub();
    const hedge = makeHeldStub();
    const composed = hedgedExtractor(primary.extractor, hedge.extractor, {
      delay: 5_000,
      scheduleTimer: timer.scheduleTimer,
    });

    const pending = composed.extract(transcript);
    timer.fire();
    await waitFor(() => hedge.calls === 1);
    const accepted = result({ value: 9 }, { calls: 1, promptTokens: 10 });
    primary.held.resolve(accepted);
    const returned = await pending;

    // The hedge ran and was cancelled; its usage describes nothing that was
    // returned. The true cost of hedging is counted by `onHedge` fires.
    expect(returned).toBe(accepted);
    expect(returned.usage).toEqual({ calls: 1, promptTokens: 10 });
  });
});
