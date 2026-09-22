/**
 * @file The corroboration census — a grounding census extended with a System
 * One verdict per committed leaf (ADR 0021). The judgement is ONE `choice`
 * question per committed leaf, over supports / contradicts / says_nothing:
 * TypeSafe's citation-check cookbook's step 2, which this repo lacked. The two
 * failing verdicts stay distinguishable because they invite different repairs
 * — a contradicted value is a re-ask; an unmentioned one is honestly null —
 * though no consumer is required to act on the distinction.
 *
 * This is a census, not a policy: it attaches the model's judgement to the
 * leaves and stops. Thresholds over the ratio, escalation and error types
 * belong to the combinator that will consume it, and nothing here reaches a
 * human — the verdict picks a rung, it is never shown (ADR 0021).
 */

import type { z } from "zod";

import { mapExtractedLeaves } from "@azx/ribo-core";
import type { CensusLeaf, GroundingCensus, GroundingCensusCounts, LeafPath } from "@azx/ribo-core";
import { choice } from "@azx/ribo-systemone-managed";
import type { ChoiceQuestion, ChoiceResponse, SystemOneClient } from "@azx/ribo-systemone-managed";

import { enumMembersAt } from "./enum-members.js";

/** The relationship a System One answer reports between transcript and recorded value. */
export type CorroborationVerdict = "supports" | "contradicts" | "says_nothing";

/**
 * A {@link CensusLeaf} plus the model's judgement of it. A leaf that was not
 * asked about — an uncommitted one, whose null value has nothing to
 * corroborate — carries `null` for all three rather than a fabricated verdict,
 * the same convention that keeps {@link CensusLeaf.groundedness} null for an
 * abstention.
 */
export interface CorroboratedLeaf extends CensusLeaf {
  readonly verdict: CorroborationVerdict | null;
  readonly confidence: number | null;
  readonly probabilities: Readonly<Record<CorroborationVerdict, number>> | null;
}

/** {@link GroundingCensusCounts} plus the corroboration tally. */
export interface CorroborationCensusCounts extends GroundingCensusCounts {
  /**
   * Committed leaves whose verdict came back as anything other than
   * `"supports"` — the count a policy thresholds (ADR 0021). `contradicts` and
   * `says_nothing` both count; a leaf still carrying a null verdict does not,
   * because no answer came back for it.
   */
  readonly uncorroborated: number;
}

/** The tally {@link corroborationCensus} produces. */
export interface CorroborationCensus extends GroundingCensus {
  readonly leaves: readonly CorroboratedLeaf[];
  readonly counts: CorroborationCensusCounts;
}

/** Options for {@link corroborationCensus}. */
export interface CorroborationCensusOptions {
  /** The System One client to ask — the host's proxied, credential-attaching one. */
  readonly client: SystemOneClient;
  /** The extraction schema the fields came from, for `enumMembersAt`. */
  readonly schema: z.ZodType;
  /** Forwards to the client — an abort tears down the in-flight request. */
  readonly signal?: AbortSignal;
  /**
   * The most questions one `ask` call carries. Unset means one call — the
   * client batches internally anyway.
   */
  readonly batchSize?: number;
}

/** The three options every corroboration question offers, described once, verbatim (ADR 0021). */
const VERDICT_CRITERIA = {
  supports: "the dictation states this value, or plainly means it",
  contradicts: "the dictation discusses this field but states a different value",
  says_nothing: "the dictation never discusses this field at all",
} as const;

type VerdictQuestion = ChoiceQuestion<typeof VERDICT_CRITERIA>;
type VerdictAnswer = ChoiceResponse<typeof VERDICT_CRITERIA>;

/**
 * Without the members the verifier reads the schema's own encoding as a
 * hallucination — a spoken "two years" recorded as the band `0-5` gets called
 * invented — so the enum statement and this clause are the measured part of
 * the question (ADR 0021).
 */
const ENCODING_CLAUSE =
  "The value is a code from that list, not a quote — a faithful encoding of what the auditor said counts as supporting it.";

