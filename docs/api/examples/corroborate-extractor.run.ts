/**
 * The runnable example behind docs/api/corroborate-extractor.html.
 *
 * Every export is a zero-argument function ending in `node:assert/strict`
 * assertions on exactly what the page prose claims. The runner
 * (`run-examples.test.ts`) executes each export in the Vitest `unit` project,
 * so a source change that breaks what the page says breaks the `test` stage.
 * Runs with no credentials and no network: the inner extractor is a fake and
 * the System One client is a hand-built double.
 */

import assert from "node:assert/strict";
import { z } from "zod";
import {
  type AnnotatedTranscript,
  type ExtractionTarget,
  fallbackExtractor,
  FakeExtractor,
  isTransientFailure,
  enveloped,
  TerminalError,
  terminalFallsThrough,
} from "@azx/ribo-core";
import {
  CorroborationRejectedError,
  corroborateExtractor,
  rejectUncorroboratedCommitments,
} from "@azx/ribo-extractor-systemone";
import type {
  SystemOneAnswer,
  SystemOneAnswers,
  SystemOneClient,
  SystemOneQuestions,
} from "@azx/ribo-systemone-managed";
import type { Extractor } from "@azx/ribo-core";

// Built through `enveloped()` so the census's questions run against the REAL
// extraction envelope — the shape the corroboration questions are read from.
const patch = z.object({
  hvac: z.object({
    systemType: z.enum(["furnace", "heat-pump"]).nullable().optional(),
    filterMerv: z.number().nullable().optional(),
  }),
  thermostat: z.string().nullable().optional(),
});
type Values = z.infer<typeof patch>;

const target: ExtractionTarget<Values> = {
  name: "corroboration-demo",
  extractionSchema: enveloped(patch),
  instructions: "extract the fields",
};

const transcript: AnnotatedTranscript = {
  text: "The home has a gas furnace with MERV 13 filters and an ecobee thermostat.",
  annotations: {},
};

/** A hand-built leaf envelope, the way model output arrives after parsing. */
const leaf = (value: unknown, sourceSpan: string | null) => ({
  value,
  confidence: 1,
  sourceSpan,
});

const supportedFields = {
  hvac: {
    systemType: leaf("furnace", "a gas furnace"),
    filterMerv: leaf(13, "MERV 13"),
  },
  thermostat: leaf("ecobee", "an ecobee thermostat"),
};

/** A hand-built SystemOneClient: answers every question with the next verdict. */
function fakeClient(verdicts: readonly string[]): {
  client: SystemOneClient;
  questions: string[];
} {
  const questions: string[] = [];
  let next = 0;
  const client: SystemOneClient = {
    ask: async <Q extends SystemOneQuestions>(
      _state: string,
      asked: Q,
    ): Promise<SystemOneAnswers<Q>> => {
      const answers: Record<string, SystemOneAnswer> = {};
      for (const id of Object.keys(asked)) {
        questions.push(id);
        const verdict = verdicts[next] ?? "supports";
        next += 1;
        answers[id] = {
          type: "choice",
          choice: verdict,
          confidence: 0.9,
          probabilities: {
            supports: verdict === "supports" ? 0.8 : 0.1,
            contradicts: verdict === "contradicts" ? 0.8 : 0.1,
            says_nothing: verdict === "says_nothing" ? 0.8 : 0.1,
          },
        };
      }
      return answers as unknown as SystemOneAnswers<Q>;
    },
  };
  return { client, questions };
}

export async function aCorroboratedResultIsReturnedUntouched(): Promise<void> {
  // #region usage
  const inner = new FakeExtractor(supportedFields);
  const { client } = fakeClient([]);
  const extractor = corroborateExtractor(inner, {
    target,
    client,
    policy: rejectUncorroboratedCommitments(0.25),
  });
  const result = await extractor.extract(transcript);
  // #endregion usage

  // The combinator judges, it does not transform: the fake's result comes back
  // exactly as it arrived.
  assert.equal(result.fields.hvac.systemType.value, "furnace");
  assert.equal(result.usage.calls, 0);
}

