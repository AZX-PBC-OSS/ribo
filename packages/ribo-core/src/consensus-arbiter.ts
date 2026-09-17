import type { LeafPath } from "./extracted-leaves.js";
import type { Extracted } from "./provenance.js";

/**
 * @file `ConsensusArbiter` — the leaf-level decision `consensusExtractor` hands
 * every leaf to (`sp2-judging-combinators-design.md` §4.1, wave-4 plan Task 1),
 * plus the two shipped policies.
 *
 * The signature is the decision this sub-project argues about: **a policy
 * returns an INDEX into `samples`, not an envelope.** The design's first draft
 * made the arbiter generic in the leaf's value type on the claim that `T`'s
 * opacity made fabrication a compile error — and that claim was false for two
 * of the three envelope members. `Extracted<T>` is
 * `{ value: T | null; confidence: number; sourceSpan: string | null }`
 * (`provenance.ts`, via `inner.nullable()`), so `null` is in the union for
 * every `T`, and `sourceSpan` and `confidence` never mention `T` at all: an
 * envelope-returning policy could keep a real value and invent the citation,
 * the worst of the three on a combinator whose entire output contract is
 * "keeps a citation". An index closes all three at once and needs no rank-2
 * generic — the policy never constructs an `Extracted` at all, so whatever it
 * names is provably an envelope it was handed. It is also far easier to author
 * against, and `samples` can be plain `Extracted<unknown>[]` because a policy
 * that only compares and points has no need to name the value's type.
 */

/**
 * What a {@link ConsensusArbiter} returns: accept the sample at the named
 * index, or contest it — in which case the named index supplies the **citation**
 * and the combinator writes `value: null, confidence: 0` over it. The policy
 * picks the span; the combinator does only what the index cannot say.
 *
 * Two arms, untagged, following `arbitration.ts`'s recorded reasoning: distinct
 * required key names (`accept`, `contested`) narrow correctly under `in`, and
 * retagging would buy no new safety. Two arms rather than one, even though an
 * index alone is smaller: the combinator must know a leaf was contested to
 * count them, and the contested count is the headline signal — unrecoverable
 * afterwards, because a leaf the samples agreed was `null` and one they fought
 * over are byte-identical.
 */
export type ConsensusVerdict = { readonly accept: number } | { readonly contested: number };

/**
 * The caller-supplied decision at one leaf of a consensus comparison.
 *
 * The policy owns the judgement; the combinator owns the walk, the range check
 * and the nulling. `samples` is one envelope per surviving candidate, in
 * survivor order, and is never empty when reached through `consensusExtractor`
 * — the quorum floor is one. The policy compares `value`s only: spans are
 * deliberately not compared, because two samples can quote different sentences
 * and mean the same value.
 *
 * **The range is checked by the combinator, not the compiler.** An index
 * outside `samples` is a policy bug; the combinator throws on it rather than
 * clamping, because silently accepting sample 0 when the policy said 7 hides
 * the bug forever.
 */
export type ConsensusArbiter = (input: {
  /** The structured path of the leaf being decided — never a formatted string. */
  readonly path: LeafPath;
  /** One envelope per surviving candidate, in survivor order. Never empty. */
  readonly samples: readonly Extracted<unknown>[];
}) => ConsensusVerdict;

/**
 * The default {@link ConsensusArbiter}: accept index 0 only when every
 * sample's `value` is equal; contest index 0 otherwise.
 *
 * Equality is `Object.is` — a leaf value in this schema is a primitive or null
 * by construction (`enveloped()` wraps enum, literal, string, number and
 * boolean leaves), so a deep comparison would buy nothing. `Object.is` also
 * makes a null beside a committed value a disagreement, which is the point:
 * the model contradicting itself is the case consensus exists to catch.
 *
 * Spans are not compared — see the {@link ConsensusArbiter} contract. This
 * policy fails safe under any reordering of collection instances, which is why
 * it is the default and `majorityValues` is not.
 */
export const unanimousValues: ConsensusArbiter = ({ samples }) => {
  // The head is the leaf every other sample is compared against. An empty hand
  // cannot arise through `consensusExtractor` (the quorum floor is one); if a
  // direct caller manages it anyway, the `contested` verdict's index 0 is
  // out of range and the combinator's range check reports it as the policy
  // bug it is.
  const first = samples[0];
  if (first === undefined) return { contested: 0 };
  for (const sample of samples) {
    if (!Object.is(sample.value, first.value)) return { contested: 0 };
  }
  return { accept: 0 };
};

/**
 * Accept the first index holding a value that strictly more than half the
 * samples share; on a tie or no majority, contest index 0.
 *
 * `null` is a value like any other here — a 2-of-3 null majority accepts the
 * agreed abstention with the first sample's citation — because
 * {@link unanimousValues} already accepts an all-null unanimous set, and the
 * two policies differ in threshold, not in what counts as a value.
 *
 * **Unsound over reordered collections** (design §8): with samples
 * `[A,B,C]`, `[A,C]` and `[A,B,C]`, the path `hvac.1.fuel` exists in all three,
 * so it is compared — B, C, B — and the majority accepts B, a value for an
 * entity the second sample does not have, carrying a citation from a sample
 * that was quoting a different unit. `consensusExtractor`'s whole-collection
 * contest on length disagreement closes the unequal-length case, but an
 * equal-length reordering defeats it and no rule fixes that. This is why
 * {@link unanimousValues} — which fails safe under any reordering — is the
 * default; point this policy at collections only when instance order is
 * meaningful or enforced upstream.
 */
export const majorityValues: ConsensusArbiter = ({ samples }) => {
  const half = samples.length / 2;
  for (let index = 0; index < samples.length; index++) {
    const candidate = samples[index]!.value;
    let count = 0;
    for (const sample of samples) {
      if (Object.is(sample.value, candidate)) count++;
    }
    if (count > half) return { accept: index };
  }
  return { contested: 0 };
};
