# SP2 — Wave 4: `consensusExtractor`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The substantial judging combinator. Run a list of candidates over the same transcript, compare them leaf by leaf, and null the value of every leaf they disagree about while keeping a citation — producing exactly the shape `gapFillExtractor` already re-asks about and review already flags.

**Architecture:** Every candidate settles independently; a failure is a missing sample rather than a failed run. The comparison walks the enveloped result with the leaf walk Wave 1 moved into core, and the decision at each leaf is a caller-supplied `ConsensusArbiter` that **returns an index into the samples it was handed**, so a policy cannot fabricate a value, a confidence or a citation — it can only point at evidence it was given.

**Tech Stack:** TypeScript, Vitest. No new dependencies.

**Spec:** `docs/roadmap/design/sp2-judging-combinators-design.md` (§4.1, §4.5)

> **This plan was revised after review.** Two claims in its first draft were false and are
> corrected below; the design doc is amended in Task 0 to match. If you are reading the design
> and the plan side by side and they still disagree, the plan wins and the disagreement is a bug
> — report it rather than picking one.

## Global Constraints

- **This is not `mapWithPool`.** That helper (`map-with-pool.ts`) rejects on the first failure **and calls `abort.abort()`, cancelling every sibling** — verified, not assumed. It is the exact opposite of what consensus needs. Candidates settle independently.
- **A cancellation stays a cancellation.** This is the first combinator in the repo that *must* catch, because `allSettled` catches for it. Every sibling gets the house rule for free by not catching (`validate-extractor.ts`, `budget-extractor.ts` both record it); this one has to implement it deliberately, and the way it fails is silent.
- **`assertLeafGranularity` runs at construction.** This walks per-leaf envelopes; a `"row"` or `"none"` target would be compared not at all while returning a result that looks judged.
- **Absent is not zero.** `ExtractionUsage`'s token members are optional and `cachedPromptTokens` documents the distinction as one that is "never collapsed." A `?? 0` sum breaks that.
- **It costs N times a single extraction**, and the file header says so in its first paragraph. A combinator that triples a bill without announcing it is a trap.
- Tests run from the repo root: `pnpm vitest run packages/<dir>/src/<file>.test.ts`.

---

### Task 0: Correct the design doc

The design contains two statements that are false against the repo's own compiler, plus one
stale option. Fix them first so the spec and the plan agree before anything is built.

**Files:** Modify `docs/roadmap/design/sp2-judging-combinators-design.md`

- [ ] **Step 1: Correct §4.1's parametricity claim**

  It currently says a parametric policy "cannot build the nulled envelope either — `null` is no
  more assignable to an opaque `T` than a literal is." That is **false**: `Extracted<T>` is
  `{ value: T | null; confidence: number; sourceSpan: string | null }` (`provenance.ts`, via
  `inner.nullable()`), so `null` is in the union for every `T`, and `sourceSpan` and `confidence`
  never mention `T` at all. Under the repo's own tsconfig, a cast-free conforming policy returning
  `{ value: null, confidence: 1, sourceSpan: null }` compiles clean, and so does
  `{ ...samples[0], sourceSpan: "a sentence nobody said" }`. Only the fabricated *non-null literal*
  is refused. Replace the claim with the index-returning signature Task 1 builds, and say plainly
  that the envelope-returning encoding bought one guarantee out of three.

- [ ] **Step 2: Correct §6's observer option**

  §6 lists an observer on the consensus options. Wave 2 settled that a wrapper which delegates and
  judges stays silent, and `budget-extractor.test.ts` pins the absence of an observer as the house
  rule. Replace it with `onContested`, and record why that escapes the rule: it is new vocabulary
  that no inner extractor emits, so it cannot double-count.

- [ ] **Step 3: Record the index-alignment limitation in §8**

  Comparing collection instances by index assumes every candidate enumerates instances in the
  same order, and **nothing enforces that**. Two samples that both found the same three rooftop
  units but listed them in a different order are compared unit-1-against-unit-3 and reported as
  three disagreements — data every sample agreed on, nulled. That is the safe direction, but it is
  a real limitation and a caller meeting it will think the combinator is broken.

  `majorityValues` has the **unsafe** version of the same problem and it must be written down:
  with samples `[A,B,C]`, `[A,C]` and `[A,B,C]`, the path `hvac.1.fuel` exists in all three, so it
  is compared — B, C, B — and the majority accepts **B**, a value for an entity the second sample
  does not have, carrying a citation from a sample that was quoting a different unit. The
  whole-collection contest rule in Task 2 closes this particular case (the lengths differ), but
  equal-length reordering defeats it and no rule here fixes that. `unanimousValues` fails safe and
  is the default for this reason.

