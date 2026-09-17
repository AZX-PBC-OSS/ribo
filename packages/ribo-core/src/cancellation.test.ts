import { describe, expect, test } from "vitest";

import { CANCELLATION, CancellationError, isCancellation } from "./cancellation.js";
import type { CancellationBranded } from "./cancellation.js";

describe("isCancellation", () => {
  test("a CancellationError is a cancellation", () => {
    expect(isCancellation(new CancellationError("the caller stopped this"))).toBe(true);
  });

  test("a plain Error is not", () => {
    expect(isCancellation(new Error("boom"))).toBe(false);
  });

  test("a foreign error carrying a truthy own [CANCELLATION] is a cancellation", () => {
    // The foreign-error case: construct a plain Error and assign the branded
    // property — what ChatError's `aborted` factory does in another package,
    // where core cannot see the class and the class cannot extend a core type.
    const error = new Error("transport gave up");
    (error as Error & CancellationBranded)[CANCELLATION] = true;
    expect(isCancellation(error)).toBe(true);
  });

  test("an own [CANCELLATION] property holding undefined is not a cancellation", () => {
    // `useDefineForClassFields` puts an own `[CANCELLATION]: undefined` on every
    // instance of a class that merely declares the field — presence is not the
    // test, truthiness is.
    const error = new Error("declared but never branded");
    (error as Error & CancellationBranded)[CANCELLATION] = undefined;
    expect(isCancellation(error)).toBe(false);
  });

  test("a DOMException named AbortError is a cancellation", () => {
    expect(isCancellation(new DOMException("The operation was aborted.", "AbortError"))).toBe(true);
  });

  test("a signal that has aborted makes any error a cancellation", () => {
    const controller = new AbortController();
    expect(isCancellation(new Error("x"), controller.signal)).toBe(false);
    controller.abort();
    expect(isCancellation(new Error("x"), controller.signal)).toBe(true);
  });

  test("an intact signal does not", () => {
    expect(isCancellation(new Error("x"), new AbortController().signal)).toBe(false);
  });

  test("non-error inputs return false rather than throwing", () => {
    expect(isCancellation(undefined)).toBe(false);
    expect(isCancellation(null)).toBe(false);
    expect(isCancellation("a string")).toBe(false);
  });

  test("a CancellationError reports its own name and carries its message", () => {
    const error = new CancellationError("the caller stopped this");
    expect(error.name).toBe("CancellationError");
    expect(error.message).toBe("the caller stopped this");
  });

  test("a Proxy whose get trap throws returns false, not the trap's error", () => {
    const hostile = new Proxy(new Error("hostile"), {
      get() {
        throw new Error("get trap");
      },
    });
    expect(isCancellation(hostile)).toBe(false);
  });

  test("a Proxy whose has and getOwnPropertyDescriptor traps throw returns false", () => {
    const hostile = new Proxy(new Error("hostile"), {
      has() {
        throw new Error("has trap");
      },
      getOwnPropertyDescriptor() {
        throw new Error("getOwnPropertyDescriptor trap");
      },
    });
    expect(isCancellation(hostile)).toBe(false);
  });

  test("an own [CANCELLATION] accessor whose getter throws returns false", () => {
    const error = new Error("hostile getter");
    Object.defineProperty(error, CANCELLATION, {
      get() {
        throw new Error("getter trap");
      },
      enumerable: true,
      configurable: true,
    });
    expect(isCancellation(error)).toBe(false);
  });
});
