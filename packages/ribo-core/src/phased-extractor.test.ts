import { describe, expect, test } from "vitest";
import { z } from "zod";

import type { AnnotatedTranscript } from "./annotated-transcript.js";
import { CancellationError } from "./cancellation.js";
import { enveloped } from "./enveloped.js";
import type { Enveloped, NoProvenance } from "./enveloped.js";
import type { ExtractionTarget } from "./extractor.js";
import type { PhaseUnit } from "./extraction-observer.js";
import { noteKey } from "./phase-notes.js";
import type { DeepPartial } from "./phase-draft.js";
import type { Phase } from "./phase.js";
import { phaseBuilder } from "./phase.js";
import { phasedExtractor } from "./phased-extractor.js";
import type { RetryBudget } from "./retry-budget.js";
import { TerminalQueueError } from "./queue/backoff.js";
import { SchemaParseError } from "./schema-parse-error.js";

// Hand-written phases over a tiny hand-written V — no adapter imports, no model. The
// engine's `run` is opaque to the combinator, so a scripted function stands in for a
// chat call everywhere below.
const testValuesSchema = z.object({ note: z.string().nullable().optional() });
type TestValues = z.infer<typeof testValuesSchema>;

const target: ExtractionTarget<TestValues> = {
  name: "test-target",
  extractionSchema: enveloped(testValuesSchema),
  instructions: "extract the note",
};

const transcript: AnnotatedTranscript = { text: "the attic is drafty", annotations: {} };

const build = phaseBuilder<TestValues, NoProvenance>();

const countKey = noteKey<number>("count");

/** A complete, valid envelope for the one leaf — what the closing parse needs to pass. */
function noteFields(value: string): DeepPartial<Enveloped<TestValues>> {
  return { note: { value, confidence: 1, sourceSpan: null } };
}

/** A phase whose merge writes a valid note envelope, so a run including it parses. */
function writerPhase(id: string, value: string): Phase<TestValues> {
  return build({
    id,
    plan: () => ["x"],
    run: async () => ({ value: 1 }),
    merge: (draft) => ({ ...draft, fields: noteFields(value) }),
  });
}

/** Collect `PhaseUnit` events through the run's observer. */
function collectEvents(): { events: PhaseUnit[]; onUnit: (event: PhaseUnit) => void } {
  const events: PhaseUnit[] = [];
  return { events, onUnit: (event) => events.push(event) };
}

