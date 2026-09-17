import { assertLeafGranularity } from "./assert-leaf-granularity.js";
import { isCancellation } from "./cancellation.js";
import { unanimousValues, type ConsensusArbiter } from "./consensus-arbiter.js";
import { isExtractedLeaf, mapExtractedLeaves, type LeafPath } from "./extracted-leaves.js";
import type { Enveloped, NoProvenance } from "./enveloped.js";
import type { AnnotatedTranscript } from "./annotated-transcript.js";
import type {
  ExtractOptions,
  Extractor,
  ExtractionResult,
  ExtractionTarget,
  ExtractionUsage,
} from "./extractor.js";
import type { Extracted } from "./provenance.js";

/**
 * @file `consensusExtractor` — the substantial judging combinator
 * (`sp2-judging-combinators-design.md` §4.1, ADR 0007). It runs a list
 * of candidate extractors over the same transcript, compares the survivors leaf
 * by leaf, and nulls the value of every leaf they disagree about while keeping
 * a citation — producing exactly the shape `gapFillExtractor` already re-asks
 * about and review already flags.
 *
 * **It costs N times a single extraction.** Every candidate runs to settlement,
 * so three candidates triple the bill and the wall clock of one. That is the
 * first paragraph on purpose: a combinator that multiplies a bill without
 * announcing it is a trap, and choosing candidates IS choosing a multiplier.
 *
 * The decisions most worth restating here, because the obvious-looking
 * "fix" breaks each of them:
 *
 * - **Candidates settle independently — this is not `mapWithPool`.** That
 *   helper rejects on the first failure and calls `abort.abort()`, cancelling
 *   every sibling; consensus needs the exact opposite, where a failure is a
 *   missing sample rather than a failed run. Scheduling is `Promise.allSettled`
 *   over every candidate, with the caller's whole options bag forwarded to each.
 * - **Cancellation comes before the survivor count.** `allSettled` catches for
 *   this combinator — the only one in the repo that must — so the way it fails
 *   is silent: checking the survivor count first would report "0 of 2
 *   survived" for an aborted run, inventing a disagreement that never happened
 *   and losing the cancellation. The rejections are consulted first, and a
 *   cancellation is rethrown unchanged.
 * - **The first survivor is structurally authoritative.** The comparison walks
 *   the first survivor's result; paths that exist only outside it are dropped.
 *   The alternative — enumerating the union of paths — would materialise a
 *   hallucinated instance into the result as a nulled row, putting a phantom in
 *   front of a reviewer. The cost is that the output's shape is the first
 *   candidate's shape, so a caller should put their most trusted candidate
 *   first (the `candidates` parameter says so too).
 * - **Usage sums across every survivor.** `calls` is always summed. Each token
 *   member sums only when EVERY survivor reported it and is omitted entirely
 *   otherwise — one on-device survivor beside two managed ones must not produce
 *   `cachedPromptTokens: 0`, which would assert the managed calls all missed
 *   cache while describing two runs out of three (absent means "not reported",
 *   never zero). `engine` and `strategy` are omitted: they identify one
 *   producer and a consensus has several. The downstream consequence is
 *   accepted, not accidental: a consensus result persisted through
 *   `toSessionExtractStep` carries no `extractedBy`, so the review card's
 *   "trust this less" signal reads nothing rather than "several".
 * - **`raw` and `statedEmptyGroups` are dropped.** Both describe one producer's
 *   run; keeping the first survivor's `statedEmptyGroups` would hand the census
 *   and the session record a roster of "there are none of these" spans that no
 *   other candidate agreed to — an un-agreed claim asserted as consensus.
 */

/**
 * A consensus run fell below quorum — fewer candidates survived than the
 * caller required, so there is nothing to compare.
 *
 * This is the deliberate OPPOSITE of `ValidationRejectedError`, and a reader
 * who knows only that precedent will think it is a mistake. Both halves of the
 * contrast:
 *
 * - Validation rejects because the **model** hallucinated — a property of the
 *   strategy's output, which the next rung might not have. Terminal is what
 *   makes `terminalFallsThrough` CONTINUE to that next rung.
 * - Consensus falls below quorum because **candidates failed** — usually the
 *   transport is down, and the next rung on the same engine shares that
 *   transport. So this error extends plain `Error`, which `isTransientFailure`
 *   classifies as transient by the default-true rule, and
 *   `terminalFallsThrough` gives up on transient: continuing would burn the
 *   next rung against the same downed transport, and retrying the whole
 *   extraction later, on backoff, is the right answer.
 */