const RELATIONSHIP_ASK = "What is the relationship between the dictation and the recorded value?";

const formatValue = (value: unknown): string =>
  typeof value === "string" ? JSON.stringify(value) : String(value);

/** A committed census leaf with everything its question needs, read from `fields`. */
interface AskedLeaf {
  /** The leaf's index in the census — its question id. */
  readonly index: number;
  readonly name: string;
  readonly value: unknown;
  readonly members: readonly string[] | null;
}

const instructionsFor = (leaf: AskedLeaf): string => {
  const recorded = `Recorded: "${leaf.name}" = ${formatValue(leaf.value)}.`;
  if (leaf.members === null) return [recorded, RELATIONSHIP_ASK].join("\n");
  return [
    `The field "${leaf.name}" records exactly one of: ${leaf.members.join(", ")}.`,
    recorded,
    ENCODING_CLAUSE,
    RELATIONSHIP_ASK,
  ].join("\n");
};

const pathKey = (path: LeafPath): string => JSON.stringify(path);

/**
 * Extend a {@link GroundingCensus} with a System One verdict per committed
 * leaf, asking ONE `choice` question over supports / contradicts /
 * says_nothing, told the leaf's enum members when it has them (ADR 0021).
 *
 * `census` is what `groundingCensus` returned for `fields`; the leaf VALUES
 * are not on the census — it carries paths — so they are read back out of
 * `fields` with `mapExtractedLeaves`, as a pure visitor that rebuilds nothing.
 * `transcript` is the canonical string, the same text `groundingCensus` took.
 *
 * Only committed leaves are asked about; every other leaf of the input census
 * still appears in the output, carrying nulls. Unbatched questions are split
 * across sequential `ask` calls of at most `batchSize` each — the client rate-
 * limits, so calls do not run concurrently.
 */
export const corroborationCensus = async (
  census: GroundingCensus,
  fields: unknown,
  transcript: string,
  options: CorroborationCensusOptions,
): Promise<CorroborationCensus> => {
  const values = new Map<string, unknown>();
  mapExtractedLeaves(fields, [], (leaf, path) => {
    values.set(pathKey(path), leaf.value);
    return leaf;
  });

  const asked: AskedLeaf[] = [];
  census.leaves.forEach((leaf, index) => {
    if (!leaf.committed) return;
    const value = values.get(pathKey(leaf.path));
    // A committed leaf whose value cannot be read means the census and the
    // fields disagree — there is no value to state, so it is skipped like an
    // abstention rather than asked about one.
    if (value === undefined) return;
    asked.push({
      index,
      name: String(leaf.path[leaf.path.length - 1]),
      value,
      members: enumMembersAt(options.schema, leaf.path),
    });
  });

  const answers = new Map<number, VerdictAnswer>();
  const size = options.batchSize === undefined ? asked.length : Math.max(1, options.batchSize);
  for (let start = 0; start < asked.length; start += size) {
    const chunk = asked.slice(start, start + size);
    const questions: Record<string, VerdictQuestion> = {};
    for (const leaf of chunk) {
      questions[String(leaf.index)] = choice(instructionsFor(leaf), VERDICT_CRITERIA);
    }
    const batch = await options.client.ask(transcript, questions, { signal: options.signal });
    for (const leaf of chunk) {
      const answer = batch[String(leaf.index)];
      if (answer === undefined) continue;
      answers.set(leaf.index, answer);
    }
  }

  const leaves: CorroboratedLeaf[] = census.leaves.map((leaf, index) => {
    const answer = answers.get(index);
    if (answer === undefined)
      return { ...leaf, verdict: null, confidence: null, probabilities: null };
    return {
      ...leaf,
      verdict: answer.choice,
      confidence: answer.confidence,
      probabilities: answer.probabilities,
    };
  });

  let uncorroborated = 0;
  for (const leaf of leaves) {
    if (leaf.verdict !== null && leaf.verdict !== "supports") uncorroborated += 1;
  }

  return {
    leaves,
    emptyGroups: census.emptyGroups,
    counts: { ...census.counts, uncorroborated },
  };
};
