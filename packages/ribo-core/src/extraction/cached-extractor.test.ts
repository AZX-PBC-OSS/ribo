import { z } from "zod";
import { describe, expect, test } from "vitest";

import { enveloped } from "../provenance/enveloped.js";
import { FakeExtractor } from "./extractor.js";
import type { Extractor, ExtractionResult, ExtractionTarget } from "./extractor.js";
import type { AnnotatedTranscript } from "../capture/annotated-transcript.js";
import { cachedExtractor } from "./cached-extractor.js";
import type { ExtractionCache } from "./cached-extractor.js";

/**
 * Tests for `cachedExtractor` — the memoisation combinator
 * (`sp2-judging-combinators-design.md` §4.4, ADR 0005).
 *
 * The key covers the whole prompt — transcript text, target name, instructions,
 * examples and the extraction schema — because instructions and examples ARE the
 * prompt. The tests that matter most are the ones where a cheaper key would
 * silently serve one target's result for another:
 *
 * - a changed `examples` ORDER is a miss (few-shot order is part of the prompt),
 *   even though structurally identical object keys in a different order are a
 *   hit — the serialiser sorts object keys and preserves array order, and each
 *   half of that sentence is pinned separately;
 * - the key reads `transcript.text` and NOTHING else on the transcript —
 *   annotations carry per-capture ids and sequence numbers that vary between
 *   captures, so digesting the whole object would silently kill the cache for
 *   re-dictated text;
 * - a hit reports `calls: 0` — the stored usage describes the run that produced
 *   the result, and this run made no model calls; an unrewritten hit books a
 *   spend that did not happen, which is exactly what `budgetExtractor` reads.
 */

type Fields = { heating: { systemType: string | null } };

const FIELDS: Fields = { heating: { systemType: "gas" } };

const TRANSCRIPT_TEXT = "The heating system is a gas furnace.";

const transcript: AnnotatedTranscript = { text: TRANSCRIPT_TEXT, annotations: {} };

const testValuesSchema = z
  .object({
    heating: z.object({ systemType: z.string().nullable().optional() }).strict(),
  })
  .strict();

/** A hand-built leaf envelope, the way model output arrives after parsing. */
const leaf = <T>(value: T, sourceSpan: string | null) => ({
  value,
  confidence: 1,
  sourceSpan,
});

const baseTarget = (
  overrides?: Partial<ExtractionTarget<z.infer<typeof testValuesSchema>>>,
): ExtractionTarget<z.infer<typeof testValuesSchema>> => ({
  name: "test-target",
  extractionSchema: enveloped(testValuesSchema),
  instructions: "extract the heating fields",
  examples: [
    { transcript: "gas furnace example", fields: { heating: { systemType: leaf("gas", "gas") } } },
  ],
  ...overrides,
});

/** A fresh in-memory `ExtractionCache` exposing its map, so two instances can share it. */
const memoryCache = (): ExtractionCache & { map: Map<string, ExtractionResult<unknown>> } => {
  const map = new Map<string, ExtractionResult<unknown>>();
  return {
    map,
    get: async (key) => map.get(key),
    set: async (key, result) => {
      map.set(key, result);
    },
  };
};

/**
 * Two structurally identical examples whose object keys were built in different
 * insertion orders — nested inside the envelope objects, not merely at the top
 * level, so a serialiser that sorts one level deep fails. `toEqual` (key-order
 * blind) considers them identical; that is the point.
 */
const exampleOrderedA = {
  transcript: "The system is gas.",
  fields: {
    heating: {
      systemType: { value: "gas", confidence: 1, sourceSpan: "gas" },
      efficiency: { value: 0.8, confidence: 1, sourceSpan: "0.8" },
    },
  },
};
const exampleOrderedB = {
  transcript: "The system is gas.",
  fields: {
    heating: {
      efficiency: { sourceSpan: "0.8", confidence: 1, value: 0.8 },
      systemType: { sourceSpan: "gas", confidence: 1, value: "gas" },
    },
  },
};