- [ ] **Step 4: Commit**

---

### Task 1: `ConsensusArbiter` and the two shipped policies

**Files:**

- Create: `packages/ribo-core/src/consensus-arbiter.ts` and its test
- Modify: `packages/ribo-core/src/index.ts`, `packages/ribo-core/src/index.test.ts`

**Interfaces:**

- Produces: `ConsensusArbiter` — `(input: { path: LeafPath; samples: readonly Extracted<unknown>[] }) => { accept: number } | { contested: number }`. Plus `unanimousValues` and `majorityValues`.

**The policy returns an INDEX into `samples`, not an envelope.** This is the correction the
review forced, and the reason is worth stating once: the envelope-returning signature the first
draft specified was claimed to make fabrication a compile error, and it does so for exactly one
of the three members. `value: null` is assignable for every `T` because `Extracted<T>.value` is
`T | null`; `sourceSpan` and `confidence` do not mention `T`, so a policy could keep a real value
and invent the citation — the worst of the three on a combinator whose entire output contract is
"keeps a citation."

An index closes all three at once and needs no rank-2 generic: the policy never constructs an
`Extracted` at all, so whatever comes back is provably one of the envelopes it was handed. It is
also far easier to author against, and `samples` can be plain `Extracted<unknown>[]` because a
policy that only compares and points has no need to name the value's type.

**The range is checked by the combinator, not the compiler.** An index outside `samples` is a
policy bug; the combinator throws on it rather than clamping, because silently accepting sample 0
when the policy said 7 hides the bug forever.

**Two arms, `accept` and `contested`.** The combinator must know a leaf was contested in order to
report it, and an agreed-upon `null` and a fought-over leaf are byte-identical afterwards. On
`contested`, the named index supplies the **citation**; the combinator writes
`value: null, confidence: 0` over it.

**`unanimousValues`** accepts index 0 when every sample's `value` is equal, and contests index 0
otherwise. Equality is `Object.is`; a leaf value in this schema is a primitive or null by
construction, so state that rather than reaching for a deep comparison.

**`majorityValues`** accepts the first index holding a value that strictly more than half the
samples share; on a tie or no majority it contests index 0. See Task 0 Step 3 — this policy is
unsound over reordered collections and the design must say so.

- [ ] **Step 1: Write the failing tests**

  `unanimousValues` accepts on three identical values and contests on a dissenter; contests when
  one sample says `null` and another commits, since the model contradicting itself is the case
  this catches; `majorityValues` accepts 2-of-3, contests a three-way split, contests a 1-1 tie.
  Every returned index is in range for the samples given.

  **The pin that replaces the deleted type-level ones:** a policy cannot return anything that is
  not an index — assert on the *returned* index resolving to an envelope drawn from `samples`
  (identity, not equality). There is no `@ts-expect-error` pin in this task any more; the first
  draft's two were one false and one redundant.

- [ ] **Step 2: Run to verify they fail** — Expected: FAIL, the module does not exist.

- [ ] **Step 3: Implement** — [ ] **Step 4: Run, export, typecheck** — [ ] **Step 5: Commit**

---

### Task 2: `consensusExtractor`

**Files:**

- Create: `packages/ribo-core/src/consensus-extractor.ts` and its test
- Modify: `packages/ribo-core/src/index.ts`, `packages/ribo-core/src/index.test.ts`

**Interfaces:**

- Produces: `consensusExtractor<V, P>(candidates, options): Extractor<Enveloped<V, P>>`, with `target`, optional `arbiter` (default `unanimousValues`), `minSamples` (default 2), optional `concurrency`, optional `onContested`. Plus `ConsensusFailedError extends Error`.

**Construction-time checks.** `assertLeafGranularity` on the target; and **`minSamples` greater
than `candidates.length` throws**, because that combinator can never succeed and the failure is
free to catch here and expensive to diagnose at run time.

