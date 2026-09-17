import { describe, expect, test } from "vitest";

import { FakeExtractor } from "./extractor.js";
import type { Extractor, ExtractionResult, ExtractionUsage } from "./extractor.js";
import { fallbackExtractor } from "./fallback-extractor.js";
import { terminalFallsThrough } from "./arbitration.js";
import { TerminalError } from "./storage/backoff.js";
import type { AnnotatedTranscript } from "./annotated-transcript.js";
import { BudgetExceededError, budgetExtractor } from "./budget-extractor.js";

/**
 * Tests for `budgetExtractor` — the spend-ceiling detector
 * (`sp2-judging-combinators-design.md` §4.3, wave-3 plan Task 1).
 *
 * Two pins matter more than the rest:
 *
 * - **The inner extractor ran before the throw.** A wrapper sees only what an
 *   `Extractor` returns, so an overspend is detected after it was paid for. If
 *   this test ever fails, someone has turned the detector into a governor it
 *   cannot be — and a host reading the type would believe the guarantee.
 * - **The ladder test.** `BudgetExceededError` extends `TerminalError`, so under
 *   `terminalFallsThrough` a budget-rejected rung falls through to the next one.
 *   That is the entire story: the overspend is a property of the strategy, and
 *   the next run is a cheaper one.
 */

type Fields = { answer: string };

const FIELDS: Fields = { answer: "42" };

const transcript: AnnotatedTranscript = { text: "The heating system is a gas furnace.", annotations: {} };

/** Usage for a strategy that reported everything — the cache members included. */
const fullUsage: ExtractionUsage = {
  calls: 1,
  engine: "test-engine",
  strategy: "test-strategy",
  promptTokens: 500,
  completionTokens: 300,
  cachedPromptTokens: 200,
  cacheCreationPromptTokens: 100,
};

/** An inner extractor returning one fixed result object — so identity is assertable. */
const extractorReturning = (result: ExtractionResult<Fields>): Extractor<Fields> => ({
  extract: async () => result,
});

/** Catch the extraction's rejection, or fail the test if it did not throw. */
const rejectionOf = async (promise: Promise<unknown>): Promise<BudgetExceededError> => {
  try {
    await promise;
  } catch (caught) {
    return caught as BudgetExceededError;
  }
  throw new Error("expected the extraction to be rejected");
};

describe("budgetExtractor — ceilings", () => {
  test("a result under every ceiling is returned by identity", async () => {
    // Every observed value sits exactly AT its ceiling: a breach is strictly
    // greater, so at-the-ceiling passes.
    const innerResult: ExtractionResult<Fields> = {
      fields: FIELDS,
      usage: { calls: 2, promptTokens: 100, completionTokens: 50 },
    };
    const extractor = budgetExtractor(extractorReturning(innerResult), {
      maxCalls: 2,
      maxPromptTokens: 100,
      maxCompletionTokens: 50,
      maxTotalTokens: 150,
    });

    const result = await extractor.extract(transcript);

    expect(result).toBe(innerResult);
  });

  test("a result exceeding maxCalls throws, naming the member, the ceiling and the observed value", async () => {
    const extractor = budgetExtractor(
      extractorReturning({ fields: FIELDS, usage: { calls: 3 } }),
      { maxCalls: 1 },
    );

    const error = await rejectionOf(extractor.extract(transcript));

    expect(error).toBeInstanceOf(BudgetExceededError);
    // The cheap declaration pin; the behaviour pin is the ladder test below.
    expect(error).toBeInstanceOf(TerminalError);
    expect(error.member).toBe("maxCalls");
    expect(error.ceiling).toBe(1);
    expect(error.observed).toBe(3);
  });

  test("a result exceeding maxPromptTokens throws", async () => {
    const extractor = budgetExtractor(
      extractorReturning({ fields: FIELDS, usage: { calls: 1, promptTokens: 500 } }),
      { maxPromptTokens: 400 },
    );

    const error = await rejectionOf(extractor.extract(transcript));

    expect(error.member).toBe("maxPromptTokens");
    expect(error.ceiling).toBe(400);
    expect(error.observed).toBe(500);
  });

  test("a result exceeding maxCompletionTokens throws", async () => {
    const extractor = budgetExtractor(
      extractorReturning({ fields: FIELDS, usage: { calls: 1, completionTokens: 300 } }),
      { maxCompletionTokens: 200 },
    );

    const error = await rejectionOf(extractor.extract(transcript));

    expect(error.member).toBe("maxCompletionTokens");
    expect(error.ceiling).toBe(200);
    expect(error.observed).toBe(300);
  });

  test("maxTotalTokens sums promptTokens + completionTokens ONLY — the cache members are not added", async () => {
    // `cachedPromptTokens` and `cacheCreationPromptTokens` describe WHERE the
    // prompt tokens came from; summing all four double-counts the prompt. The
    // observed value is pinned so a "sum everything" implementation fails here
    // with 1100 rather than passing with a wrong number.
    const extractor = budgetExtractor(
      extractorReturning({ fields: FIELDS, usage: fullUsage }),
      { maxTotalTokens: 700 },
    );

    const error = await rejectionOf(extractor.extract(transcript));

    expect(error.member).toBe("maxTotalTokens");
    expect(error.ceiling).toBe(700);
    expect(error.observed).toBe(800);
  });

  test("maxTotalTokens is checked when only one of prompt/completion was reported", async () => {
    const extractor = budgetExtractor(
      extractorReturning({ fields: FIELDS, usage: { calls: 1, promptTokens: 600 } }),
      { maxTotalTokens: 500 },
    );

    const error = await rejectionOf(extractor.extract(transcript));

    expect(error.member).toBe("maxTotalTokens");
    expect(error.observed).toBe(600);
  });

  test("a result whose usage omits the token members does NOT throw under a token ceiling — the vacuous case", async () => {
    // Pinned so the behaviour is deliberate rather than incidental: a token
    // ceiling on a strategy that reports no tokens is vacuous, not strict —
    // `calls` is `ExtractionUsage`'s one required member, the on-device phases
    // report no tokens, and several paths report `{ calls: 1 }` and nothing
    // else. Throwing on an absent member would break those real runs; the doc
    // comment tells the host instead.
    const extractor = budgetExtractor(
      extractorReturning({ fields: FIELDS, usage: { calls: 1 } }),
      { maxPromptTokens: 10, maxCompletionTokens: 10, maxTotalTokens: 10 },
    );

    await expect(extractor.extract(transcript)).resolves.toHaveProperty("fields", FIELDS);
  });

  test("maxCalls: 0 throws for a result reporting one call — a ceiling of zero is a ceiling", async () => {
    // Zero is falsy; presence is `!== undefined`, never truthiness. A `||`
    // default here would silently permit every call.
    const extractor = budgetExtractor(
      extractorReturning({ fields: FIELDS, usage: { calls: 1 } }),
      { maxCalls: 0 },
    );

    const error = await rejectionOf(extractor.extract(transcript));

    expect(error.member).toBe("maxCalls");
    expect(error.ceiling).toBe(0);
    expect(error.observed).toBe(1);
  });

  test("the inner extractor ran before the throw — the pin on detect-not-prevent", async () => {
    // A wrapper sees only what an Extractor returns, so by the time the usage is
    // read the calls have been made and paid for. This asserts the spend
    // happened; if it ever fails, the combinator has become the governor the
    // design declined to build, and a host would be shipping a cost guarantee
    // on top of a detector.
    const inner = new FakeExtractor(FIELDS, { usage: { calls: 5 } });
    const extractor = budgetExtractor(inner, { maxCalls: 1 });

    await rejectionOf(extractor.extract(transcript));

    expect(inner.calls).toHaveLength(1);
  });
});

