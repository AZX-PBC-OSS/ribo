# SP2 — Wave 4: `consensusExtractor`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The substantial judging combinator. Run a list of candidates over the same transcript, compare them leaf by leaf, and null the value of every leaf they disagree about while keeping a citation — producing exactly the shape `gapFillExtractor` already re-asks about and review already flags.

**Architecture:** Every candidate settles independently; a failure is a missing sample rather than a failed run. The comparison walks the enveloped result with the leaf walk Wave 1 moved into core, and the decision at each leaf is a caller-supplied `ConsensusArbiter` that is **generic in the leaf's value type**, so a conforming policy cannot fabricate a value no sample returned — the type enforces what the design's §3 previously only promised.

**Tech Stack:** TypeScript, Vitest. No new dependencies.

**Spec:** `docs/roadmap/design/sp2-judging-combinators-design.md` (§4.1, §4.5)

## Global Constraints

- **This is not `mapWithPool`.** That helper rejects on the first failure and aborts every sibling, which is the opposite of what consensus needs, and it has no channel for forwarding a caller's signal. Candidates settle independently.
- **Sample counts are per PATH, not per candidate.** Two samples can disagree about how many instances a collection group holds, so a path may exist in one sample and not another. A path seen by fewer than all survivors is contested *before* the arbiter is consulted — treating a single-sample path as unanimous would accept a hallucinated instance, with citations, from exactly the disagreement this combinator exists to catch.
- **`assertLeafGranularity` runs at construction.** This walks per-leaf envelopes; a `"row"` or `"none"` target would be compared not at all while returning a result that looks judged.
- **It costs N times a single extraction**, and the file header says so in its first paragraph. A combinator that triples a bill without announcing it is a trap.
- Tests run from the repo root: `pnpm vitest run packages/<dir>/src/<file>.test.ts`.

---

### Task 1: `ConsensusArbiter` and the two shipped policies

**Files:**

- Create: `packages/ribo-core/src/consensus-arbiter.ts` and its test
- Modify: `packages/ribo-core/src/index.ts`, `packages/ribo-core/src/index.test.ts`

**Interfaces:**

- Produces: `ConsensusArbiter` — `<T>(input: { path: LeafPath; samples: readonly Extracted<T>[] }) => { accept: Extracted<T> } | { contested: Extracted<T> }`. `unanimousValues` and `majorityValues`.

**The rank-2 generic is the whole point, so get it exactly right.** Written this way, `T` is opaque inside any conforming policy, so `{ accept: { value: "Gas", confidence: 1, sourceSpan: null } }` does not typecheck — `"Gas"` is not assignable to an unresolved `T`. The only envelopes assignable are the ones the policy was handed. An `Extracted<unknown>` version would not do this, because everything is assignable to `unknown`, and a policy could invent a value the samples never produced.

**The second arm is `contested`, not `reject`, and it carries an envelope for a reason.** A parametric policy cannot build the nulled envelope either — `null` is no more assignable to an opaque `T` than a literal is. So `contested` names **the sample whose citation survives**, and the combinator writes `value: null, confidence: 0` over it. The policy chooses the span; the combinator does only what the policy provably cannot.

**Two arms rather than `=> Extracted<T>`**, which would be smaller: the combinator must know a leaf was contested to count them, and an agreed-upon `null` and a fought-over leaf are byte-identical afterwards.

**`unanimousValues`** accepts when every sample's `value` is equal and contests otherwise. Equality is `Object.is` over primitives; a leaf value in this schema is a primitive or null by construction, so a deep comparison is not needed — state that rather than reaching for one.

**`majorityValues`** accepts the value held by strictly more than half the samples. It is **defined only over paths every survivor produced**; with unequal instance counts there is no meaningful majority over an index only some samples reached, and the per-path rule has already contested those before the arbiter sees them. On a tie, contest.

- [ ] **Step 1: Write the failing tests**

  Value-level: `unanimousValues` accepts on three identical values and contests on a dissenter; contests when one sample says `null` and another commits, since the model contradicting itself is the case this catches; `majorityValues` accepts 2-of-3 and contests on a three-way split and on a 1-1 tie; both return an envelope from the samples they were given.

  Type-level, and these are the task's point: a policy returning a **fabricated literal** does not compile; a policy returning `{ value: null }` does not compile. Both with `@ts-expect-error`. If either compiles, the signature does not deliver what this task claims and you should stop and report rather than proceeding.

- [ ] **Step 2: Run to verify they fail** — Expected: FAIL, the module does not exist.

- [ ] **Step 3: Implement** — [ ] **Step 4: Run, export, typecheck** — [ ] **Step 5: Commit**

---

### Task 2: `consensusExtractor`

**Files:**