export class ConsensusFailedError extends Error {
  override readonly name = "ConsensusFailedError";

  /** How many candidates survived — for a log reader re-deriving the decision. */
  readonly survived: number;

  /** How many the caller required — `minSamples`, floored at one. */
  readonly required: number;

  constructor(survived: number, required: number) {
    super(
      `consensusExtractor: ${survived} of ${required} required candidates survived — ` +
        "agreement between fewer is not consensus",
    );
    this.survived = survived;
    this.required = required;
  }
}

/**
 * The contested-leaf notification: fires once per contested leaf with the
 * leaf's structured path and the survivors' envelopes at that path, in survivor
 * order (fewer samples than survivors means some had nothing there).
 *
 * Deliberately NOT an `ExtractionObserver`: it has no unit vocabulary, adds
 * nothing to the `ExtractionUnit` union, and so cannot double-count an inner
 * extractor's stream — which is what ADR 0004 (a wrapper that delegates
 * and judges stays silent) protects. It escapes that rule because it reports
 * consensus's OWN verdicts, new vocabulary no inner extractor emits.
 *
 * It is also the ONLY channel for the contested count — the design's headline
 * signal. A host counts callbacks; there is no tally on `ExtractionResult`, and
 * adding one is a seam change deliberately not made. Like every observer it
 * must not change behaviour: a throwing handler is swallowed and the run
 * continues with that leaf still contested.
 */
export type OnContested = (path: LeafPath, samples: readonly Extracted<unknown>[]) => void;

/** What a caller supplies to {@link consensusExtractor}. */
export interface ConsensusExtractorOptions<V extends Record<string, unknown>, P = NoProvenance> {
  /**
   * The field knowledge the candidates were built against. Read ONCE, at
   * construction: {@link assertLeafGranularity} refuses a `"row"` or `"none"`
   * group before any call is made, because the comparison walks per-leaf
   * envelopes and would otherwise compare nothing while returning a result
   * that looks judged.
   */
  readonly target: ExtractionTarget<V, P>;
  /**
   * The caller-supplied leaf decision. Defaults to {@link unanimousValues} —
   * choosing a policy is an import, not a flag. On a contested verdict the
   * named index supplies the citation; the combinator writes `value: null,
   * confidence: 0` over it.
   */
  readonly arbiter?: ConsensusArbiter;
  /**
   * How many candidates must survive for the comparison to run at all.
   * Defaults to 2 — agreement between one sample and nothing is not agreement.
   * Declaring more than the candidate count throws at construction, because
   * that combinator can never succeed and the failure is free to catch here
   * and expensive to diagnose at run time. The quorum never falls below one,
   * whatever a caller declares: a zero-sample consensus has no first survivor
   * to walk.
   */
  readonly minSamples?: number;
  /**
   * Max candidates in flight at once. Unbounded by default, which is right:
   * the candidates are independent samples and N is small by construction.
   * Supply a bound for a host on a rate-limited transport — candidates then
   * run in chunks of this size, each chunk settling before the next starts.
   * A failing candidate still never cancels a sibling, chunked or not.
   */
  readonly concurrency?: number;
  /**
   * The contested-leaf notification — see {@link OnContested} for why it is
   * this shape and not an `ExtractionObserver`.
   */
  readonly onContested?: OnContested;
}

/**
 * Run a list of candidate extractors over the same transcript, compare the
 * survivors leaf by leaf, and null every leaf they disagree about while keeping
 * a citation.
 *
 * Per leaf, three rules in order: (1) a collection whose length any survivor
 * falls short of the first survivor's on contests wholesale, without consulting
 * the arbiter — index-wise comparison across a dropped instance would pair unit
 * 1 against unit 3; (2) a path missing from any survivor is contested, the
 * arbiter not consulted; (3) otherwise the arbiter decides, with the samples in
 * survivor order. An arbiter naming an index outside the samples throws rather
 * than clamps — silently accepting sample 0 would hide the policy bug forever.
 *
 * A candidate that rejects contributes nothing and never cancels its siblings;
 * below quorum the run throws {@link ConsensusFailedError} — transient, so a
 * ladder gives up rather than trying the next rung on the same downed
 * transport.
 */