describe("phasedExtractor — the spine", () => {
  test("two phases run in order, and the second's plan sees what the first's merge wrote", async () => {
    const plannedBySecond: string[] = [];
    const draftsSeenBySecondRuns: number[] = [];
    const first = build({
      id: "first",
      plan: () => ["a", "b"],
      run: async (item) => ({ value: item }),
      merge: (draft, results) => {
        const done = results.filter((r) => r.outcome === "result").length;
        return { ...draft, notes: draft.notes.set(countKey, done) };
      },
    });
    const second = build({
      id: "second",
      plan: (draft) => {
        const count = draft.notes.get(countKey) ?? 0;
        return Array.from({ length: count }, (_, i) => `item-${i}`);
      },
      run: async (item, draft) => {
        plannedBySecond.push(item);
        draftsSeenBySecondRuns.push(draft.notes.get(countKey) ?? -1);
        return { value: item };
      },
      merge: (draft) => ({ ...draft, fields: noteFields("from second") }),
    });
    const extractor = phasedExtractor<TestValues>({ target, phases: [first, second] });

    const result = await extractor.extract(transcript);

    // The second phase planned two items — one per result the first's merge recorded —
    // and each of its runs read the note the first's merge wrote.
    expect(plannedBySecond).toEqual(["item-0", "item-1"]);
    expect(draftsSeenBySecondRuns).toEqual([2, 2]);
    expect(result.fields.note?.value).toBe("from second");
  });

  test("a phase whose plan returns an empty array makes no call and emits no event", async () => {
    const { events, onUnit } = collectEvents();
    let ran = false;
    const worker = build({
      id: "worker",
      plan: () => ["a"],
      run: async () => ({ value: 1 }),
      merge: (draft) => ({ ...draft, fields: noteFields("done") }),
    });
    const empty = build({
      id: "empty",
      plan: () => [],
      run: async () => {
        ran = true;
        return { value: 1 };
      },
      merge: (draft) => draft,
    });
    const extractor = phasedExtractor<TestValues>({
      target,
      phases: [worker, empty],
      onUnit,
    });

    await extractor.extract(transcript);

    expect(ran).toBe(false);
    expect(events.every((e) => e.phaseId === "worker")).toBe(true);
    expect(events.length).toBeGreaterThan(0);
  });

  test("items within a phase run concurrently up to the phase's own limit", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const slow: Phase<TestValues> = build({
      id: "slow",
      concurrency: 2,
      plan: () => [1, 2, 3, 4, 5, 6],
      run: async (item) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return { value: item };
      },
      merge: (draft) => ({ ...draft, fields: noteFields("done") }),
    });
    const extractor = phasedExtractor<TestValues>({ target, phases: [slow] });

    await extractor.extract(transcript);

    expect(maxInFlight).toBe(2);
  });

  test("a phase with no declared concurrency inherits the run default of 4", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const slow: Phase<TestValues> = build({
      id: "slow",
      plan: () => [1, 2, 3, 4, 5, 6],
      run: async (item) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return { value: item };
      },
      merge: (draft) => ({ ...draft, fields: noteFields("done") }),
    });
    const extractor = phasedExtractor<TestValues>({ target, phases: [slow] });

    await extractor.extract(transcript);

    expect(maxInFlight).toBe(4);
  });

  test("the merged result is parsed against the schema — an invalid shape rejects with a SchemaParseError", async () => {
    const badFields = {
      note: { value: 42, confidence: 1, sourceSpan: null },
    } as unknown as DeepPartial<Enveloped<TestValues>>;
    const bad = build({
      id: "bad",
      plan: () => [1],
      run: async () => ({ value: 1 }),
      merge: (draft) => ({ ...draft, fields: badFields }),
    });
    const extractor = phasedExtractor<TestValues>({ target, phases: [bad] });

    await expect(extractor.extract(transcript)).rejects.toBeInstanceOf(SchemaParseError);
  });

  test("normalize runs once, after the merge and before the parse", async () => {
    // The merge writes NOTHING, so the closing parse would fail on the empty fields —
    // unless normalize ran first and its output is what the parse reads. If normalize
    // ran after the parse, this run would reject.
    let normalizeCalls = 0;
    const normalize = (
      _fields: DeepPartial<Enveloped<TestValues>>,
    ): DeepPartial<Enveloped<TestValues>> => {
      normalizeCalls += 1;
      return noteFields("from normalize");
    };
    const plain = build({
      id: "plain",
      plan: () => [1],
      run: async () => ({ value: 1 }),
      merge: (draft) => draft,
    });
    const extractor = phasedExtractor<TestValues>({ target, phases: [plain], normalize });

    const result = await extractor.extract(transcript);

    expect(normalizeCalls).toBe(1);
    expect(result.fields.note?.value).toBe("from normalize");
  });

  test("usage.calls is the sum across every PhaseOutput that reported one", async () => {
    const two = build({
      id: "two",
      plan: () => [1, 2],
      run: async () => ({ value: 1, usage: { calls: 2 } }),
      merge: (draft) => ({ ...draft, fields: noteFields("done") }),
    });
    const three = build({
      id: "three",
      plan: () => [1],
      run: async () => ({ value: 1, usage: { calls: 3 } }),
      merge: (draft) => draft,
    });
    const none = build({
      id: "none",
      plan: () => [1],
      run: async () => ({ value: 1 }),
      merge: (draft) => draft,
    });
    const extractor = phasedExtractor<TestValues>({ target, phases: [two, three, none] });

    const result = await extractor.extract(transcript);

    expect(result.usage.calls).toBe(7);
  });

  test("statedEmptyGroups is absent from the result when no phase set one", async () => {
    const extractor = phasedExtractor<TestValues>({ target, phases: [writerPhase("w", "v")] });

    const result = await extractor.extract(transcript);

    expect("statedEmptyGroups" in result).toBe(false);
  });

  test("statedEmptyGroups is present when a phase's merge recorded one", async () => {
    const roster = build({
      id: "roster",
      plan: () => [1],
      run: async () => ({ value: 1 }),
      merge: (draft) => ({ ...draft, statedEmptyGroups: { hvac: "none of these" } }),
    });
    const extractor = phasedExtractor<TestValues>({
      target,
      phases: [roster, writerPhase("w", "v")],
    });

    const result = await extractor.extract(transcript);

    expect(result.statedEmptyGroups).toEqual({ hvac: "none of these" });
  });

  test("raw carries through from a phase's merge", async () => {
    const raw = { some: "raw output" };
    const carrier = build({
      id: "carrier",
      plan: () => [1],
      run: async () => ({ value: 1 }),
      merge: (draft) => ({ ...draft, raw, fields: noteFields("done") }),
    });
    const extractor = phasedExtractor<TestValues>({ target, phases: [carrier] });

    const result = await extractor.extract(transcript);

    expect(result.raw).toBe(raw);
  });

  test("a mis-wired phase list throws at construction, before extract is ever called", () => {
    const duplicate = writerPhase("same", "a");
    expect(() => phasedExtractor<TestValues>({ target, phases: [duplicate, duplicate] })).toThrow(
      TypeError,
    );
    expect(() => phasedExtractor<TestValues>({ target, phases: [] })).toThrow(TypeError);
  });

  test("the spine emits a start and a done per item — pass from position, attempt fixed at 1, one id per item", async () => {
    const { events, onUnit } = collectEvents();
    const first = build({
      id: "first",
      plan: () => ["a", "b"],
      run: async (item) => ({ value: item }),
      merge: (draft) => ({ ...draft, fields: noteFields("done") }),
    });
    const second = build({
      id: "second",
      plan: () => [1],
      run: async (item) => ({ value: item }),
      merge: (draft) => draft,
    });
    const extractor = phasedExtractor<TestValues>({ target, phases: [first, second], onUnit });

    await extractor.extract(transcript);

    // Items within a phase run concurrently, so assert per item id, not on global order.
    const firstEvents = events.filter((e) => e.phaseId === "first");
    const secondEvents = events.filter((e) => e.phaseId === "second");
    const firstIds = [...new Set(firstEvents.map((e) => e.id))];
    expect(firstIds).toHaveLength(2);
    for (const id of firstIds) {
      const pair = firstEvents.filter((e) => e.id === id);
      expect(pair.map((e) => [e.phase, e.pass, e.attempt])).toEqual([
        ["start", 0, 1],
        ["done", 0, 1],
      ]);
    }
    // The second phase is pass 1 — its position in the list.
    expect(secondEvents.map((e) => [e.phase, e.pass, e.attempt])).toEqual([
      ["start", 1, 1],
      ["done", 1, 1],
    ]);
    // The id minted is a fresh opaque one from the shared counter.
    expect(firstEvents[0]!.id).toMatch(/^unit-/);
  });
});