describe("cachedExtractor — the key covers the whole prompt", () => {
  test("a second identical call is served from the cache without invoking the inner extractor", async () => {
    // The DEFAULT cache: a per-combinator in-memory Map.
    const inner = new FakeExtractor(FIELDS);
    const extractor = cachedExtractor(inner, { target: baseTarget() });

    const first = await extractor.extract(transcript);
    const second = await extractor.extract(transcript);

    expect(inner.calls).toHaveLength(1);
    expect(second.fields).toEqual(FIELDS);
    expect(first.fields).toEqual(FIELDS);
  });

  test("a changed transcript misses", async () => {
    const inner = new FakeExtractor(FIELDS);
    const extractor = cachedExtractor(inner, { target: baseTarget() });

    await extractor.extract({ text: TRANSCRIPT_TEXT, annotations: {} });
    await extractor.extract({ text: "A different house entirely.", annotations: {} });

    expect(inner.calls).toHaveLength(2);
  });

  test("a changed instructions misses", async () => {
    const cache = memoryCache();
    const innerA = new FakeExtractor(FIELDS);
    const innerB = new FakeExtractor(FIELDS);
    await cachedExtractor(innerA, { target: baseTarget(), cache }).extract(transcript);
    await cachedExtractor(innerB, {
      target: baseTarget({ instructions: "different instructions, different prompt" }),
      cache,
    }).extract(transcript);

    expect(innerB.calls).toHaveLength(1);
  });

  test("a changed examples misses", async () => {
    const cache = memoryCache();
    const innerA = new FakeExtractor(FIELDS);
    const innerB = new FakeExtractor(FIELDS);
    await cachedExtractor(innerA, { target: baseTarget(), cache }).extract(transcript);
    await cachedExtractor(innerB, {
      target: baseTarget({
        examples: [
          {
            transcript: "an oil furnace example",
            fields: { heating: { systemType: leaf("oil", "oil") } },
          },
        ],
      }),
      cache,
    }).extract(transcript);

    expect(innerB.calls).toHaveLength(1);
  });

  test("two targets differing only in the ORDER of examples miss each other — the array-order pin", async () => {
    // Few-shot order is part of the prompt: the message builder iterates
    // examples in order. A serialiser that "stabilised" arrays too would make
    // these two targets collide, serving one's result for the other — the
    // precise silent-wrong-data failure this key exists to prevent,
    // reintroduced by the thing meant to prevent it. So: a MISS. The two
    // examples are structurally DIFFERENT (a gas rung and an oil rung) — two
    // structurally identical examples could not distinguish an order, and their
    // key-order-insensitive twins are pinned separately below.
    const gasExample = {
      transcript: "gas example",
      fields: { heating: { systemType: leaf("gas", "gas") } },
    };
    const oilExample = {
      transcript: "oil example",
      fields: { heating: { systemType: leaf("oil", "oil") } },
    };
    const cache = memoryCache();
    const innerA = new FakeExtractor(FIELDS);
    const innerB = new FakeExtractor(FIELDS);
    await cachedExtractor(innerA, {
      target: baseTarget({ examples: [gasExample, oilExample] }),
      cache,
    }).extract(transcript);
    await cachedExtractor(innerB, {
      target: baseTarget({ examples: [oilExample, gasExample] }),
      cache,
    }).extract(transcript);

    expect(innerB.calls).toHaveLength(1);
  });

  test("a changed extractionSchema misses", async () => {
    const cache = memoryCache();
    const innerA = new FakeExtractor(FIELDS);
    const innerB = new FakeExtractor(FIELDS);
    await cachedExtractor(innerA, { target: baseTarget(), cache }).extract(transcript);
    // A different schema is a different target type — its own instance, same
    // name and instructions, so the SCHEMA is the only key input that moved.
    const otherSchema = z
      .object({ heating: z.object({ age: z.number().nullable().optional() }).strict() })
      .strict();
    const otherTarget: ExtractionTarget<z.infer<typeof otherSchema>> = {
      name: "test-target",
      extractionSchema: enveloped(otherSchema),
      instructions: "extract the heating fields",
    };
    await cachedExtractor(innerB, { target: otherTarget, cache }).extract(transcript);

    expect(innerB.calls).toHaveLength(1);
  });

  test("a target differing only in name misses", async () => {
    const cache = memoryCache();
    const innerA = new FakeExtractor(FIELDS);
    const innerB = new FakeExtractor(FIELDS);
    await cachedExtractor(innerA, { target: baseTarget(), cache }).extract(transcript);
    await cachedExtractor(innerB, {
      target: baseTarget({ name: "another-target" }),
      cache,
    }).extract(transcript);

    expect(innerB.calls).toHaveLength(1);
  });

  test("two structurally identical targets whose object keys were built in different order produce the same key", async () => {
    // The hit half of the serialiser's contract. The differing insertion order
    // is nested INSIDE an example's envelope objects, so a serialiser that
    // sorted one level deep would pass a flat version of this test while
    // leaving the bug: random cache misses presenting as a performance problem.
    expect(exampleOrderedA).toEqual(exampleOrderedB);

    const cache = memoryCache();
    const innerA = new FakeExtractor(FIELDS);
    const innerB = new FakeExtractor(FIELDS);
    await cachedExtractor(innerA, {
      target: baseTarget({ examples: [exampleOrderedA] }),
      cache,
    }).extract(transcript);
    await cachedExtractor(innerB, {
      target: baseTarget({ examples: [exampleOrderedB] }),
      cache,
    }).extract(transcript);

    expect(innerB.calls).toHaveLength(0);
  });

  test("the key is derived from transcript.text and NOTHING else on the transcript", async () => {
    // Annotations carry per-capture ids and sequence numbers that vary between
    // captures; digesting the whole transcript object would silently kill the
    // cache for re-dictated text, in a way no other test here would notice.
    const inner = new FakeExtractor(FIELDS);
    const extractor = cachedExtractor(inner, { target: baseTarget() });

    await extractor.extract({ text: TRANSCRIPT_TEXT, annotations: { "capture.id": "first" } });
    await extractor.extract({ text: TRANSCRIPT_TEXT, annotations: { "capture.id": "second" } });

    expect(inner.calls).toHaveLength(1);
  });

  test("the default key carries a v1: prefix", async () => {
    // The in-memory default dies with the process, but the injected store may be
    // persistent, and a later change to the serialisation or the digest would
    // then serve keys computed under the old recipe. The prefix is one line of
    // insurance against a class of bug that is invisible when it happens.
    const setKeys: string[] = [];
    const cache: ExtractionCache = {
      get: async () => undefined,
      set: async (key) => {
        setKeys.push(key);
      },
    };
    const extractor = cachedExtractor(new FakeExtractor(FIELDS), { target: baseTarget(), cache });

    await extractor.extract(transcript);

    expect(setKeys).toHaveLength(1);
    expect(setKeys[0]?.startsWith("v1:")).toBe(true);
  });

  test("a custom keyFor is used instead of the default", async () => {
    // The key ignores the transcript entirely — the default digest would make
    // the second (different-text) call a miss, so a hit proves the injection won.
    const inner = new FakeExtractor(FIELDS);
    const extractor = cachedExtractor(inner, {
      target: baseTarget(),
      keyFor: () => "host-supplied-identity",
    });

    await extractor.extract({ text: TRANSCRIPT_TEXT, annotations: {} });
    await extractor.extract({ text: "A different house entirely.", annotations: {} });

    expect(inner.calls).toHaveLength(1);
  });
});

