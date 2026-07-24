import { describe, expect, test } from "vitest";

import {
  DEFAULT_BACKOFF_BASE_MS,
  DEFAULT_BACKOFF_CAP_MS,
  fullJitterDelay,
  isTransientFailure,
  TerminalQueueError,
} from "./backoff.js";

// Pure arithmetic and pure classification — no storage, no browser API. This is
// the one part of the queue that belongs in the `unit` project.

describe("fullJitterDelay", () => {
  test("is `min(cap, base * 2^attempts) * random()`, exactly as 09 specifies", () => {
    const options = { baseMs: 1000, capMs: 60_000, random: () => 1 };
    expect(fullJitterDelay(0, options)).toBe(1000);
    expect(fullJitterDelay(1, options)).toBe(2000);
    expect(fullJitterDelay(2, options)).toBe(4000);
    expect(fullJitterDelay(3, options)).toBe(8000);
  });

  test("jitters across the whole window, down to zero", () => {
    expect(fullJitterDelay(3, { baseMs: 1000, capMs: 60_000, random: () => 0 })).toBe(0);
    expect(fullJitterDelay(3, { baseMs: 1000, capMs: 60_000, random: () => 0.5 })).toBe(4000);
  });

  test("clamps the window at the cap", () => {
    const options = { baseMs: 1000, capMs: 5000, random: () => 1 };
    expect(fullJitterDelay(10, options)).toBe(5000);
    expect(fullJitterDelay(50, options)).toBe(5000);
  });

  test("stays finite for an absurd attempt count", () => {
    // 2 ** 2000 is Infinity, and Infinity * random() is NaN — a NaN delay would
    // produce an unparseable `nextAttemptAt` and wedge the item forever.
    const delay = fullJitterDelay(2000, { baseMs: 1000, capMs: 300_000, random: () => 1 });
    expect(delay).toBe(300_000);
  });

  test("rejects a negative attempt count rather than inventing a delay", () => {
    expect(() => fullJitterDelay(-1)).toThrow(/attempts/);
  });

  test("returns whole milliseconds", () => {
    const delay = fullJitterDelay(2, { baseMs: 1000, capMs: 60_000, random: () => 0.333333 });
    expect(Number.isInteger(delay)).toBe(true);
  });

  test("has sane defaults", () => {
    expect(DEFAULT_BACKOFF_BASE_MS).toBeGreaterThan(0);
    expect(DEFAULT_BACKOFF_CAP_MS).toBeGreaterThan(DEFAULT_BACKOFF_BASE_MS);
    const delay = fullJitterDelay(0, { random: () => 1 });
    expect(delay).toBe(DEFAULT_BACKOFF_BASE_MS);
  });
});

describe("isTransientFailure", () => {
  const withStatus = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

  test("treats 5xx as transient", () => {
    expect(isTransientFailure(withStatus(500))).toBe(true);
    expect(isTransientFailure(withStatus(502))).toBe(true);
    expect(isTransientFailure(withStatus(503))).toBe(true);
  });

  test("treats 4xx as terminal — a malformed request will not fix itself", () => {
    expect(isTransientFailure(withStatus(400))).toBe(false);
    expect(isTransientFailure(withStatus(401))).toBe(false);
    expect(isTransientFailure(withStatus(403))).toBe(false);
    expect(isTransientFailure(withStatus(404))).toBe(false);
    expect(isTransientFailure(withStatus(422))).toBe(false);
  });

  test("excepts 408 and 429, which are 4xx but explicitly retryable", () => {
    expect(isTransientFailure(withStatus(408))).toBe(true);
    expect(isTransientFailure(withStatus(429))).toBe(true);
  });

  test("reads `statusCode` too, because not every client spells it `status`", () => {
    expect(isTransientFailure(Object.assign(new Error("x"), { statusCode: 503 }))).toBe(true);
    expect(isTransientFailure(Object.assign(new Error("x"), { statusCode: 404 }))).toBe(false);
  });

  test("treats an unlabelled error as transient — a dropped connection is the common case", () => {
    // `fetch` rejects with a bare TypeError when the network is gone, which is
    // precisely the situation this queue exists for. Defaulting to `dead` would
    // kill every item captured in a basement.
    expect(isTransientFailure(new TypeError("Failed to fetch"))).toBe(true);
    expect(isTransientFailure(new Error("boom"))).toBe(true);
    expect(isTransientFailure("not even an error")).toBe(true);
  });

  test("honours an explicit TerminalQueueError whatever its status looks like", () => {
    expect(isTransientFailure(new TerminalQueueError("audio is gone"))).toBe(false);
    expect(isTransientFailure(Object.assign(new TerminalQueueError("nope"), { status: 503 }))).toBe(
      false,
    );
  });
});