**Scheduling.** Run every candidate with `Promise.allSettled`, forwarding the caller's whole
`ExtractOptions` to each. Unbounded by default is right: the candidates are independent samples
and N is small by construction. `concurrency`, when supplied, chunks them for a host on a
rate-limited transport.

**Cancellation comes before the survivor count.** If the caller aborted, every candidate rejects
and the survivor count is zero — so the naive order reports "0 of 2 samples survived," inventing
a disagreement that never happened and losing the cancellation. Consult
`isCancellation(reason, callerOptions?.signal)` over the rejections **first** and rethrow that
rejection unchanged. `phased-extractor.ts` shows the mechanism.

**Below quorum throws `ConsensusFailedError`, and it is TRANSIENT** — i.e. it does **not** extend
`TerminalError`. Note this is the opposite of `ValidationRejectedError`, deliberately: validation
rejects because the *model* hallucinated, which the next rung might not, so the ladder should
continue. Consensus falls below quorum because *candidates failed*, which usually means the
transport is down — and `terminalFallsThrough` gives up on transient, which is the right answer
when the next rung shares that transport. Put both halves of that contrast in the class's doc
comment; a reader who knows only the validate precedent will think it is a mistake.

The error names how many survived and how many were required.

**Comparison.** Walk the **first surviving sample** with `mapExtractedLeaves`, which is
structure-preserving, so the walk and the rebuild are one pass rather than an enumeration
followed by a reconstruction. For each leaf path, read that path from every other survivor.

Three rules, in order:

1. **Collection length disagreement contests wholesale.** If any survivor's array length differs
   from the first survivor's at any array on the path, every leaf under that array is contested
   without consulting the arbiter. This is what stops index-wise comparison from pairing unit 1
   against unit 3 when a sample dropped an interior instance — the misalignment case that would
   otherwise let `majorityValues` accept a value for an entity that sample does not have.
2. **A path missing from any survivor is contested**, arbiter not consulted.
3. Otherwise the arbiter decides, with the samples in survivor order.

**Paths that exist only outside the first survivor's structure are DROPPED, and this is a
decision, not an oversight.** A fourth instance that only candidate 2 invented never enters the
output. The alternative — enumerating the union of paths — would materialise a hallucinated
instance into the result as a nulled row, which is worse: it puts a phantom in front of a
reviewer. The cost is that the first candidate is structurally authoritative, so **a caller
should put their most trusted candidate first**; say so in the options doc. Rule 1 means the
disagreement is still *reported* whenever it changes a count, so the drop is silent only when it
changes nothing a reviewer would act on.

**`onContested` is a notification, not a progress unit.** It fires once per contested leaf with
the path and the samples. It is deliberately not an `ExtractionObserver`: it has no unit
vocabulary, adds nothing to the `ExtractionUnit` union, and cannot double-count an inner
extractor's stream — which is what the wave-2 rule was protecting. Like every observer it must
not change behaviour, and **a throwing handler must not fail the run**. It is also the *only*
channel for the contested count: the design calls that the headline signal, and a host gets it by
counting callbacks. Say so in the doc comment rather than leaving a reader hunting for a tally.

**Usage.** `calls` sums across every survivor. Each token member sums **only across survivors
that reported it, and is omitted entirely if any survivor omitted it** — one on-device candidate
reporting no tokens beside two managed candidates reporting `cachedPromptTokens: 0` must not
produce `0`, which would assert the managed calls all missed cache while describing two runs out
of three. `engine` and `strategy` are omitted: they identify one producer and a consensus has
several. Note the downstream consequence in the doc comment — a consensus result persisted
through `toSessionExtractStep` carries no `extractedBy`, so the review card's "trust this less"
signal reads nothing rather than "several." That is acceptable and it should be a known
acceptance, not a discovery.

**`raw` and `statedEmptyGroups` are dropped.** Both describe one producer's run. Keeping the
first survivor's `statedEmptyGroups` would hand `validateExtractor`'s census, and the session
record, a roster of "there are none of these" spans that no other candidate agreed to — a
consensus result asserting an un-agreed claim. Dropping is the defensible choice; silence is not.

