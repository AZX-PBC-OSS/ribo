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