describe("phasedExtractor — retry, failure policies, cancellation", () => {
  /** The canonical transient failure: a 503 the way a transport reports one. */
  function transient503(): Error {
    return Object.assign(new Error("service unavailable"), { status: 503 });
  }

  test("a transient item failure is retried and the run succeeds", async () => {
    const runCalls: number[] = [];
    let attempts = 0;
    const flaky = build({
      id: "flaky",
      plan: () => [1],
      run: async (item) => {
        runCalls.push(item);
        attempts += 1;
        if (attempts === 1) throw transient503();
        return { value: item };
      },
      merge: (draft) => ({ ...draft, fields: noteFields("done") }),
    });
    const extractor = phasedExtractor<TestValues>({
      target,
      phases: [flaky],
      delay: () => Promise.resolve(),
    });

    const result = await extractor.extract(transcript);

    expect(result.fields.note?.value).toBe("done");
    expect(runCalls).toHaveLength(2);
  });

  test("an item failing past its budget under abort fails the run and aborts in-flight siblings", async () => {
    const caller = new AbortController();
    const boom = transient503();
    const started: number[] = [];
    const siblingObserved: boolean[] = [];
    let signalSiblingDone: () => void = () => {};
    const siblingDone = new Promise<void>((resolve) => {
      signalSiblingDone = resolve;
    });
    const failing = build({
      id: "failing",
      concurrency: 2,
      maxRetries: 1,
      plan: () => [0, 1, 2, 3, 4, 5],
      run: async (item, _draft, ctx) => {
        started.push(item);
        if (item === 0) throw boom;
        // A sibling in flight: give the failure time to land, then observe.
        await new Promise((resolve) => setTimeout(resolve, 10));
        siblingObserved.push(ctx.signal?.aborted ?? false);
        signalSiblingDone();
        return { value: item };
      },
      merge: (draft) => ({ ...draft, fields: noteFields("done") }),
    });
    const extractor = phasedExtractor<TestValues>({
      target,
      phases: [failing],
      delay: () => Promise.resolve(),
    });

    // extract() rejects the instant the sibling fails (mapWithPool is Promise.all),
    // while the in-flight sibling's run is still settling — wait for it before
    // asserting what it observed.
    await expect(extractor.extract(transcript, { signal: caller.signal })).rejects.toBe(boom);
    await siblingDone;
    // The sibling in flight saw the pool's abort on its combined signal — and the
    // caller's own controller was never touched by the phase's failure.
    expect(siblingObserved).toEqual([true]);
    expect(caller.signal.aborted).toBe(false);
    // With concurrency 2 only the first two items were ever pulled (item 0 across its
    // two attempts, item 1 once); the abort stopped the pool before any further
    // item started.
    expect([...new Set(started)]).toEqual([0, 1]);
    expect(started).toHaveLength(3);
  });

  test("the same failure under skip reaches merge on the error arm and the run completes", async () => {
    const boom = transient503();
    const seen: { outcome: string; error?: unknown }[] = [];
    const runCalls: string[] = [];
    const skippable = build({
      id: "skippable",
      onItemFailure: "skip",
      maxRetries: 1,
      concurrency: 1,
      plan: () => ["bad", "good"],
      run: async (item) => {
        runCalls.push(item);
        if (item === "bad") throw boom;
        return { value: 1 };
      },
      merge: (draft, results) => {
        for (const r of results) {
          seen.push(
            r.outcome === "error" ? { outcome: "error", error: r.error } : { outcome: "result" },
          );
        }
        return { ...draft, fields: noteFields("done") };
      },
    });
    const extractor = phasedExtractor<TestValues>({
      target,
      phases: [skippable],
      delay: () => Promise.resolve(),
    });

    const result = await extractor.extract(transcript);

    expect(result.fields.note?.value).toBe("done");
    // The failed item was retried first (maxRetries: 1 → two attempts), then reached
    // merge on the error arm carrying its error; the sibling completed normally.
    // Outcomes arrive in item order — mapWithPool preserves it.
    expect(runCalls).toEqual(["bad", "bad", "good"]);
    expect(seen).toEqual([{ outcome: "error", error: boom }, { outcome: "result" }]);
  });

  test("a phase declaring maxRetries: 0 makes exactly one attempt", async () => {
    const boom = transient503();
    let runCalls = 0;
    const oneshot = build({
      id: "oneshot",
      maxRetries: 0,
      plan: () => [1],
      run: async () => {
        runCalls += 1;
        throw boom;
      },
      merge: (draft) => draft,
    });
    const extractor = phasedExtractor<TestValues>({
      target,
      phases: [oneshot],
      delay: () => Promise.resolve(),
    });

    await expect(extractor.extract(transcript)).rejects.toBe(boom);
    expect(runCalls).toBe(1);
  });

  test("a caller abort mid-phase rejects the run under skip policy, not a skipped item", async () => {
    const caller = new AbortController();
    const started: string[] = [];
    const skippable = build({
      id: "skippable",
      onItemFailure: "skip",
      concurrency: 1,
      plan: () => ["first", "second"],
      run: async (item) => {
        started.push(item);
        if (item === "first") {
          // The caller stops mid-phase; this item's own work still succeeds.
          caller.abort();
          return { value: 1 };
        }
        return { value: 2 };
      },
      merge: (draft) => ({ ...draft, fields: noteFields("done") }),
    });
    const extractor = phasedExtractor<TestValues>({ target, phases: [skippable] });

    await expect(extractor.extract(transcript, { signal: caller.signal })).rejects.toBeInstanceOf(
      CancellationError,
    );
    expect(started).toEqual(["first"]);
  });

  test("a caller abort mid-phase rejects the run under abort policy", async () => {
    const caller = new AbortController();
    const aborting = build({
      id: "aborting",
      concurrency: 1,
      plan: () => ["first", "second"],
      run: async (item) => {
        if (item === "first") {
          caller.abort();
          return { value: 1 };
        }
        return { value: 2 };
      },
      merge: (draft) => ({ ...draft, fields: noteFields("done") }),
    });
    const extractor = phasedExtractor<TestValues>({ target, phases: [aborting] });

    await expect(extractor.extract(transcript, { signal: caller.signal })).rejects.toBeInstanceOf(
      CancellationError,
    );
  });

  test("a CancellationError thrown by run rejects the run under skip policy", async () => {
    const cancellation = new CancellationError("the transport was stopped");
    const skippable = build({
      id: "skippable",
      onItemFailure: "skip",
      plan: () => [1],
      run: async () => {
        throw cancellation;
      },
      merge: (draft) => ({ ...draft, fields: noteFields("done") }),
    });
    const extractor = phasedExtractor<TestValues>({ target, phases: [skippable] });

    await expect(extractor.extract(transcript)).rejects.toBe(cancellation);
  });

  test("a CancellationError thrown by run rejects the run under abort policy", async () => {
    const cancellation = new CancellationError("the transport was stopped");
    const aborting = build({
      id: "aborting",
      plan: () => [1],
      run: async () => {
        throw cancellation;
      },
      merge: (draft) => ({ ...draft, fields: noteFields("done") }),
    });
    const extractor = phasedExtractor<TestValues>({ target, phases: [aborting] });

    await expect(extractor.extract(transcript)).rejects.toBe(cancellation);
  });

  test("the pre-attempt abort check does not count an attempt that never started", async () => {
    // A transient failure, then the caller aborts during the backoff: the loop reaches
    // its pre-attempt check, which must not count (or start) the prevented attempt —
    // the run rejects with the error that actually happened, and run was called once.
    const boom = transient503();
    const caller = new AbortController();
    let runCalls = 0;
    const flaky = build({
      id: "flaky",
      plan: () => [1],
      run: async () => {
        runCalls += 1;
        throw boom;
      },
      merge: (draft) => draft,
    });
    const extractor = phasedExtractor<TestValues>({
      target,
      phases: [flaky],
      maxRetries: 1,
      delay: async () => {
        caller.abort();
      },
    });

    await expect(extractor.extract(transcript, { signal: caller.signal })).rejects.toBe(boom);
    expect(runCalls).toBe(1);
  });
});

