/**
 * The runnable example behind docs/api/fallback-extractor.html.
 *
 * Every export is a zero-argument function ending in `node:assert/strict`
 * assertions on exactly what the page prose claims. The runner
 * (`run-examples.test.ts`) executes each export in the Vitest `unit` project,
 * so a source change that breaks what the page says breaks the `test` stage.
 * Runs with no credentials and no network: the strategies are fakes and inline
 * extractors, and no model is ever asked for anything.
 */

import assert from "node:assert/strict";
import {
  acceptAnySuccess,
  type AnnotatedTranscript,
  type Extractor,
  type ExtractionResult,
  fallbackExtractor,
  hedgedExtractor,
  isTransientFailure,
  raceExtractor,
  retryExtractor,
  SchemaParseError,
  terminalFallsThrough,
  TerminalError,
} from "@azx/ribo-core";

// A type alias, not an interface: `F` must carry an index signature, and only a
// type alias gets the implicit one.
type ContactFields = {
  name: { value: string; confidence: number; sourceSpan: string };
};

const fields: ContactFields = {
  name: { value: "Acme Heating", confidence: 0.9, sourceSpan: "Acme Heating" },
};

const transcript = (): AnnotatedTranscript => ({
  text: "Caller is Acme Heating, spoke to Sam",
  annotations: {},
});

/** A strategy that fails with the given error, every time. */
function failing(error: unknown): Extractor<ContactFields> {
  return {
    extract: async () => {
      throw error;
    },
  };
}

/** A strategy that succeeds immediately. */
function succeeding(): Extractor<ContactFields> {
  return { extract: async () => ({ fields, usage: { calls: 1 } }) };
}

export async function fallbackExtractorStampsTheWinningStrategy(): Promise<void> {
  // #region ladder
  // #region usage
  const managed = failing(new TerminalError("the request shape is structurally broken"));
  const ladder = fallbackExtractor(
    [
      { strategy: "managed-single-shot", extractor: managed },
      { strategy: "on-device", extractor: succeeding() },
    ],
    terminalFallsThrough,
  );
  const result = await ladder.extract(transcript());
  // #endregion usage

  // A terminal error is structural — exactly what a different strategy might
  // fix — so the default arbiter falls through, and the winner is stamped.
  assert.equal(result.usage?.strategy, "on-device");
  assert.equal(result.fields.name.value, "Acme Heating");
  // #endregion ladder
}

export async function aTransientErrorGivesUpInsteadOfBurningTheNextRung(): Promise<void> {
  const ladder = fallbackExtractor(
    [
      { strategy: "managed", extractor: failing(new Error("uplink down")) },
      { strategy: "on-device", extractor: succeeding() },
    ],
    terminalFallsThrough,
  );
  // The next strategy shares the down transport — giving up lets the relay
  // retry the whole extraction later, on the ladder's best rung.
  await assert.rejects(ladder.extract(transcript()), /uplink down/);
}

export async function aSchemaMissFallsThroughYetStaysRetryable(): Promise<void> {
  // A schema-parse error is sampled, not deterministic: the arbiter continues
  // to the next strategy, and the queue classifies it as retryable.
  assert.equal(isTransientFailure(new SchemaParseError("bad shape")), true);
  const ladder = fallbackExtractor(
    [
      { strategy: "managed", extractor: failing(new SchemaParseError("bad shape")) },
      { strategy: "on-device", extractor: succeeding() },
    ],
    terminalFallsThrough,
  );
  const result = await ladder.extract(transcript());
  assert.equal(result.usage?.strategy, "on-device");
}

export async function acceptAnySuccessContinuesPastAnythingUntilExhaustion(): Promise<void> {
  // terminalFallsThrough gave up on the transient error above;
  // acceptAnySuccess keeps going — the degraded-experience policy.
  const ladder = fallbackExtractor(
    [
      { strategy: "managed", extractor: failing(new Error("uplink down")) },
      { strategy: "on-device", extractor: succeeding() },
    ],
    acceptAnySuccess,
  );
  const result = await ladder.extract(transcript());
  assert.equal(result.usage?.strategy, "on-device");
}

export async function raceExtractorTakesTheFirstSettler(): Promise<void> {
  const slow: Extractor<ContactFields> = {
    extract: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { fields, usage: { calls: 1 } };
    },
  };
  const race = raceExtractor(
    [
      { strategy: "slow", extractor: slow },
      { strategy: "fast", extractor: succeeding() },
    ],
    acceptAnySuccess,
  );
  const result = await race.extract(transcript());
  assert.equal(result.usage?.strategy, "fast");
}

export async function retryExtractorRetriesTransientsAndNothingElse(): Promise<void> {
  let attempts = 0;
  const flaky: Extractor<ContactFields> = {
    extract: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("uplink down");
      return { fields, usage: { calls: 1 } };
    },
  };
  const wrapped = retryExtractor(flaky, { delay: async () => undefined });

  const result = await wrapped.extract(transcript());
  assert.equal(attempts, 3);
  assert.equal(result.fields.name.value, "Acme Heating");

  // A terminal failure is rethrown untouched, its retry budget unspent.
  const terminal = retryExtractor(failing(new TerminalError("no")), {
    delay: async () => undefined,
  });
  await assert.rejects(terminal.extract(transcript()), /no/);
}

export async function hedgedExtractorCancelsTheLoser(): Promise<void> {
  const stalled: Extractor<ContactFields> = {
    extract: (_transcript, options) =>
      new Promise<ExtractionResult<ContactFields>>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  };
  const hedge = succeeding();
  const winners: string[] = [];
  let scheduledDelay: number | undefined;

  const hedgedRun = hedgedExtractor(stalled, hedge, {
    delay: 50,
    // The injected timer fires immediately: the hedge is dispatched, the
    // still-stalled primary is cancelled, and the hedge's result wins.
    scheduleTimer: (fn, ms) => {
      scheduledDelay = ms;
      fn();
      return () => undefined;
    },
    onHedge: (event) => winners.push(event.winner ?? "none"),
  });

  const result = await hedgedRun.extract(transcript());
  assert.equal(scheduledDelay, 50);
  assert.equal(result.fields.name.value, "Acme Heating");
  assert.deepEqual(winners, ["hedge"]);
}

// #region defaults
export async function theDefaultsThePageQuotesComeFromTheSource(): Promise<void> {
  // The retry default is observed, not exported: with maxRetries omitted, a
  // transient failure gets three attempts (maxRetries 2 + the first). The
  // delay is injected and the backoff window shrunk so the run stays fast; the
  // page quotes the observed default next to this region.
  let attempts = 0;
  const flaky: Extractor<ContactFields> = {
    extract: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("uplink down");
      return { fields, usage: { calls: 1 } };
    },
  };
  await retryExtractor(flaky, { delay: async () => undefined, baseMs: 1 }).extract(transcript());
  assert.equal(attempts, 3);
}
// #endregion defaults