describe("budgetExtractor — delegating discipline", () => {
  test("the inner extractor receives the caller's signal AND deadline", async () => {
    // A delegating combinator forwards the options bag whole. This repo already
    // shipped a combinator that dropped it — without this assertion the
    // omission typechecks and every other test passes.
    const inner = new FakeExtractor(FIELDS, { usage: { calls: 1 } });
    const controller = new AbortController();
    const extractor = budgetExtractor(inner, { maxCalls: 10 });

    await extractor.extract(transcript, {
      signal: controller.signal,
      deadline: 1_234_567_890,
    });

    expect(inner.callOptions).toHaveLength(1);
    expect(inner.callOptions[0]?.signal).toBe(controller.signal);
    expect(inner.callOptions[0]?.deadline).toBe(1_234_567_890);
  });

  test("an inner error propagates by identity — not converted, not swallowed", async () => {
    const sentinel = new Error("transport down");
    const extractor = budgetExtractor(throwsExtractor(sentinel), { maxCalls: 1 });
    await expect(extractor.extract(transcript)).rejects.toBe(sentinel);
  });

  test("it emits no progress unit of its own — the options bag has no observer", async () => {
    // The wave-2 rule, pinned the same way `validate-extractor.test.ts` pins it:
    // a wrapper that delegates and judges makes no model call of its own, so it
    // has nothing to report — and reusing an existing unit type would make a
    // consumer double-count.
    const inner = new FakeExtractor(FIELDS, { usage: { calls: 1 } });
    const extractor = budgetExtractor(inner, {
      maxCalls: 10,
      // @ts-expect-error — the options bag has no observer: this combinator
      // reports nothing, and the type is what enforces it.
      onUnit: () => undefined,
    });

    await extractor.extract(transcript);

    expect(inner.calls).toHaveLength(1);
  });
});

describe("budgetExtractor — the behaviour the error class exists for", () => {
  test("a budget-wrapped over-spender falls through a terminalFallsThrough ladder to the second rung", async () => {
    // THE test. An overspend is a property of the strategy — retrying it
    // overspends again — so the rejection is terminal and the shipped default
    // arbiter continues to the next rung. A transient classification would give
    // up here instead, and the relay would re-run the expensive rung on backoff.
    const cheap = new FakeExtractor<Fields>(FIELDS, { usage: { calls: 1 } });
    const ladder = fallbackExtractor<Fields>(
      [
        {
          strategy: "expensive",
          extractor: budgetExtractor(new FakeExtractor(FIELDS, { usage: { calls: 5 } }), {
            maxCalls: 1,
          }),
        },
        { strategy: "cheap", extractor: cheap },
      ],
      terminalFallsThrough,
    );

    const result = await ladder.extract(transcript);

    // Assert on `.fields`, NOT identity: the engine returns a stamped shallow
    // copy of the accepted result (usage.strategy records the winner), so `toBe`
    // against the second rung's own object fails by construction.
    expect(result.fields).toEqual(FIELDS);
    expect(result.usage.strategy).toBe("cheap");
    expect(cheap.calls).toHaveLength(1);
  });
});

// --- helpers kept below the tests they serve --------------------------------

/** An inner extractor that throws one fixed error on every call. */
function throwsExtractor(error: Error): Extractor<never> {
  return {
    extract: async () => {
      throw error;
    },
  };
}