describe("phasedExtractor — the running deadline and the per-phase retry budget", () => {
  /** A controllable clock for the engine's `now` seam. */
  function makeClock(start: number) {
    let t = start;
    return {
      now: () => t,
      advance: (ms: number) => {
        t += ms;
      },
    };
  }

  /** Budget events captured from the run's RetryBudgetObserver. */
  function collectBudgets() {
    const events: RetryBudget[] = [];
    return { events, onRetryBudget: (event: RetryBudget) => events.push(event) };
  }

  test("each phase's budget is derived from the time remaining at its own boundary, and the events show it", async () => {
    // Backoff made negligible (baseMs 1, capMs 1) so the derivation arithmetic is
    // exact: perGroup(r) = (r+1)*10_000 + r.
    const clock = makeClock(1_000_000);
    const { events, onRetryBudget } = collectBudgets();
    const first = build({
      id: "first",
      plan: () => [1],
      run: async () => {
        // This phase consumes most of the deadline.
        clock.advance(80_000);
        return { value: 1 };
      },
      merge: (draft) => ({ ...draft, fields: noteFields("done") }),
    });
    const second = build({
      id: "second",
      plan: () => [1],
      run: async () => ({ value: 2 }),
      merge: (draft) => draft,
    });
    const extractor = phasedExtractor<TestValues>({
      target,
      phases: [first, second],
      maxRetries: 5,
      stepTimeoutMs: 100_000,
      perCallCeilingMs: 10_000,
      baseMs: 1,
      capMs: 1,
      now: clock.now,
      onRetryBudget,
    });

    const result = await extractor.extract(transcript);

    expect(result.fields.note?.value).toBe("done");
    // Phase 1: share = 100_000 / 2 = 50_000 → derived 3 (requested 5, reduced).
    // Phase 2: remaining 20_000 over 1 phase left → share 20_000 → derived 0.
    // The second boundary derived against the time its own predecessor left behind.
    expect(events).toEqual([
      { requested: 5, derived: 3, batches: 1, perCallCeilingMs: 10_000 },
      { requested: 5, derived: 0, batches: 1, perCallCeilingMs: 10_000 },
    ]);
  });

  test("onRetryBudget fires only for phases whose budget was reduced — not on every derivation", async () => {
    const { events, onRetryBudget } = collectBudgets();
    const first = build({
      id: "first",
      plan: () => [1],
      run: async () => ({ value: 1 }),
      merge: (draft) => ({ ...draft, fields: noteFields("done") }),
    });
    const second = build({
      id: "second",
      plan: () => [1],
      run: async () => ({ value: 2 }),
      merge: (draft) => draft,
    });
    const extractor = phasedExtractor<TestValues>({
      target,
      phases: [first, second],
      maxRetries: 2,
      perCallCeilingMs: 10_000,
      now: makeClock(1_000_000).now,
      onRetryBudget,
    });

    await extractor.extract(transcript);

    // Both phases fit their shares comfortably — a signal, not a metronome.
    expect(events).toEqual([]);
  });

  test("an inherited options.deadline earlier than now + stepTimeoutMs wins", async () => {
    const clock = makeClock(1_000_000);
    const { events, onRetryBudget } = collectBudgets();
    const single = build({
      id: "single",
      plan: () => [1],
      run: async () => ({ value: 1 }),
      merge: (draft) => ({ ...draft, fields: noteFields("done") }),
    });
    const extractor = phasedExtractor<TestValues>({
      target,
      phases: [single],
      maxRetries: 5,
      stepTimeoutMs: 100_000,
      perCallCeilingMs: 10_000,
      baseMs: 1,
      capMs: 1,
      now: clock.now,
      onRetryBudget,
    });

    // The inherited deadline (t0 + 50_000) is earlier than now + stepTimeoutMs
    // (t0 + 100_000) — the effective deadline is the min, so the share derives
    // against 50_000, not 100_000.
    const result = await extractor.extract(transcript, { deadline: 1_050_000 });

    expect(result.fields.note?.value).toBe("done");
    expect(events).toEqual([{ requested: 5, derived: 3, batches: 1, perCallCeilingMs: 10_000 }]);
  });

  test("each item's run receives the effective deadline in its context — now + stepTimeoutMs when nothing is inherited", async () => {
    const clock = makeClock(1_000_000);
    const deadlinesSeen: number[] = [];
    const single = build({
      id: "single",
      plan: () => [1],
      run: async (_item, _draft, ctx) => {
        deadlinesSeen.push(ctx.deadline ?? -1);
        return { value: 1 };
      },
      merge: (draft) => ({ ...draft, fields: noteFields("done") }),
    });
    const extractor = phasedExtractor<TestValues>({
      target,
      phases: [single],
      stepTimeoutMs: 100_000,
      now: clock.now,
    });

    await extractor.extract(transcript);

    expect(deadlinesSeen).toEqual([1_100_000]);
  });

  test("an inherited deadline earlier than now + stepTimeoutMs is what the run's context carries", async () => {
    const clock = makeClock(1_000_000);
    const deadlinesSeen: number[] = [];
    const single = build({
      id: "single",
      plan: () => [1],
      run: async (_item, _draft, ctx) => {
        deadlinesSeen.push(ctx.deadline ?? -1);
        return { value: 1 };
      },
      merge: (draft) => ({ ...draft, fields: noteFields("done") }),
    });
    const extractor = phasedExtractor<TestValues>({
      target,
      phases: [single],
      stepTimeoutMs: 100_000,
      now: clock.now,
    });

    await extractor.extract(transcript, { deadline: 1_050_000 });

    expect(deadlinesSeen).toEqual([1_050_000]);
  });

  test("a budget zero against the FULL step timeout throws TerminalQueueError when requireRetryBudget is set", async () => {
    // Single-phase list, so the pin is about the rule, not about which phase tripped
    // it. Even the full step timeout cannot fit one attempt at this ceiling — the
    // caller asked for retries that cannot fit any run of this shape.
    const single = build({
      id: "single",
      plan: () => [1],
      run: async () => ({ value: 1 }),
      merge: (draft) => ({ ...draft, fields: noteFields("done") }),
    });
    const extractor = phasedExtractor<TestValues>({
      target,
      phases: [single],
      maxRetries: 2,
      stepTimeoutMs: 10_000,
      perCallCeilingMs: 120_000,
      requireRetryBudget: true,
    });

    await expect(extractor.extract(transcript)).rejects.toBeInstanceOf(TerminalQueueError);
  });

  test("a budget zero only against the REMAINING time does not throw — it runs with no retries and reports", async () => {
    // The two-phase scenario: phase 2's share derives to zero from elapsed wall-clock,
    // which is transient — requireRetryBudget must not kill the session for it.
    const clock = makeClock(1_000_000);
    const { events, onRetryBudget } = collectBudgets();
    const first = build({
      id: "first",
      plan: () => [1],
      run: async () => {
        clock.advance(80_000);
        return { value: 1 };
      },
      merge: (draft) => ({ ...draft, fields: noteFields("done") }),
    });
    const second = build({
      id: "second",
      plan: () => [1],
      run: async () => ({ value: 2 }),
      merge: (draft) => draft,
    });
    const extractor = phasedExtractor<TestValues>({
      target,
      phases: [first, second],
      maxRetries: 5,
      stepTimeoutMs: 100_000,
      perCallCeilingMs: 10_000,
      baseMs: 1,
      capMs: 1,
      now: clock.now,
      requireRetryBudget: true,
      onRetryBudget,
    });

    const result = await extractor.extract(transcript);

    expect(result.fields.note?.value).toBe("done");
    expect(events.at(-1)?.derived).toBe(0);
  });
});

