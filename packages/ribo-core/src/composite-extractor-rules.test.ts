import { describe, expect, test } from "vitest";

import { DEFAULT_CAPABILITY_TTL_MS } from "./first-capable.js";
import type { Extractor, ExtractionResult } from "./extractor.js";
import type { CapabilitySource, SelectableCapability } from "./composite-extractor.js";
import { compositeExtractor } from "./composite-extractor.js";

interface MutableClock {
  now(): number;
  advance(ms: number): void;
}

function makeClock(): MutableClock {
  let t = 0;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function fakeSource(
  engine: string,
  capability: SelectableCapability,
): CapabilitySource & { probeCount: number } {
  let probeCount = 0;
  return {
    engine,
    capability: async () => {
      probeCount += 1;
      return capability;
    },
    get probeCount() {
      return probeCount;
    },
  };
}

function throwingSource(engine: string, error: Error): CapabilitySource & { probeCount: number } {
  let probeCount = 0;
  return {
    engine,
    capability: async () => {
      probeCount += 1;
      throw error;
    },
    get probeCount() {
      return probeCount;
    },
  };
}

function fakeExtractor<F>(
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

const ready = (): SelectableCapability => ({ status: "ready" });

describe("compositeExtractor rules", () => {
  test("rule 5: a selected extractor's error propagates untouched and later entries are not touched", async () => {
    const sentinel = { tag: "sentinel" };
    const firstSource = fakeSource("first", ready());
    const firstExtractor = fakeExtractor({ a: 1 }, { throws: sentinel });
    const secondSource = fakeSource("second", ready());
    const secondExtractor = fakeExtractor({ b: 2 });

    const extractor = compositeExtractor<unknown>([
      { source: firstSource, extractor: firstExtractor },
      { source: secondSource, extractor: secondExtractor },
    ]);

    await expect(extractor.extract("x")).rejects.toBe(sentinel);
    expect(firstExtractor.calls).toEqual(["x"]);
    expect(secondExtractor.calls).toEqual([]);
    expect(secondSource.probeCount).toBe(0);
  });

  test("usage.engine is stamped from the source, not the extractor's own usage", async () => {
    const source = fakeSource("managed", ready());
    const inner = fakeExtractor({ a: 1 }, { engine: "on-device" });
    const extractor = compositeExtractor([{ source, extractor: inner }]);

    const result = await extractor.extract("x");

    expect(result.usage).toEqual({ calls: 1, engine: "managed" });
  });

  test("a thrown capability probe is reported as unavailable rather than propagating", async () => {
    const source = throwingSource("managed", new Error("probe boom"));
    const extractor = compositeExtractor([{ source, extractor: fakeExtractor({}) }]);

    await expect(extractor.extract("x")).rejects.toThrow(
      "managed: unavailable (unknown) — capability probe failed: probe boom",
    );
  });

  test("duplicate engine ids throw TypeError at construction", () => {
    expect(() =>
      compositeExtractor([
        { source: fakeSource("same", ready()), extractor: fakeExtractor({}) },
        { source: fakeSource("same", ready()), extractor: fakeExtractor({}) },
      ]),
    ).toThrow(TypeError);
  });

  test("empty entries throw TypeError at construction", () => {
    expect(() => compositeExtractor([])).toThrow(TypeError);
  });

  test("capability is re-probed after the TTL expires", async () => {
    const clock = makeClock();
    const source = fakeSource("managed", ready());
    const extractor = compositeExtractor([{ source, extractor: fakeExtractor({}) }], {
      now: clock.now,
    });

    await extractor.extract("a");
    expect(source.probeCount).toBe(1);

    clock.advance(DEFAULT_CAPABILITY_TTL_MS + 1);
    await extractor.extract("b");
    expect(source.probeCount).toBe(2);
  });
});