export function consensusExtractor<V extends Record<string, unknown>, P = NoProvenance>(
  candidates: readonly Extractor<Enveloped<V, P>>[],
  options: ConsensusExtractorOptions<V, P>,
): Extractor<Enveloped<V, P>> {
  // Construction-time, before any call: a "row" or "none" group would make the
  // walk compare nothing while the result looked judged — silently blind
  // exactly where hallucination is worst.
  assertLeafGranularity(options.target.extractionSchema, { combinator: "consensusExtractor" });

  const minSamples = options.minSamples ?? 2;
  if (minSamples > candidates.length) {
    throw new Error(
      `consensusExtractor: minSamples (${minSamples}) is greater than the candidate count ` +
        `(${candidates.length}) — every run would fall below quorum, so the failure is caught ` +
        "here rather than diagnosed at run time.",
    );
  }
  if (options.concurrency !== undefined && options.concurrency < 1) {
    throw new Error(
      `consensusExtractor: concurrency (${options.concurrency}) is below one — no chunk ` +
        "size makes progress.",
    );
  }

  const arbiter = options.arbiter ?? unanimousValues;
  const quorum = Math.max(1, minSamples);

  return {
    extract: async (
      transcript: AnnotatedTranscript,
      callerOptions?: ExtractOptions,
    ): Promise<ExtractionResult<Enveloped<V, P>>> => {
      const settled = await settleCandidates(
        candidates,
        transcript,
        callerOptions,
        options.concurrency,
      );

      // Cancellation comes BEFORE the survivor count: with the caller's signal
      // aborted, every candidate rejects and the count is zero — reporting "0
      // of 2 survived" would invent a disagreement that never happened and
      // lose the cancellation. Rethrown unchanged, whatever its class.
      for (const outcome of settled) {
        if (
          outcome.status === "rejected" &&
          isCancellation(outcome.reason, callerOptions?.signal)
        ) {
          throw outcome.reason;
        }
      }

      const survivors = settled.flatMap((outcome) =>
        outcome.status === "fulfilled" ? [outcome.value] : [],
      );
      if (survivors.length < quorum) {
        throw new ConsensusFailedError(survivors.length, quorum);
      }

      // The quorum floor is one, so a first survivor always exists here.
      const first = survivors[0]!;
      const walk = (leaf: Extracted<unknown>, path: LeafPath): Extracted<unknown> =>
        decideLeaf(survivors, path, leaf, arbiter, options.onContested);
      // The walk is structure-preserving over data that entered as
      // `Enveloped<V, P>` and only ever replaces a leaf envelope with a leaf
      // envelope, so the rebuilt tree is still that shape — the same trust
      // story every combinator that rewrites a result tells.
      const fields = mapExtractedLeaves(first.fields, [], walk) as Enveloped<V, P>;

      return { fields, usage: mergeUsage(survivors) };
    },
  };
}

/** The usage members a consensus sums-or-omits; `calls` is handled separately. */
interface TokenTotals {
  promptTokens?: number;
  completionTokens?: number;
  cachedPromptTokens?: number;
  cacheCreationPromptTokens?: number;
}

const TOKEN_MEMBERS: readonly (keyof TokenTotals)[] = [
  "promptTokens",
  "completionTokens",
  "cachedPromptTokens",
  "cacheCreationPromptTokens",
];

/**
 * The survivors' combined usage — see the file header for the rules. `calls`
 * sums across every survivor; each token member sums only when every survivor
 * reported it and is omitted entirely otherwise; `engine` and `strategy` are
 * always omitted.
 */
const mergeUsage = (survivors: readonly ExtractionResult<unknown>[]): ExtractionUsage => {
  const usages = survivors.map((survivor) => survivor.usage);
  const tokens: TokenTotals = {};
  for (const member of TOKEN_MEMBERS) {
    let total = 0;
    let allReported = true;
    for (const reported of usages) {
      const value = reported[member];
      if (value === undefined) {
        allReported = false;
        break;
      }
      total += value;
    }
    if (allReported) tokens[member] = total;
  }
  return { calls: usages.reduce((sum, usage) => sum + usage.calls, 0), ...tokens };
};

/**
 * Every candidate over the same transcript, settling independently. Unbounded
 * unless `concurrency` is given, in which case the candidates run in order-
 * preserving chunks — each chunk settling before the next starts. A rejection
 * never stops the remaining candidates, within a chunk or across chunks.
 */
const settleCandidates = async <F>(
  candidates: readonly Extractor<F>[],
  transcript: AnnotatedTranscript,
  callerOptions: ExtractOptions | undefined,
  concurrency: number | undefined,
): Promise<PromiseSettledResult<ExtractionResult<F>>[]> => {
  const settleChunk = (
    chunk: readonly Extractor<F>[],
  ): Promise<PromiseSettledResult<ExtractionResult<F>>[]> =>
    Promise.allSettled(chunk.map((candidate) => candidate.extract(transcript, callerOptions)));
  if (concurrency === undefined) return settleChunk(candidates);
  const settled: PromiseSettledResult<ExtractionResult<F>>[] = [];
  for (let start = 0; start < candidates.length; start += concurrency) {
    settled.push(...(await settleChunk(candidates.slice(start, start + concurrency))));
  }
  return settled;
};