describe("phasedExtractor — the unit stream and the produces check", () => {
  function transient503(): Error {
    return Object.assign(new Error("service unavailable"), { status: 503 });
  }

  test("a four-phase list reports pass 3 on the last phase's events", async () => {
    const phases = ["p0", "p1", "p2", "p3"].map((id, i) =>
      build({
        id,
        plan: () => [1],
        run: async () => ({ value: i }),
        merge: (draft) => (id === "p3" ? { ...draft, fields: noteFields("done") } : draft),
      }),
    );
    const { events, onUnit } = collectEvents();
    const extractor = phasedExtractor<TestValues>({ target, phases, onUnit });

    await extractor.extract(transcript);

    const lastPasses = events.filter((e) => e.phaseId === "p3").map((e) => e.pass);
    expect(lastPasses).toEqual([3, 3]);
    // And every phase's events carry its own phaseId.
    expect(new Set(events.map((e) => e.phaseId))).toEqual(new Set(["p0", "p1", "p2", "p3"]));
  });

  test("attempt is 1 on an item's first try and increments per engine retry", async () => {
    const { events, onUnit } = collectEvents();
    let flakyCalls = 0;
    const flaky = build({
      id: "flaky",
      plan: () => [1],
      run: async () => {
        flakyCalls += 1;
        if (flakyCalls === 1) throw transient503();
        return { value: 1 };
      },
      merge: (draft) => ({ ...draft, fields: noteFields("done") }),
    });
    const extractor = phasedExtractor<TestValues>({
      target,
      phases: [flaky],
      maxRetries: 2,
      delay: () => Promise.resolve(),
      onUnit,
    });

    await extractor.extract(transcript);

    const attempts = events.map((e) => [e.phase, e.attempt]);
    expect(attempts).toEqual([
      ["start", 1],
      ["error", 1],
      ["start", 2],
      ["done", 2],
    ]);
  });

  test("attempt does not move for calls a run makes internally", async () => {
    const { events, onUnit } = collectEvents();
    let internalCalls = 0;
    const doubleRun = build({
      id: "double-run",
      plan: () => [1],
      run: async () => {
        // Two internal "model calls" inside one run — the engine did not make them
        // and cannot bound them, so they are not attempts.
        internalCalls += 1;
        internalCalls += 1;
        return { value: internalCalls };
      },
      merge: (draft) => ({ ...draft, fields: noteFields("done") }),
    });
    const extractor = phasedExtractor<TestValues>({
      target,
      phases: [doubleRun],
      onUnit,
    });

    await extractor.extract(transcript);

    expect(internalCalls).toBe(2);
    // Exactly one start, attempt 1 — the internals did not become attempts.
    expect(events.map((e) => [e.phase, e.attempt])).toEqual([
      ["start", 1],
      ["done", 1],
    ]);
  });

  test("key and leaf come from describeItem, and default to an empty key with no leaf", async () => {
    const { events, onUnit } = collectEvents();
    const described = build({
      id: "described",
      plan: () => ["g1"],
      run: async () => ({ value: 1 }),
      merge: (draft) => ({ ...draft, fields: noteFields("done") }),
      describeItem: (item) => ({ key: item, leaf: "note" }),
    });
    const bare = build({
      id: "bare",
      plan: () => [1],
      run: async () => ({ value: 1 }),
      merge: (draft) => draft,
    });
    const extractor = phasedExtractor<TestValues>({
      target,
      phases: [described, bare],
      onUnit,
    });

    await extractor.extract(transcript);

    const describedEvents = events.filter((e) => e.phaseId === "described");
    expect(describedEvents.map((e) => ({ key: e.key, leaf: e.leaf }))).toEqual([
      { key: "g1", leaf: "note" },
      { key: "g1", leaf: "note" },
    ]);
    const bareEvents = events.filter((e) => e.phaseId === "bare");
    expect(bareEvents.map((e) => ({ key: e.key, leaf: e.leaf }))).toEqual([
      { key: "", leaf: undefined },
      { key: "", leaf: undefined },
    ]);
  });

  test("an aborted sibling emits no start event for an attempt that never began", async () => {
    const { events, onUnit } = collectEvents();
    const terminal = new TerminalQueueError("deterministic failure");
    const boom = transient503();
    // Item "zero" fails transiently and sleeps in its backoff on this gate; item
    // "one" fails terminally on its first attempt, which aborts the pool. When the
    // gate releases, "zero"'s loop reaches its pre-attempt check — prevented.
    let releaseBackoff: () => void = () => {};
    const backoffGate = new Promise<void>((resolve) => {
      releaseBackoff = resolve;
    });
    const phase = build({
      id: "mixed",
      concurrency: 2,
      maxRetries: 2,
      plan: () => ["zero", "one"],
      describeItem: (item) => ({ key: item }),
      run: async (item) => {
        if (item === "zero") throw boom; // transient — retries into the gate
        throw terminal; // terminal — aborts the pool on its first attempt
      },
      merge: (draft) => ({ ...draft, fields: noteFields("done") }),
    });
    const extractor = phasedExtractor<TestValues>({
      target,
      phases: [phase],
      delay: () => backoffGate,
      onUnit,
    });

    await expect(extractor.extract(transcript)).rejects.toBe(terminal);
    releaseBackoff();
    // Let "zero"'s worker settle past the pre-attempt check.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Both items started attempt 1; nothing announced an attempt 2 for "zero" —
    // the pre-attempt abort check prevented it before onAttempt could fire.
    const starts = events.filter((e) => e.phase === "start");
    expect(starts.map((e) => [e.key, e.attempt])).toEqual([
      ["zero", 1],
      ["one", 1],
    ]);
    // And no error event announces an attempt that never began either — "zero"'s
    // error names the attempt that actually ran.
    const errors = events.filter((e) => e.phase === "error");
    expect(errors.map((e) => [e.key, e.attempt]).sort()).toEqual([
      ["one", 1],
      ["zero", 1],
    ]);
  });

  test("id is stable across a retried item's attempts", async () => {
    const { events, onUnit } = collectEvents();
    let calls = 0;
    const flaky = build({
      id: "flaky",
      plan: () => [1],
      run: async () => {
        calls += 1;
        if (calls === 1) throw transient503();
        return { value: 1 };
      },
      merge: (draft) => ({ ...draft, fields: noteFields("done") }),
    });
    const extractor = phasedExtractor<TestValues>({
      target,
      phases: [flaky],
      maxRetries: 2,
      delay: () => Promise.resolve(),
      onUnit,
    });

    await extractor.extract(transcript);

    // start(a1), error(a1), start(a2), done(a2) — one id across all four, minted
    // before the retry loop, so a consumer correlates the unit's whole life.
    expect(events.map((e) => [e.phase, e.attempt, e.id])).toEqual([
      ["start", 1, events[0]!.id],
      ["error", 1, events[0]!.id],
      ["start", 2, events[0]!.id],
      ["done", 2, events[0]!.id],
    ]);
  });

  test("usage reaches done from the item's PhaseOutput, and is omitted when the output reported none", async () => {
    const { events, onUnit } = collectEvents();
    const withTokens = build({
      id: "with-tokens",
      plan: () => [1],
      run: async () => ({
        value: 1,
        usage: { calls: 1, promptTokens: 120, completionTokens: 30 },
      }),
      merge: (draft) => ({ ...draft, fields: noteFields("done") }),
    });
    const withoutTokens = build({
      id: "without-tokens",
      plan: () => [1],
      run: async () => ({ value: 1 }),
      merge: (draft) => draft,
    });
    const extractor = phasedExtractor<TestValues>({
      target,
      phases: [withTokens, withoutTokens],
      onUnit,
    });

    await extractor.extract(transcript);

    const doneEvents = events.filter((e) => e.phase === "done");
    expect(doneEvents.map((e) => e.usage)).toEqual([
      { inputTokens: 120, outputTokens: 30 },
      undefined,
    ]);
    // Omitted, not zeroed — the member is absent when nothing reported it.
    expect("usage" in doneEvents[1]!).toBe(false);
  });

  test("token totals sum across phases, not just calls", async () => {
    const a = build({
      id: "a",
      plan: () => [1],
      run: async () => ({
        value: 1,
        usage: { calls: 1, promptTokens: 100, completionTokens: 10 },
      }),
      merge: (draft) => ({ ...draft, fields: noteFields("done") }),
    });
    const b = build({
      id: "b",
      plan: () => [1],
      run: async () => ({
        value: 1,
        usage: { calls: 1, promptTokens: 50, completionTokens: 5 },
      }),
      merge: (draft) => draft,
    });
    const extractor = phasedExtractor<TestValues>({ target, phases: [a, b] });

    const result = await extractor.extract(transcript);

    expect(result.usage.calls).toBe(2);
    expect(result.usage.promptTokens).toBe(150);
    expect(result.usage.completionTokens).toBe(15);
  });

  test("a phase declaring produces whose merge does not write it throws at that boundary, naming phase and key", async () => {
    let secondRan = false;
    const liar = build({
      id: "liar",
      produces: ["roster"],
      plan: () => [1],
      run: async () => ({ value: 1 }),
      merge: (draft) => draft, // declares "roster", writes nothing
    });
    const second = build({
      id: "second",
      requires: ["roster"],
      plan: () => [1],
      run: async () => {
        secondRan = true;
        return { value: 1 };
      },
      merge: (draft) => ({ ...draft, fields: noteFields("done") }),
    });
    const extractor = phasedExtractor<TestValues>({ target, phases: [liar, second] });

    const rejection = await extractor.extract(transcript).catch((cause: unknown) => cause);
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toContain("liar");
    expect((rejection as Error).message).toContain("roster");
    // Thrown at THAT phase's boundary — the next phase never ran.
    expect(secondRan).toBe(false);
  });

  test("a phase declaring produces and actually writing it passes the check", async () => {
    const honest = build({
      id: "honest",
      produces: ["roster"],
      plan: () => [1],
      run: async () => ({ value: 1 }),
      merge: (draft) => ({ ...draft, notes: draft.notes.set(noteKey<unknown>("roster"), true) }),
    });
    const consumer = build({
      id: "consumer",
      requires: ["roster"],
      plan: () => [1],
      run: async () => ({ value: 1 }),
      merge: (draft) => ({ ...draft, fields: noteFields("done") }),
    });
    const extractor = phasedExtractor<TestValues>({ target, phases: [honest, consumer] });

    const result = await extractor.extract(transcript);

    expect(result.fields.note?.value).toBe("done");
  });
});