describe("cachedExtractor — failures and faults", () => {
  test("a rejecting inner call is NOT cached — the next call retries and the inner runs twice", async () => {
    // A cached rejection turns one bad minute into a permanent one. The third
    // call then hits, pinning that the recovery run's success was cached.
    let calls = 0;
    const flaky: Extractor<Fields> = {
      extract: async () => {
        calls += 1;
        if (calls === 1) throw new Error("transport down");
        return { fields: FIELDS, usage: { calls: 1 } };
      },
    };
    const extractor = cachedExtractor(flaky, { target: baseTarget() });

    await expect(extractor.extract(transcript)).rejects.toThrow("transport down");
    const second = await extractor.extract(transcript);
    expect(calls).toBe(2);
    expect(second.fields).toEqual(FIELDS);

    const third = await extractor.extract(transcript);
    expect(calls).toBe(2);
    expect(third.fields).toEqual(FIELDS);
  });

  test("a result with skipped items is returned but NOT cached — a partial failure is a rejection's cousin", async () => {
    // Cached, the engine-written abstentions would replay at calls: 0 on every
    // re-run of the transcript, however healthy the transport had become.
    let calls = 0;
    const partial: Extractor<Fields> = {
      extract: async () => {
        calls += 1;
        return {
          fields: FIELDS,
          usage: { calls: 1 },
          skippedItems: calls === 1 ? [{ phaseId: "fill", key: "heating" }] : [],
        };
      },
    };
    const extractor = cachedExtractor(partial, { target: baseTarget() });

    const first = await extractor.extract(transcript);
    expect(first.skippedItems).toEqual([{ phaseId: "fill", key: "heating" }]);
    await extractor.extract(transcript);
    expect(calls).toBe(2);

    // The clean run (`[]`) was cached, and its report replays with it.
    const third = await extractor.extract(transcript);
    expect(calls).toBe(2);
    expect(third.skippedItems).toEqual([]);
  });

  test("a cache whose get throws degrades to a miss", async () => {
    const inner = new FakeExtractor(FIELDS);
    const cache: ExtractionCache = {
      get: async () => {
        throw new Error("quota exceeded");
      },
      set: async () => undefined,
    };
    const extractor = cachedExtractor(inner, { target: baseTarget(), cache });

    await expect(extractor.extract(transcript)).resolves.toHaveProperty("fields", FIELDS);
    expect(inner.calls).toHaveLength(1);
  });

  test("a keyFor that throws propagates — unlike a cache fault, nothing has been paid for yet", async () => {
    // The never-fail rule covers the CACHE, not the host's own key function.
    // A throwing cache is an infrastructure fault around work already done or
    // about to be done anyway, so swallowing it costs nothing. A throwing
    // `keyFor` is a bug in the caller's code, before any call is made — and
    // degrading to a miss there would hide it behind a silently uncached
    // extractor that still returns correct results, which is the worst way to
    // learn about it. Pinned because the behaviour is otherwise incidental.
    const inner = new FakeExtractor(FIELDS);
    const boom = new Error("keyFor is broken");
    const extractor = cachedExtractor(inner, {
      target: baseTarget(),
      keyFor: () => {
        throw boom;
      },
    });

    await expect(extractor.extract(transcript)).rejects.toBe(boom);
    expect(inner.calls).toHaveLength(0);
  });

  test("a cache whose set throws still returns the result", async () => {
    // The result is already in hand and paid for — failing on the write would
    // discard it. A cache that can take down extraction is worse than no cache.
    const inner = new FakeExtractor(FIELDS);
    const cache: ExtractionCache = {
      get: async () => undefined,
      set: async () => {
        throw new Error("structured clone failed");
      },
    };
    const extractor = cachedExtractor(inner, { target: baseTarget(), cache });

    await expect(extractor.extract(transcript)).resolves.toHaveProperty("fields", FIELDS);
    expect(inner.calls).toHaveLength(1);
  });
});