/** One step down a path — a key into an object or an index into an array. */
const descend = (node: unknown, segment: string | number): unknown => {
  if (node === null || typeof node !== "object") return undefined;
  return (node as Record<string | number, unknown>)[segment];
};

/** Resolve a structured leaf path from a root, or `undefined` when it is not there. */
const readPath = (root: unknown, path: LeafPath): unknown => {
  let node: unknown = root;
  for (const segment of path) node = descend(node, segment);
  return node;
};

/**
 * Can `other`'s structure be compared index-wise against the first survivor's
 * along this path? Every array on the path must cover the first survivor's
 * indices: a survivor that falls short has dropped an instance the walk is
 * about to pair across, so every leaf under that array is contested wholesale.
 * A LONGER survivor is not misalignment — the shared indices still pair
 * like-for-like, and its extra instances never enter the walk because the walk
 * is over the first survivor. Equal-length reorderings defeat this check (the
 * design's §8 records the hole); the check exists for the dropped-instance
 * case, which is the one that pairs different entities.
 */
const isAligned = (firstRoot: unknown, otherRoot: unknown, path: LeafPath): boolean => {
  let first: unknown = firstRoot;
  let other: unknown = otherRoot;
  for (const segment of path) {
    if (Array.isArray(first) && (!Array.isArray(other) || other.length < first.length)) {
      return false;
    }
    first = descend(first, segment);
    other = descend(other, segment);
  }
  return true;
};

/** The leaf path as a log-friendly dotted string — for an error line, not an address. */
const formatLeafPath = (path: LeafPath): string => path.map(String).join(".");

/**
 * Decide one leaf of the first survivor's walk against the other survivors.
 * Three rules, in order — see {@link consensusExtractor}. On any contest the
 * citation is the first survivor's envelope's span (the structurally
 * authoritative sample), except on an arbiter-contested verdict, where the
 * arbiter names the sample. Rules 1 and 2 do not consult the arbiter at all.
 */
const decideLeaf = (
  survivors: readonly ExtractionResult<unknown>[],
  path: LeafPath,
  firstLeaf: Extracted<unknown>,
  arbiter: ConsensusArbiter,
  onContested: OnContested | undefined,
): Extracted<unknown> => {
  const resolutions = survivors.map((survivor) => readPath(survivor.fields, path));

  const contested = (citation: Extracted<unknown>): Extracted<unknown> => {
    notifyContested(path, resolutions, onContested);
    return { value: null, confidence: 0, sourceSpan: citation.sourceSpan };
  };

  for (let index = 1; index < survivors.length; index++) {
    if (!isAligned(survivors[0]!.fields, survivors[index]!.fields, path)) {
      return contested(firstLeaf);
    }
  }

  const samples: Extracted<unknown>[] = [];
  for (const resolution of resolutions) {
    if (!isExtractedLeaf(resolution)) return contested(firstLeaf);
    samples.push(resolution);
  }

  const verdict = arbiter({ path, samples });
  const named = "accept" in verdict ? verdict.accept : verdict.contested;
  const citation = samples[named];
  if (citation === undefined) {
    throw new Error(
      `consensusExtractor: the arbiter named index ${named} at path "${formatLeafPath(path)}", ` +
        `which is outside the ${samples.length} samples it was handed — a policy bug, not a ` +
        "data problem. Thrown rather than clamped: silently accepting sample 0 would hide " +
        "the bug forever.",
    );
  }
  if ("accept" in verdict) return citation;
  return contested(citation);
};

/**
 * Fire the caller's notification once for one contested leaf. Samples are the
 * survivors' resolutions at the path that are actual envelopes, in survivor
 * order — fewer than the survivor count means the missing survivors had
 * nothing there. A throwing handler is swallowed: a notification must not
 * change behaviour, and the leaf stays contested either way.
 */
const notifyContested = (
  path: LeafPath,
  resolutions: readonly unknown[],
  onContested: OnContested | undefined,
): void => {
  if (!onContested) return;
  try {
    onContested(path, resolutions.filter(isExtractedLeaf));
  } catch {
    // Swallowed deliberately — see above.
  }
};