- Create: `packages/ribo-core/src/consensus-extractor.ts` and its test
- Modify: `packages/ribo-core/src/index.ts`, `packages/ribo-core/src/index.test.ts`

**Interfaces:**

- Produces: `consensusExtractor<V, P>(candidates, options): Extractor<Enveloped<V, P>>`, with `target`, optional `arbiter` (default `unanimousValues`), `minSamples` (default 2), optional `concurrency`, and optional `onContested`.

**Scheduling.** Run every candidate with `Promise.allSettled`, forwarding the caller's whole `ExtractOptions` to each. Unbounded by default is right here: the candidates are meant to be independent samples and N is small by construction — a consensus of twenty is not a thing anyone builds. `concurrency`, when supplied, chunks them for a host on a rate-limited transport.

**Survivors and failures.** A rejected candidate contributes no samples. The run proceeds while at least `minSamples` settled successfully, and otherwise rejects, naming how many survived and how many were required — agreement between one sample and nothing is not agreement, and that is the case a caller most wants told.

**Comparison.** Walk the **first surviving sample** with `mapExtractedLeaves` to enumerate paths, then for each path collect that leaf from every survivor. A path missing from any survivor is contested without consulting the arbiter. A path present in all survivors goes to the arbiter with its samples in survivor order.

The result is built from the first survivor's structure, with each leaf replaced by the arbiter's accepted envelope or the nulled contested one.

**`onContested` is a notification, not a progress unit.** It fires once per contested leaf with the path and the samples, so a host can log which leaves the models fought over — the headline signal this combinator produces. It is deliberately **not** an `ExtractionObserver`: it has no unit vocabulary, adds nothing to the `ExtractionUnit` union, and cannot be confused with a progress tick. Like every observer here it must not change behaviour, and a throwing handler must not fail the run.

**Usage sums `calls` and the token members across every survivor**, because they all ran. **`engine` and `strategy` are omitted** — they identify one producer and a consensus has several, so reporting the first would name a transport that produced only part of the result.

- [ ] **Step 1: Write the failing tests**

  With `FakeExtractor`s returning hand-built enveloped results: three agreeing candidates produce their agreed values and a citation; a leaf they disagree on comes back `value: null, confidence: 0` with a span from the sample the policy named; a candidate that rejects contributes nothing and the run still succeeds while two survive; dropping to one survivor rejects, naming the counts; **a candidate that rejects does not prevent the others from settling** — the pin that this is not `mapWithPool`; the caller's `signal` and `deadline` reach every candidate.

  **The instance-count pin, which is the one a naive implementation fails:** three candidates where one produces a fourth `hvac` instance the others do not — that instance's leaves are contested, not accepted. A per-candidate `minSamples` check passes this wrongly; only per-path counting catches it.

  `onContested` fires once per contested leaf with its path; a throwing handler does not fail the run. Usage sums across survivors and omits `engine`/`strategy`. Construction against a `"row"` target throws, naming the group.

- [ ] **Step 2: Run to verify they fail** — Expected: FAIL, the module does not exist.

- [ ] **Step 3: Implement** — [ ] **Step 4: Run, then the whole core suite** — [ ] **Step 5: Export, typecheck** — [ ] **Step 6: Commit**

---

### Task 3: Changeset and the full gate

- [ ] **Step 1: Add a changeset, committed before running status**

  `@azx/ribo-core` **minor**. The summary says what a consumer gains and what it costs: independent samples compared leaf by leaf, with disagreement producing a null value and a kept citation — the shape gap-fill re-asks about and review flags — at N times the calls of a single extraction.

- [ ] **Step 2: Run the full gate** — `./check.sh`, `pnpm docs:build`, `pnpm changeset status --since=origin/main`.

- [ ] **Step 3: Commit**

---

## Out of scope

- Routing disagreements to review as a new contested state. The design records it as strictly more useful and a cross-package sub-project: a new envelope member, a new `ReviewField` state, a session-schema migration and playground UI. Nulling-with-citation reaches review through the existing null-leaf path.
- Extending the comparison to row-provenance groups. The guard refuses those targets.
- Any measurement of whether agreement actually discriminates. The design's §8 names that as the thing that would prove this wrong, and the cheapest refutation — running three samples over the existing corpus and checking whether contested leaves correlate with known-wrong ones — needs the corpus harness, not this wave.
- Guide updates — the last SP2 wave.

## Notes for the reviewer

Three things most worth adversarial attention. First, whether the rank-2 signature genuinely refuses a fabricating policy — that claim is reasoning about the compiler and the plan requires it be pinned before anything is built, so say if it does not hold. Second, the path enumeration: walking the first survivor means a path only a *later* survivor produced is never enumerated at all, which is a hole the per-path rule does not obviously close — check it. Third, whether building the result from the first survivor's structure is right when survivors disagree structurally, and what happens to a collection group whose instance count differs.