- [ ] **Step 1: Write the failing tests**

  With `FakeExtractor`s returning hand-built enveloped results: three agreeing candidates produce
  their agreed values and a citation; a leaf they disagree on comes back `value: null,
  confidence: 0` with the span from the sample the policy named; a candidate that rejects
  contributes nothing and the run still succeeds while two survive; **a rejecting candidate does
  not prevent the others from settling** — the pin that this is not `mapWithPool`; the caller's
  `signal` and `deadline` reach every candidate.

  **The cancellation pin:** abort the caller's signal so every candidate rejects, and assert the
  rejection `isCancellation` — *not* a `ConsensusFailedError`. This is the test that catches the
  bug this plan's first draft would have shipped.

  **The instance-count pin:** three candidates where one produces a fourth `hvac` instance the
  others do not. With the producer **second**, the fourth instance is absent from the output and
  the first three units' leaves are accepted. With the producer **first**, rule 1 fires and every
  leaf under `hvac` is contested. Pin both orderings — the first draft's single-ordering test
  passed a dropping implementation either way and proved nothing.

  **The misalignment pin:** samples `[A,B,C]`, `[A,C]`, `[A,B,C]` under `majorityValues`. Rule 1
  must contest the whole collection; without it the majority accepts B at index 1.

  **The usage pin:** one survivor omitting `cachedPromptTokens` while two report `0` produces a
  result with `cachedPromptTokens` **absent**, not `0`. Assert absence with `"x" in usage`, not
  `toBeUndefined` — the latter passes when the member vanishes from both sides.

  Below quorum throws `ConsensusFailedError` naming the counts, and it is **not** a
  `TerminalError`; a ladder test composing consensus inside `fallbackExtractor` shows a below-quorum
  consensus making the ladder **give up** rather than continue, which is the counterpart of the
  ladder pin `validateExtractor` already has. `onContested` fires once per contested leaf with its
  path; a throwing handler does not fail the run. `raw` and `statedEmptyGroups` are absent from
  the result even when every survivor carried them. Construction throws on a `"row"` target, and
  on `minSamples` above the candidate count.

- [ ] **Step 2: Run to verify they fail** — Expected: FAIL, the module does not exist.

- [ ] **Step 3: Implement** — [ ] **Step 4: Run, then the whole core suite** — [ ] **Step 5: Export, typecheck** — [ ] **Step 6: Commit**

---

### Task 3: Changeset and the full gate

- [ ] **Step 1: Add a changeset, committed before running status**

  `@azx/ribo-core` **minor**. Say what a consumer gains and what it costs: independent samples
  compared leaf by leaf, disagreement producing a null value with a kept citation — the shape
  gap-fill re-asks about and review flags — at N times the calls of a single extraction.

- [ ] **Step 2: Run the full gate** — `./check.sh`, `pnpm docs:build`, `pnpm changeset status --since=origin/main`.

- [ ] **Step 3: Commit**

---

## Out of scope

- Routing disagreements to review as a new contested state. A new envelope member, a new `ReviewField` state, a session-schema migration and playground UI. Nulling-with-citation reaches review through the existing null-leaf path.
- Order-insensitive collection comparison — matching instances by content rather than index. This is the real fix for the limitation Task 0 Step 3 records, and it is a design question (what identifies an instance?) rather than an implementation one.
- Exposing a contested *count* on `ExtractionResult`. That is a seam change; `onContested` carries it.
- Extending the comparison to row-provenance groups. The guard refuses those targets.
- Any measurement of whether agreement actually discriminates — the design's §8 names this as what would prove the whole combinator wrong, and it needs the corpus harness.
- Guide updates — the last SP2 wave.

## Notes for the reviewer

The first draft of this plan was wrong about its own central claim, so treat the corrected one
with the same suspicion. Specifically: is the index-returning arbiter genuinely fabrication-proof,
or is there a fourth hole neither of us has named? Is rule 1 (whole-collection contest on length
disagreement) actually sufficient to keep `majorityValues` from pairing mismatched instances, or
does an equal-length reordering still reach it — and if it does, is documenting that enough or
should `majorityValues` not ship at all? And is transient the right classification for
`ConsensusFailedError`, given it is the opposite of the sibling that shipped three weeks ago?
