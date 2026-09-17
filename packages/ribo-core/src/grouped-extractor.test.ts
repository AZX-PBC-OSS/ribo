import { describe, expect, test } from "vitest";
import { z } from "zod";

import { enveloped } from "./enveloped.js";
import type { Enveloped } from "./enveloped.js";
import type { AnnotatedTranscript } from "./annotated-transcript.js";
import type { ExtractionTarget, ExtractionUsage, ExtractOptions, Extractor } from "./extractor.js";
import type { ExtractionObserver, GroupUnit } from "./extraction-observer.js";
import type { RetryBudget } from "./retry-budget.js";
import { SchemaParseError } from "./schema-parse-error.js";
import { TerminalError } from "./storage/backoff.js";
import { groupedExtractor } from "./grouped-extractor.js";
import type { GroupMap } from "./grouped-extractor.js";

/**
 * Key-free tests for the `groupedExtractor` combinator, exercised with PLAIN
 * FAKE EXTRACTORS and no chat client at all — that it can be tested without a
 * transport is the point of the move. A group entry here is an opaque object
 * with an `extract` that records what it was handed and returns a canned
 * one-key result; nothing below knows or cares how a group would talk to a
 * model.
 *
 * The design's §9 must-fail tests, applied to the combinator directly:
 *   1. A `groups` map missing a top-level key throws at construction with the
 *      key named; so does a map naming a key the schema lacks.
 *   2. A group entry returning a one-key object of the wrong shape is rejected
 *      by the merged parse with a `SchemaParseError` naming the merge context.
 *   3. When one group entry fails terminally, a sibling in flight observes an
 *      aborted signal and no further entry starts.
 *   4. The derived `RetryBudget` for a known entry count is the shared
 *      derivation's answer — the same `deriveRetryBudget` the per-group preset
 *      feeds from its prepared-group count.
 *   5. Two groups wired to two different fake extractors each receive exactly
 *      the transcript once, and the merge carries both groups' fields.
 */

// --- Fixtures ----------------------------------------------------------------