describe("cachedExtractor — the hit's usage", () => {
  test("a hit reports calls: 0, keeps the stored engine and strategy, and carries no token members", async () => {
    // The stored usage describes the run that PRODUCED the result; this run made
    // no model calls, and `ExtractionUsage.calls` is documented as calls made —
    // returning the stored count books a spend that did not happen. It matters
    // beyond tidiness: that usage is exactly what `budgetExtractor` reads and
    // what `toSessionExtractStep` forwards to the session. `engine` and
    // `strategy` survive — they describe what produced the fields, still true.
    const inner = new FakeExtractor(FIELDS, {
      usage: {
        calls: 2,
        engine: "test-engine",
        strategy: "test-strategy",
        promptTokens: 100,
        completionTokens: 50,
        cachedPromptTokens: 10,
        cacheCreationPromptTokens: 5,
      },
    });
    const extractor = cachedExtractor(inner, { target: baseTarget() });

    await extractor.extract(transcript);
    const hit = await extractor.extract(transcript);

    expect(inner.calls).toHaveLength(1);
    expect(hit.fields).toEqual(FIELDS);
    expect(hit.usage).toEqual({ calls: 0, engine: "test-engine", strategy: "test-strategy" });
  });
});

describe("cachedExtractor — delegating discipline", () => {
  test("the inner extractor receives the caller's signal AND deadline", async () => {
    // The forward discipline every delegating combinator in this repo pins.
    const inner = new FakeExtractor(FIELDS);
    const controller = new AbortController();
    const extractor = cachedExtractor(inner, { target: baseTarget() });

    await extractor.extract(transcript, {
      signal: controller.signal,
      deadline: 1_234_567_890,
    });

    expect(inner.callOptions).toHaveLength(1);
    expect(inner.callOptions[0]?.signal).toBe(controller.signal);
    expect(inner.callOptions[0]?.deadline).toBe(1_234_567_890);
  });

  test("it emits no progress unit of its own — the options bag has no observer", async () => {
    // ADR 0004: a wrapper that delegates and judges makes no model call
    // of its own, so it has nothing to report.
    const inner = new FakeExtractor(FIELDS);
    const extractor = cachedExtractor(inner, {
      target: baseTarget(),
      // @ts-expect-error — the options bag has no observer: this combinator
      // reports nothing, and the type is what enforces it.
      onUnit: () => undefined,
    });

    await extractor.extract(transcript);

    expect(inner.calls).toHaveLength(1);
  });
});
