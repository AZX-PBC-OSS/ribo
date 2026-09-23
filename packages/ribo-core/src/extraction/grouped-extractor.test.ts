import { describe, expect, test } from "vitest";
import { z } from "zod";

import { enveloped } from "../provenance/enveloped.js";
import type { Enveloped } from "../provenance/enveloped.js";
import type { AnnotatedTranscript } from "../capture/annotated-transcript.js";
import type { ExtractionTarget, ExtractionUsage, ExtractOptions, Extractor } from "./extractor.js";
import { FakeExtractor } from "./extractor.js";
import type { ExtractionObserver, GroupUnit } from "./extraction-observer.js";
import type { RetryBudget } from "../async/retry-budget.js";
import { SchemaParseError } from "./schema-parse-error.js";
import { TerminalError } from "../storage/backoff.js";
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

// --- The caller's options reach each entry ------------------------------------

describe("groupedExtractor — the caller's options reach each entry", () => {
  test("each entry receives the caller's deadline and the combinator's combined signal", async () => {
    // FakeExtractor records the whole options bag it was handed, so a dropped
    // forward is visible: this pins the deadline past the one site that rebuilt
    // the bag instead of forwarding it.
    const caller = new AbortController();
    const deadline = Date.now() + 60_000;
    const hvac = new FakeExtractor<Pick<Fields, "hvac">>({ hvac: hvacLeaf("Boiler") });
    const attic = new FakeExtractor<Pick<Fields, "attic">>({ attic: atticLeaf("10-12") });
    const extractor = groupedExtractor({ target, groups: { hvac, attic } });

    await extractor.extract(transcript, { signal: caller.signal, deadline });

    expect(hvac.callOptions[0]?.deadline).toBe(deadline);
    expect(attic.callOptions[0]?.deadline).toBe(deadline);
    // The signal the entry sees is the combinator's combined signal, NOT the
    // caller's raw one — so the fix cannot be "forward the caller's bag
    // verbatim", which would silently disable sibling abort (the trap the
    // sibling-abort section documents).
    expect(hvac.callOptions[0]?.signal).toBeDefined();
    expect(hvac.callOptions[0]?.signal).not.toBe(caller.signal);
    expect(attic.callOptions[0]?.signal).toBeDefined();
    expect(attic.callOptions[0]?.signal).not.toBe(caller.signal);
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

  test('`unwrapped` alone schedules one whole-schema entry: events keyed "", fields merged flat', async () => {
    const events: GroupUnit[] = [];
    const onUnit: ExtractionObserver<GroupUnit>["onUnit"] = (event) => events.push(event);
    const entry = wholeEntry(whole);
    const extractor = groupedExtractor({ target, unwrapped: entry, onUnit });

    const result = await extractor.extract(transcript);

    expect(result.fields).toEqual(whole);
    expect(result.usage).toEqual({ calls: 1 });
    // One entry, so the events carry the fallback vocabulary: key "", part 1 of
    // 1. The READING surface keeps the marker — only the writing surface lost
    // it — so the ["", 1, 1] sequence staying green is the no-behaviour-change
    // pin.
    expect(events.map((event) => [event.phase, event.key, event.part, event.parts])).toEqual([
      ["start", "", 1, 1],
      ["done", "", 1, 1],
    ]);
  });

  test("`unwrapped` beside named keys is no longer refused outright — see the mixed arm below", () => {
    // The old blanket refusal ("either the schema has groups or it does not")
    // narrowed to the redundancy rule (mixed-schema-split design §4.2): this
    // composition names hvac and leaves attic to the unwrapped entry, which is
    // the accepted mixed shape. No cast — arm B of the options union admits it.
    // The refusal's surviving half is pinned in the mixed arm.
    const entry = wholeEntry(whole);
    expect(() =>
      groupedExtractor({ target, groups: { hvac: entry }, unwrapped: entry }),
    ).not.toThrow();
  });

  test("the fallback entry's retry budget derives from one entry — one batch", () => {
    const budgets: RetryBudget[] = [];
    groupedExtractor({
      target,
      unwrapped: wholeEntry(whole),
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

// --- The mixed arm: `unwrapped` beside named keys ------------------------------

describe("groupedExtractor — the mixed arm: `unwrapped` beside named keys", () => {
  /**
   * A schema with one group and loose top-level leaves — the shape
   * `splitExtractionSchema` now emits for a mixed schema: one entry per group,
   * plus the loose leaves carried as the unwrapped portion (mixed-schema-split
   * design §4). The loose entries' runtime fields carry only their piece's leaf
   * subset under the whole-shape entry type — the same over-claim the per-group
   * plan's flat pieces already make; the second trust-boundary parse validates
   * the merge (design §4.1, open question 2). The WRITING surface spells the
   * portion as the `unwrapped` option; the `""` marker it folds into is
   * internal (ADR 0023).
   */
  const mixedPatch = z
    .object({
      hvac: z
        .object({
          equipmentType: z.string().nullable().optional(),
          fuel: z.string().nullable().optional(),
        })
        .strict()
        .optional(),
      note: z.string().nullable().optional(),
      yearBuilt: z.number().nullable().optional(),
    })
    .strict();
  type MixedValues = z.infer<typeof mixedPatch>;
  type MixedFields = Enveloped<MixedValues>;
  const mixedTarget: ExtractionTarget<MixedValues> = {
    name: "demo-mixed",
    extractionSchema: enveloped(mixedPatch),
    instructions: "Extract the hvac group and the loose leaves.",
  };

  const noteLeaf = { value: "a note", confidence: 0.9, sourceSpan: "the note" };
  const yearLeaf = { value: 1978, confidence: 0.8, sourceSpan: "built in 1978" };

  /**
   * One piece of a mixed composition: its runtime fields carry exactly the
   * piece's leaf subset, cast to the whole-shape entry type — the over-claim
   * named above. Covariance lets the same fake serve a named slot
   * (`Extractor<Pick<MixedFields, "hvac">>`) and the `unwrapped` slot
   * (`Extractor<MixedFields>`).
   */
  function pieceEntry(
    value: Partial<MixedFields>,
    statedEmptyGroups?: Readonly<Record<string, string>>,
  ): Extractor<MixedFields> & {
    readonly calls: readonly EntryCall[];
  } {
    const calls: EntryCall[] = [];
    return {
      extract: (t, options) => {
        calls.push({ text: t.text, options });
        return Promise.resolve({
          fields: value as MixedFields,
          usage: { calls: 1 },
          ...(statedEmptyGroups !== undefined ? { statedEmptyGroups } : {}),
        });
      },
      get calls() {
        return calls;
      },
    };
  }

  test("named keys plus `unwrapped` extract correctly: the unwrapped entry owns the unnamed remainder", async () => {
    // The inversion of the old blanket refusal: named keys cover hvac only, so
    // the unwrapped entry declares the rest of the schema (note, yearBuilt)
    // covered. No cast — arm B of the options union admits the mix.
    const extractor = groupedExtractor({
      target: mixedTarget,
      groups: { hvac: pieceEntry({ hvac: hvacLeaf("Boiler") }) },
      unwrapped: pieceEntry({ note: noteLeaf, yearBuilt: yearLeaf }),
    });

    const result = await extractor.extract(transcript);

    // The named entry merges under its key; the unwrapped entry assigns its
    // loose leaves flat — one merged whole, validated by the closing parse.
    expect(result.fields).toEqual({
      hvac: hvacLeaf("Boiler"),
      note: noteLeaf,
      yearBuilt: yearLeaf,
    });
    expect(result.usage).toEqual({ calls: 2 });
  });

  test("`unwrapped` beside named keys that already cover every schema key is refused as redundant", () => {
    // The narrowed refusal's surviving half: the named entries cover hvac AND
    // attic — every top-level key — so the unwrapped entry would declare
    // coverage the named entries already declare. The redundant combination
    // still COMPILES (an exhaustive `groups` is assignable to arm B's
    // `Partial`) and throws at runtime — exact parity with the map spelling.
    expect(() =>
      groupedExtractor({
        target,
        groups: {
          hvac: groupEntry("hvac", hvacLeaf("Boiler")),
          attic: groupEntry("attic", atticLeaf("10-12")),
        },
        unwrapped: {
          extract: () =>
            Promise.resolve({
              fields: { hvac: hvacLeaf("Boiler"), attic: atticLeaf("10-12") },
              usage: { calls: 1 },
            }),
        },
      }),
    ).toThrowError(/redundant/);
  });

  test("a named key the schema lacks still throws beside `unwrapped` — the extra-keys check is unchanged", () => {
    // The cast is the JS-caller path — `ghost` is not a key of the values type.
    const groups = {
      hvac: pieceEntry({ hvac: hvacLeaf("Boiler") }),
      ghost: pieceEntry({}),
    } as unknown as GroupMap<MixedValues>;
    expect(() =>
      groupedExtractor({
        target: mixedTarget,
        groups,
        unwrapped: pieceEntry({ note: noteLeaf, yearBuilt: yearLeaf }),
      }),
    ).toThrowError(/"ghost".*does not have/);
  });

  test('a literal "" key inside `groups` throws at construction — the unwrapped portion is spelled `unwrapped`', () => {
    // A caller passing both `unwrapped` and a literal "" key would lose one
    // silently whichever way the fold merged, and nothing else would catch it
    // (the extra-keys check filters "" out). The fold refuses instead. The cast
    // is the JS-caller path — "" is not a key of the values type.
    const groups = {
      hvac: pieceEntry({ hvac: hvacLeaf("Boiler") }),
      "": pieceEntry({ note: noteLeaf }),
    } as unknown as GroupMap<MixedValues>;
    expect(() =>
      groupedExtractor({
        target: mixedTarget,
        groups,
        unwrapped: pieceEntry({ yearBuilt: yearLeaf }),
      }),
    ).toThrowError(/may not carry/);
  });

  test("an `unwrapped` entry that does not deliver the unnamed remainder is accepted at construction and caught by the closing parse", async () => {
    // The coverage waiver's guarantee: with `unwrapped` present the
    // missing-keys check is waived — the entry IS the declaration — so a lying
    // declaration surfaces exactly where the fallback arm's always did: the
    // second trust-boundary parse (design §4.2).
    const lying = pieceEntry({ note: noteLeaf }); // yearBuilt never arrives
    const extractor = groupedExtractor({
      target: mixedTarget,
      groups: { hvac: pieceEntry({ hvac: hvacLeaf("Boiler") }) },
      unwrapped: lying,
    });

    await expect(extractor.extract(transcript)).rejects.toBeInstanceOf(SchemaParseError);
  });

  test("named keys without an `unwrapped` entry are still exhaustive at the type level — a missing group stays a compile error", () => {
    const hvac = pieceEntry({ hvac: hvacLeaf("Boiler") });
    // The widening must admit `unwrapped` beside named keys WITHOUT losing the
    // guard the named-only arm always had: named entries, no unwrapped, and a
    // key missing. The directive sits on the CALL now — the guard moved from
    // the map type to the options union — and tsc errors on an unused
    // directive, so `pnpm typecheck` is the proof the guard still fires. The
    // runtime check behind it is untouched (pinned above the fallback arm).
    // @ts-expect-error — `note`/`yearBuilt` uncovered and no `unwrapped` entry to own them.
    expect(() => groupedExtractor({ target: mixedTarget, groups: { hvac } })).toThrowError(
      /missing top-level key/,
    );
  });

  test('a partitioned `unwrapped` entry schedules its pieces after the named entries, sharing key "" with part/parts', async () => {
    const events: GroupUnit[] = [];
    const onUnit: ExtractionObserver<GroupUnit>["onUnit"] = (event) => events.push(event);
    const extractor = groupedExtractor({
      target: mixedTarget,
      groups: { hvac: pieceEntry({ hvac: hvacLeaf("Boiler") }) },
      unwrapped: [pieceEntry({ note: noteLeaf }), pieceEntry({ yearBuilt: yearLeaf })],
      onUnit,
    });

    const result = await extractor.extract(transcript);

    expect(result.fields).toEqual({
      hvac: hvacLeaf("Boiler"),
      note: noteLeaf,
      yearBuilt: yearLeaf,
    });
    // The schedule runs named entries in schema declaration order with the ""
    // pieces last (design §5.2). Pieces start concurrently, but every start
    // fires before its first await, so the start order IS the schedule order.
    const starts = events.filter((event) => event.phase === "start");
    expect(starts.map((event) => [event.key, event.part, event.parts])).toEqual([
      ["hvac", 1, 1],
      ["", 1, 2],
      ["", 2, 2],
    ]);
  });

  test("an `unwrapped` entry whose runtime fields carry a NAMED key throws at the merge, naming the key", async () => {
    // The hand-composition hazard the option opened: the unwrapped slot's type
    // is the whole-shape claim (`Extractor<MixedFields>`), so reusing the flat
    // fallback's natural construction — one single-shot extractor over the
    // whole target — builds an unwrapped entry whose whole-schema answer
    // carries hvac. The schedule assigns it last, so that answer silently
    // overwrote the named entry's already-merged value, and the closing parse
    // validates shape only: a shape-valid wrong value passed. The merge refuses
    // the class outright (ADR 0023's corrected cost paragraph).
    const extractor = groupedExtractor({
      target: mixedTarget,
      groups: { hvac: pieceEntry({ hvac: hvacLeaf("Boiler") }) },
      unwrapped: pieceEntry({ hvac: hvacLeaf("Furnace"), note: noteLeaf, yearBuilt: yearLeaf }),
    });

    const rejection = await extractor.extract(transcript).catch((cause: unknown) => cause);
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toMatch(/the unwrapped entry's result carries "hvac"/);
    expect((rejection as Error).message).toMatch(/unwrapped remainder/);
  });

  test("an `unwrapped` entry that states a NAMED group empty throws the same guard — the union assigned in arrival order", async () => {
    // The same root in the statedEmptyGroups union: it assigned in arrival
    // order, so an unwrapped entry stating a named group empty clobbered the
    // named entry's own statement nondeterministically. Same guard shape.
    const lying = pieceEntry({ note: noteLeaf, yearBuilt: yearLeaf }, { hvac: "no units" });
    const extractor = groupedExtractor({
      target: mixedTarget,
      groups: { hvac: pieceEntry({ hvac: hvacLeaf("Boiler") }) },
      unwrapped: lying,
    });

    const rejection = await extractor.extract(transcript).catch((cause: unknown) => cause);
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toMatch(
      /the unwrapped entry states the named group "hvac"/,
    );

    // No false positive: a named entry stating its OWN group empty beside an
    // unwrapped entry unions exactly as the named-only arm always did.
    const honest = groupedExtractor({
      target: mixedTarget,
      groups: { hvac: pieceEntry({ hvac: hvacLeaf("Boiler") }, { hvac: "none said" }) },
      unwrapped: pieceEntry({ note: noteLeaf, yearBuilt: yearLeaf }),
    });
    const result = await honest.extract(transcript);
    expect(result.statedEmptyGroups).toEqual({ hvac: "none said" });
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