export async function anUncorroboratedResultIsRejectedTerminally(): Promise<void> {
  const inner = new FakeExtractor(supportedFields);
  // Every leaf's verdict is "says_nothing" — the transcript does not
  // corroborate what was committed.
  const { client } = fakeClient(["says_nothing", "says_nothing", "says_nothing"]);
  const extractor = corroborateExtractor(inner, {
    target,
    client,
    policy: rejectUncorroboratedCommitments(0.25),
  });

  await assert.rejects(extractor.extract(transcript), (error: unknown) => {
    assert.ok(error instanceof CorroborationRejectedError);
    // Terminal, deliberately: a transient rejection would make the ladder give
    // up and the relay re-run the whole extract step — including the rung that
    // just failed corroboration — on backoff, until dead.
    assert.ok(error instanceof TerminalError);
    assert.match(error.message, /corroboration rejected/);
    return true;
  });
}

export async function terminalRejectionFallsThroughToTheNextRung(): Promise<void> {
  const uncorroborated = new FakeExtractor(supportedFields);
  const { client } = fakeClient(["says_nothing", "says_nothing", "says_nothing"]);
  const corroboratedRung = corroborateExtractor(uncorroborated, {
    target,
    client,
    policy: rejectUncorroboratedCommitments(0.25),
  });
  const fallbackRung = new FakeExtractor({
    hvac: { systemType: leaf("heat-pump", "a heat pump"), filterMerv: leaf(8, "MERV 8") },
    thermostat: leaf("ecobee", "an ecobee thermostat"),
  });

  // The rejection is terminal, so the shipped default arbiter falls through —
  // the human never sees an uncorroborated draft (ADR 0021's measurement).
  const ladder = fallbackExtractor(
    [
      { strategy: "corroborated", extractor: corroboratedRung },
      { strategy: "fallback", extractor: fallbackRung },
    ],
    terminalFallsThrough,
  );
  const result = await ladder.extract(transcript);
  assert.equal(result.usage?.strategy, "fallback");
  assert.equal(result.fields.hvac.systemType.value, "heat-pump");
}

export async function theRatioThresholdsAShareNeverASingleLeaf(): Promise<void> {
  const inner = new FakeExtractor(supportedFields);
  // One contradicting leaf in a result of three — ADR 0021 measured per-leaf
  // scores landing on both sides of any threshold, so the shipped policy
  // aggregates: one bad leaf inside a 0.5 ratio does not reject.
  const { client } = fakeClient(["contradicts"]);
  const extractor = corroborateExtractor(inner, {
    target,
    client,
    policy: rejectUncorroboratedCommitments(0.5),
  });

  const result = await extractor.extract(transcript);
  assert.equal(result.fields.hvac.systemType.value, "furnace");
}

export async function anInnerFailurePropagatesUntouched(): Promise<void> {
  const inner: Extractor<Values> = {
    extract: async () => {
      throw new Error("uplink down");
    },
  };
  const { client } = fakeClient([]);
  const extractor = corroborateExtractor(inner, {
    target,
    client,
    policy: rejectUncorroboratedCommitments(0.25),
  });

  // A transient inner failure stays transient — an arbiter must give up rather
  // than try the next rung on the same downed transport.
  await assert.rejects(extractor.extract(transcript), /uplink down/);
  const probe = new Error("uplink down");
  assert.equal(isTransientFailure(probe), true);
}

export function aRowGranularityTargetIsRefusedAtConstruction(): void {
  // The combinator walks per-leaf envelopes; a "row" group would count nothing
  // while the result looked judged — so construction refuses it, before any
  // call is paid for.
  const rowPatch = z.object({
    rooms: z.array(z.object({ name: z.string().nullable().optional() })).optional(),
  });
  const rowTarget: ExtractionTarget<z.infer<typeof rowPatch>, { rooms: "row" }> = {
    name: "row-target",
    extractionSchema: enveloped(rowPatch, { provenance: { rooms: "row" } }),
    instructions: "",
  };
  assert.throws(() => {
    corroborateExtractor(new FakeExtractor({}), {
      target: rowTarget,
      client: fakeClient([]).client,
      policy: rejectUncorroboratedCommitments(0.25),
    });
  }, /per-leaf provenance envelope/);
}