const patch = z
  .object({
    hvac: z
      .object({
        equipmentType: z.string().nullable().optional(),
        fuel: z.string().nullable().optional(),
      })
      .strict()
      .optional(),
    attic: z
      .object({
        insulationDepth: z.string().nullable().optional(),
        insulationRValue: z.number().nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const extractionSchema = enveloped(patch);
type Values = z.infer<typeof patch>;
type Fields = Enveloped<Values>;

const target: ExtractionTarget<Values> = {
  name: "demo-grouped",
  extractionSchema,
  instructions: "Extract the hvac and attic fields.",
};

const hvacLeaf = (equipmentType: string) => ({
  equipmentType: { value: equipmentType, confidence: 0.9, sourceSpan: "boiler" },
  fuel: { value: "Natural Gas", confidence: 0.8, sourceSpan: "natural gas" },
});

const atticLeaf = (depth: string) => ({
  insulationDepth: { value: depth, confidence: 0.9, sourceSpan: "ten inches" },
  insulationRValue: { value: 30, confidence: 0.7, sourceSpan: "R-30" },
});

const transcript: AnnotatedTranscript = { text: "the transcript", annotations: {} };

/** What a fake entry recorded about one `extract()` call. */
interface EntryCall {
  readonly text: string;
  readonly options: ExtractOptions | undefined;
}

/** Behaviour knobs for a fake group entry. */
interface EntryBehavior {
  /** Fail every attempt with this error (a TerminalError, say). */
  readonly failure?: Error;
  /** Fail the first `failTimes` attempts transiently, then succeed. */
  readonly failTimes?: number;
  /** Never settle on their own; reject when the observed signal aborts. */
  readonly hangUntilAbort?: boolean;
  readonly usage?: ExtractionUsage;
  readonly statedEmptyGroups?: Readonly<Record<string, string>>;
}

function groupEntry<K extends keyof Fields>(
  key: K,
  value: Fields[K],
  behavior: EntryBehavior = {},
): Extractor<Pick<Fields, K>> & {
  readonly calls: readonly EntryCall[];
  readonly observedAbort: boolean;
} {
  const calls: EntryCall[] = [];
  let observedAbort = false;
  let attempts = 0;
  return {
    extract: (t, options) => {
      calls.push({ text: t.text, options });
      attempts += 1;
      const transient = behavior.failTimes !== undefined && attempts <= behavior.failTimes;
      if (behavior.failure !== undefined || transient) {
        return Promise.reject(behavior.failure ?? new Error("transient blip"));
      }
      if (behavior.hangUntilAbort) {
        return new Promise((_, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => {
              observedAbort = true;
              reject(new Error("fake transport aborted"));
            },
            { once: true },
          );
        });
      }
      return Promise.resolve({
        fields: { [key]: value } as Pick<Fields, K>,
        ...(behavior.usage !== undefined ? { usage: behavior.usage } : { usage: { calls: 1 } }),
        ...(behavior.statedEmptyGroups !== undefined
          ? { statedEmptyGroups: behavior.statedEmptyGroups }
          : {}),
      });
    },
    get calls() {
      return calls;
    },
    get observedAbort() {
      return observedAbort;
    },
  };
}

// --- The fan-out and the merge -----------------------------------------------

describe("groupedExtractor — the fan-out and the merge", () => {
  test("two group entries each receive the transcript once, and the merge carries both", async () => {
    const hvac = groupEntry("hvac", hvacLeaf("Boiler"));
    const attic = groupEntry("attic", atticLeaf("10-12"));
    const extractor = groupedExtractor({ target, groups: { hvac, attic } });

    const result = await extractor.extract(transcript);

    expect(result.fields).toEqual({ hvac: hvacLeaf("Boiler"), attic: atticLeaf("10-12") });
    expect(hvac.calls).toHaveLength(1);
    expect(hvac.calls[0]!.text).toBe(transcript.text);
    expect(attic.calls).toHaveLength(1);
    expect(attic.calls[0]!.text).toBe(transcript.text);
    expect(result.usage).toEqual({ calls: 2 });
  });

  test("usage sums from each entry's result, and unreported token counts stay absent", async () => {
    const hvac = groupEntry("hvac", hvacLeaf("Boiler"), {
      usage: { calls: 2, promptTokens: 100, completionTokens: 50 },
    });
    const attic = groupEntry("attic", atticLeaf("10-12"), { usage: { calls: 1 } });
    const extractor = groupedExtractor({ target, groups: { hvac, attic } });

    const result = await extractor.extract(transcript);

    expect(result.usage).toEqual({ calls: 3, promptTokens: 100, completionTokens: 50 });
    expect("cachedPromptTokens" in result.usage).toBe(false);
    expect("cacheCreationPromptTokens" in result.usage).toBe(false);
  });

  test("statedEmptyGroups is the union of what entries reported, absent when none did", async () => {
    const both = groupedExtractor({
      target,
      groups: {
        hvac: groupEntry("hvac", hvacLeaf("Boiler"), { statedEmptyGroups: { hvac: "none said" } }),
        attic: groupEntry("attic", atticLeaf("10-12"), {
          statedEmptyGroups: { attic: "no attic" },
        }),
      },
    });
    const neither = groupedExtractor({
      target,
      groups: {
        hvac: groupEntry("hvac", hvacLeaf("Boiler")),
        attic: groupEntry("attic", atticLeaf("10-12")),
      },
    });

    const withBoth = await both.extract(transcript);
    const withNeither = await neither.extract(transcript);

    expect(withBoth.statedEmptyGroups).toEqual({ hvac: "none said", attic: "no attic" });
    expect("statedEmptyGroups" in withNeither).toBe(false);
  });

  test("normalize runs once, on the merged result", async () => {
    const seen: Fields[] = [];
    const extractor = groupedExtractor({
      target,
      groups: {
        hvac: groupEntry("hvac", hvacLeaf("Boiler")),
        attic: groupEntry("attic", atticLeaf("10-12")),
      },
      normalize: (fields) => {
        seen.push(fields);
        return fields;
      },
    });

    await extractor.extract(transcript);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ hvac: hvacLeaf("Boiler"), attic: atticLeaf("10-12") });
  });

  test("a second extract() run is fresh — entries run again and usage restarts", async () => {
    const hvac = groupEntry("hvac", hvacLeaf("Boiler"));
    const attic = groupEntry("attic", atticLeaf("10-12"));
    const extractor = groupedExtractor({ target, groups: { hvac, attic } });

    const first = await extractor.extract(transcript);
    const second = await extractor.extract(transcript);

    expect(hvac.calls).toHaveLength(2);
    expect(second.fields).toEqual(first.fields);
    expect(second.usage).toEqual({ calls: 2 });
  });
});

// --- Coverage at construction ------------------------------------------------

describe("groupedExtractor — coverage is checked at construction", () => {
  const hvac = groupEntry("hvac", hvacLeaf("Boiler"));
  const attic = groupEntry("attic", atticLeaf("10-12"));
  const build = (groups: GroupMap<Values>): Extractor<Fields> =>
    groupedExtractor({ target, groups });

  test("a map missing a top-level key throws at construction with the key named", () => {
    // The cast is the JS-caller path: the map type makes this a compile error
    // for a TS caller (pinned two tests down); the guard still throws.
    const groups = { hvac } as unknown as GroupMap<Values>;
    expect(() => groupedExtractor({ target, groups })).toThrowError(/attic/);
  });

  test("a map naming a key the schema lacks throws at construction with the key named", () => {
    // A JS caller gets the runtime check; the type-level pin is the next test.
    const groups = { hvac, attic, ghost: hvac } as unknown as GroupMap<Values>;
    expect(() => groupedExtractor({ target, groups })).toThrowError(/ghost/);
  });

  test("a map missing a key is a compile error, and so is an extra one", () => {
    // Both probes execute too — the coverage guard throws at runtime for the
    // same reason the map type rejects them, so the assertion and the
    // directive pin the same refusal twice over.
    // @ts-expect-error — the map is exhaustive over the schema's top-level keys.
    expect(() => build({ hvac })).toThrowError(/attic/);
    // @ts-expect-error — a key outside the schema must not compile either.
    expect(() => build({ ...{ hvac, attic }, ghost: hvac })).toThrowError(/ghost/);
  });
});

// --- The second trust-boundary parse -----------------------------------------

describe("groupedExtractor — the second trust-boundary parse", () => {
  test("a group entry returning a one-key object of the wrong shape is rejected by the merged parse", async () => {
    // The entry owns its own parse — this fake skips it, which is exactly the
    // case the second parse exists to catch: a merge that produced a shape no
    // well-formed group response would have.
    const bad = groupEntry("hvac", { equipmentType: 42 } as unknown as Fields["hvac"]);
    const attic = groupEntry("attic", atticLeaf("10-12"));
    const extractor = groupedExtractor({ target, groups: { hvac: bad, attic } });

    const error = await extractor.extract(transcript).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(SchemaParseError);
    expect((error as Error).message).toContain('merged response for "demo-grouped"');
  });
});

// --- Sibling abort and the caller's signal ------------------------------------

describe("groupedExtractor — sibling abort and the caller's signal", () => {
  test("a terminal failure aborts an in-flight sibling, which observes the aborted signal", async () => {
    // The caller passes a signal of its own — never aborted — to pin the
    // correction this combinator exists for: `options?.signal ?? abort.signal`
    // would substitute the caller's signal for the run's own controller and
    // silently disable sibling abort.
    const caller = new AbortController();
    const failing = groupEntry("hvac", hvacLeaf("Boiler"), {
      failure: new TerminalError("truncated"),
    });
    const hanging = groupEntry("attic", atticLeaf("10-12"), { hangUntilAbort: true });
    const neverStarts = groupEntry("attic", atticLeaf("R-30"), { hangUntilAbort: true });
    const extractor = groupedExtractor({
      target,
      groups: { hvac: failing, attic: [hanging, neverStarts] },
      concurrency: 2,
    });

    await expect(extractor.extract(transcript, { signal: caller.signal })).rejects.toBeInstanceOf(
      TerminalError,
    );

    expect(hanging.observedAbort).toBe(true);
    // The caller's signal is a SOURCE of the run's signal, never its victim.
    expect(caller.signal.aborted).toBe(false);
    // No further entry starts after the failure.
    expect(neverStarts.calls).toHaveLength(0);
  });

  test("a caller abort cancels an in-flight entry, which observes the aborted signal", async () => {
    const caller = new AbortController();
    const hanging = groupEntry("hvac", hvacLeaf("Boiler"), { hangUntilAbort: true });
    const attic = groupEntry("attic", atticLeaf("10-12"));
    const extractor = groupedExtractor({ target, groups: { hvac: hanging, attic } });

    const run = extractor.extract(transcript, { signal: caller.signal });
    caller.abort();

    await expect(run).rejects.toThrow("fake transport aborted");
    expect(hanging.observedAbort).toBe(true);
  });

  test("an already-aborted caller signal starts no entry at all", async () => {
    const caller = new AbortController();
    caller.abort();
    const hvac = groupEntry("hvac", hvacLeaf("Boiler"));
    const attic = groupEntry("attic", atticLeaf("10-12"));
    const extractor = groupedExtractor({ target, groups: { hvac, attic } });

    await expect(extractor.extract(transcript, { signal: caller.signal })).rejects.toThrow(
      "groupedExtractor: aborted by the caller's signal",
    );
    expect(hvac.calls).toHaveLength(0);
    expect(attic.calls).toHaveLength(0);
  });
});

// --- Retry -------------------------------------------------------------------

describe("groupedExtractor — retry", () => {
  test("a transient failure is retried with full-jitter backoff and the run succeeds", async () => {
    const delays: number[] = [];
    const hvac = groupEntry("hvac", hvacLeaf("Boiler"), { failTimes: 1 });
    const attic = groupEntry("attic", atticLeaf("10-12"));
    const extractor = groupedExtractor({
      target,
      groups: { hvac, attic },
      maxRetries: 2,
      baseMs: 200,
      capMs: 400,
      random: () => 0.5,
      delay: async (ms) => {
        delays.push(ms);
      },
    });

    const result = await extractor.extract(transcript);

    expect(result.fields).toEqual({ hvac: hvacLeaf("Boiler"), attic: atticLeaf("10-12") });
    expect(hvac.calls).toHaveLength(2);
    expect(attic.calls).toHaveLength(1);
    // fullJitterDelay(0, { baseMs: 200, capMs: 400, random: () => 0.5 }) = floor(200 * 0.5).
    expect(delays).toEqual([100]);
  });

  test("a terminal failure is never retried and never delays", async () => {
    const delays: number[] = [];
    const failing = groupEntry("hvac", hvacLeaf("Boiler"), {
      failure: new TerminalError("truncated"),
    });
    const extractor = groupedExtractor({
      target,
      groups: { hvac: failing, attic: groupEntry("attic", atticLeaf("10-12")) },
      delay: async (ms) => {
        delays.push(ms);
      },
    });

    await expect(extractor.extract(transcript)).rejects.toBeInstanceOf(TerminalError);
    expect(failing.calls).toHaveLength(1);
    expect(delays).toEqual([]);
  });

  test("the derived retry budget for a known entry count is the shared derivation's answer", () => {
    const budgets: RetryBudget[] = [];
    // 2 entries / concurrency 1 = 2 batches. r=3 → 2 × (4·120000 + 7000) = 974000;
    // r=2 → 726000; r=1 → 2 × (2·120000 + 3000) = 486000 ≤ 700000. Derived 1.
    groupedExtractor({
      target,
      groups: {
        hvac: groupEntry("hvac", hvacLeaf("Boiler")),
        attic: groupEntry("attic", atticLeaf("10-12")),
      },
      concurrency: 1,
      maxRetries: 3,
      stepTimeoutMs: 700_000,
      onRetryBudget: (event) => budgets.push(event),
    });

    expect(budgets).toEqual([{ requested: 3, derived: 1, batches: 2, perCallCeilingMs: 120_000 }]);
  });

  test("onRetryBudget does not fire when nothing was reduced", async () => {
    const budgets: RetryBudget[] = [];
    const extractor = groupedExtractor({
      target,
      groups: {
        hvac: groupEntry("hvac", hvacLeaf("Boiler")),
        attic: groupEntry("attic", atticLeaf("10-12")),
      },
      maxRetries: 2,
      onRetryBudget: (event) => budgets.push(event),
    });

    await extractor.extract(transcript);
    expect(budgets).toEqual([]);
  });

  test("requireRetryBudget turns a derived-to-zero budget into a construction-time throw", () => {
    expect(() =>
      groupedExtractor({
        target,
        groups: {
          hvac: groupEntry("hvac", hvacLeaf("Boiler")),
          attic: groupEntry("attic", atticLeaf("10-12")),
        },
        maxRetries: 1,
        stepTimeoutMs: 1_000,
        requireRetryBudget: true,
      }),
    ).toThrowError(/groupedExtractor: retry budget derived to 0/);
  });
});

// --- Progress units ----------------------------------------------------------

describe("groupedExtractor — GroupUnit events", () => {
  test("each entry emits start/done with its key, part, parts and attempt", async () => {
    const events: GroupUnit[] = [];
    const onUnit: ExtractionObserver<GroupUnit>["onUnit"] = (event) => events.push(event);
    const extractor = groupedExtractor({
      target,
      groups: {
        hvac: groupEntry("hvac", hvacLeaf("Boiler")),
        attic: groupEntry("attic", atticLeaf("10-12")),
      },
      onUnit,
    });

    await extractor.extract(transcript);

    // Entries run concurrently, so events interleave across keys — assert per
    // key, where the sequence IS deterministic.
    const hvacEvents = events.filter((event) => event.key === "hvac");
    const atticEvents = events.filter((event) => event.key === "attic");
    expect(
      hvacEvents.map((event) => [event.phase, event.attempt, event.part, event.parts]),
    ).toEqual([
      ["start", 1, 1, 1],
      ["done", 1, 1, 1],
    ]);
    expect(
      atticEvents.map((event) => [event.phase, event.attempt, event.part, event.parts]),
    ).toEqual([
      ["start", 1, 1, 1],
      ["done", 1, 1, 1],
    ]);
    // start and done of one entry share an id; different entries differ.
    expect(hvacEvents[0]!.id).toBe(hvacEvents[1]!.id);
    expect(hvacEvents[0]!.id).not.toBe(atticEvents[0]!.id);
  });

  test("a retried entry's events carry the attempt number", async () => {
    const events: GroupUnit[] = [];
    const onUnit: ExtractionObserver<GroupUnit>["onUnit"] = (event) => events.push(event);
    const hvac = groupEntry("hvac", hvacLeaf("Boiler"), { failTimes: 1 });
    const extractor = groupedExtractor({
      target,
      groups: { hvac, attic: groupEntry("attic", atticLeaf("10-12")) },
      onUnit,
      delay: async () => {},
    });

    await extractor.extract(transcript);

    const hvacEvents = events.filter((event) => event.key === "hvac");
    expect(hvacEvents.map((event) => [event.phase, event.attempt])).toEqual([
      ["start", 1],
      ["error", 1],
      ["start", 2],
      ["done", 2],
    ]);
  });

  test("a terminal failure emits start/error for the attempt, and no event for a cancelled one", async () => {
    const events: GroupUnit[] = [];
    const onUnit: ExtractionObserver<GroupUnit>["onUnit"] = (event) => events.push(event);
    const failing = groupEntry("hvac", hvacLeaf("Boiler"), {
      failure: new TerminalError("truncated"),
    });
    const extractor = groupedExtractor({
      target,
      groups: { hvac: failing, attic: groupEntry("attic", atticLeaf("10-12")) },
      onUnit,
      delay: async () => {},
    });

    await expect(extractor.extract(transcript)).rejects.toBeInstanceOf(TerminalError);

    const hvacEvents = events.filter((event) => event.key === "hvac");
    expect(hvacEvents.map((event) => event.phase)).toEqual(["start", "error"]);
  });

  test("a partitioned group's pieces report part 1/2 and 2/2, and recombine by key", async () => {
    const events: GroupUnit[] = [];
    const onUnit: ExtractionObserver<GroupUnit>["onUnit"] = (event) => events.push(event);
    const pieceOne = groupEntry("hvac", hvacLeaf("Boiler"));
    const pieceTwo = groupEntry("hvac", hvacLeaf("Furnace"));
    const extractor = groupedExtractor({
      target,
      groups: { hvac: [pieceOne, pieceTwo], attic: groupEntry("attic", atticLeaf("10-12")) },
      onUnit,
    });

    const result = await extractor.extract(transcript);

    // Pieces of one key recombine — on overlapping leaves the incoming piece's
    // value wins, which is mergeGroupPieces's shallow-merge definition.
    expect(result.fields.hvac).toEqual(hvacLeaf("Furnace"));
    // Pieces start concurrently, so assert per piece, where order is
    // deterministic — and both pieces report the same parts total.
    const hvacEvents = events.filter((event) => event.key === "hvac");
    const partOne = hvacEvents.filter((event) => event.part === 1);
    const partTwo = hvacEvents.filter((event) => event.part === 2);
    expect(partOne.map((event) => event.phase)).toEqual(["start", "done"]);
    expect(partTwo.map((event) => event.phase)).toEqual(["start", "done"]);
    expect(partOne.every((event) => event.parts === 2)).toBe(true);
    expect(partTwo.every((event) => event.parts === 2)).toBe(true);
  });
});

// --- The non-grouped fallback arm --------------------------------------------

describe("groupedExtractor — the non-grouped fallback arm", () => {
  /**
   * A flat patch: top-level properties are leaf envelopes, so `splitExtractionSchema`'s
   * fallback yields one entry with key "" covering the whole schema — the shape the per-group
   * preset sends for a non-grouped schema (design §4.7). The entry's fields ARE the whole
   * result, so the fake returns a full `Fields` and the merge must assign them flat, not
   * nest them under "".
   */
  function wholeEntry(value: Fields): Extractor<Fields> & { readonly calls: number } {
    let calls = 0;
    return {
      extract: () => {
        calls += 1;
        return Promise.resolve({ fields: value, usage: { calls: 1 } });
      },
      get calls() {
        return calls;
      },
    };
  }

  const whole = { hvac: hvacLeaf("Boiler"), attic: atticLeaf("10-12") };

  test('a map whose only key is "" schedules one whole-schema entry: events keyed "", fields merged flat', async () => {
    const events: GroupUnit[] = [];
    const onUnit: ExtractionObserver<GroupUnit>["onUnit"] = (event) => events.push(event);
    const entry = wholeEntry(whole);
    const extractor = groupedExtractor({
      target,
      groups: { "": entry } as GroupMap<Values>,
      onUnit,
    });

    const result = await extractor.extract(transcript);

    expect(result.fields).toEqual(whole);
    expect(result.usage).toEqual({ calls: 1 });
    // One entry, so the events carry the fallback vocabulary: key "", part 1 of 1.
    expect(events.map((event) => [event.phase, event.key, event.part, event.parts])).toEqual([
      ["start", "", 1, 1],
      ["done", "", 1, 1],
    ]);
  });

  test('the "" key combined with per-key entries throws at construction', () => {
    const entry = wholeEntry(whole);
    // The cast is the JS-caller path — the type level cannot express the mix either.
    const groups = { "": entry, hvac: entry } as unknown as GroupMap<Values>;
    expect(() => groupedExtractor({ target, groups })).toThrowError(/non-grouped fallback/);
  });

  test("the fallback entry's retry budget derives from one entry — one batch", () => {
    const budgets: RetryBudget[] = [];
    groupedExtractor({
      target,
      groups: { "": wholeEntry(whole) } as GroupMap<Values>,
      concurrency: 4,
      maxRetries: 3,
      stepTimeoutMs: 700_000,
      onRetryBudget: (event) => budgets.push(event),
    });
    // 1 entry / concurrency 4 = 1 batch. r=3 → 1 × (4·120000 + 7000) = 487000 ≤ 700000,
    // so nothing is reduced and the event does not fire — the derivation ran on 1 entry.
    expect(budgets).toEqual([]);
  });
});

// --- Concurrency bound --------------------------------------------------------

describe("groupedExtractor — the pool is bounded", () => {
  test("no more than `concurrency` entries are in flight at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const entry = (): Extractor<Pick<Fields, "hvac">> => ({
      extract: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 0));
        inFlight -= 1;
        return { fields: { hvac: hvacLeaf("Boiler") }, usage: { calls: 1 } };
      },
    });
    const extractor = groupedExtractor({
      target,
      groups: {
        hvac: [entry(), entry(), entry(), entry(), entry()],
        attic: groupEntry("attic", atticLeaf("10-12")),
      },
      concurrency: 2,
    });

    const result = await extractor.extract(transcript);

    expect(peak).toBe(2);
    expect(result.usage.calls).toBe(6);
  });
});
