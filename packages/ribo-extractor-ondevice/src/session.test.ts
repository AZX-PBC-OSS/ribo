import { describe, expect, test } from "vitest";
import type { ScheduleTimer } from "@azx/ribo-core";

import { FakeLanguageModel } from "./test-support/fake-language-model.js";
import { SessionCapabilityError, SessionHolder } from "./session.js";

class FakeTimer {
  #callbacks: (() => void)[] = [];

  readonly schedule: ScheduleTimer = (fn) => {
    this.#callbacks.push(fn);
    return () => {
      const i = this.#callbacks.indexOf(fn);
      if (i >= 0) this.#callbacks.splice(i, 1);
    };
  };

  fireLatest(): void {
    this.#callbacks.pop()?.();
  }
}

describe("SessionHolder", () => {
  test("two sequential calls create the base once and clone twice", async () => {
    const model = new FakeLanguageModel();
    model.availabilityValue = "available";
    const holder = new SessionHolder({ languageModel: model });

    await holder.run(async () => "first");
    await holder.run(async () => "second");

    expect(model.createCount).toBe(1);
    const base = model.sessions[0]!;
    expect(base).toBeDefined();
    expect(base.cloneCount).toBe(2);
  });

  test("a clone is destroyed after success; the base is retained", async () => {
    const model = new FakeLanguageModel();
    model.availabilityValue = "available";
    const holder = new SessionHolder({ languageModel: model });

    await holder.run(async () => "ok");

    const base = model.sessions[0]!;
    const clone = model.sessions[1]!;
    expect(base).toBeDefined();
    expect(clone).toBeDefined();
    expect(base.destroyed).toBe(false);
    expect(clone.destroyed).toBe(true);
  });

  test("a clone is destroyed when the work throws", async () => {
    const model = new FakeLanguageModel();
    model.availabilityValue = "available";
    const holder = new SessionHolder({ languageModel: model });

    await expect(
      holder.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const base = model.sessions[0]!;
    const clone = model.sessions[1]!;
    expect(base).toBeDefined();
    expect(clone).toBeDefined();
    expect(base.destroyed).toBe(false);
    expect(clone.destroyed).toBe(true);
  });

  test("a clone is destroyed when the work aborts", async () => {
    const model = new FakeLanguageModel();
    model.availabilityValue = "available";
    const holder = new SessionHolder({ languageModel: model });

    const abortError = new DOMException("aborted", "AbortError");
    await expect(
      holder.run(async () => {
        throw abortError;
      }),
    ).rejects.toThrow(abortError);

    const base = model.sessions[0]!;
    const clone = model.sessions[1]!;
    expect(base).toBeDefined();
    expect(clone).toBeDefined();
    expect(base.destroyed).toBe(false);
    expect(clone.destroyed).toBe(true);
  });

  test("after the idle period the base is destroyed and the next call creates a fresh one", async () => {
    const timer = new FakeTimer();
    const model = new FakeLanguageModel();
    model.availabilityValue = "available";
    const holder = new SessionHolder({
      languageModel: model,
      scheduleTimer: timer.schedule,
      idleMs: 1,
    });

    await holder.run(async () => "ok");

    const firstBase = model.sessions[0]!;
    expect(firstBase).toBeDefined();
    expect(firstBase.destroyed).toBe(false);

    timer.fireLatest();

    expect(firstBase.destroyed).toBe(true);

    await holder.run(async () => "ok");

    expect(model.createCount).toBe(2);
    const secondBase = model.sessions[2]!;
    expect(secondBase).toBeDefined();
    expect(secondBase.destroyed).toBe(false);
  });

  test.each(["unavailable", "downloadable", "downloading"] as const)(
    "does not call create() when availability is %s",
    async (availability) => {
      const model = new FakeLanguageModel();
      model.availabilityValue = availability;
      const holder = new SessionHolder({ languageModel: model });

      await expect(holder.run(async () => "ok")).rejects.toThrow(SessionCapabilityError);

      expect(model.createCount).toBe(0);
    },
  );

  test("concurrent calls share one base session instead of racing to create", async () => {
    const model = new FakeLanguageModel();
    model.availabilityValue = "available";
    const holder = new SessionHolder({ languageModel: model });

    const [first, second] = await Promise.all([
      holder.run(async () => "a"),
      holder.run(async () => "b"),
    ]);

    expect(first).toBe("a");
    expect(second).toBe("b");
    expect(model.createCount).toBe(1);

    const base = model.sessions[0]!;
    expect(base).toBeDefined();
    expect(base.cloneCount).toBe(2);
    expect(model.sessions[1]!.destroyed).toBe(true);
    expect(model.sessions[2]!.destroyed).toBe(true);
  });
});
