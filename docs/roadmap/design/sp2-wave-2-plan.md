# SP2 — Wave 2: `validateExtractor`, and the census it decides from

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The first judging combinator. `validateExtractor` wraps any `Extractor`, tallies how well its result is cited, hands that tally to a caller-supplied policy, and either returns the result untouched or throws an error an arbitration ladder falls through on.

**Architecture:** A pure census function over the leaf walk Wave 1 moved into core, plus a thin wrapper that applies a policy to it. The rejection is a `TerminalError` subclass, which is what makes the shipped default arbiter continue to the next rung rather than give up — the one decision in this wave that an earlier draft of the design got backwards, and the reason its headline test runs end to end through a real `fallbackExtractor` rather than asserting on the error class.

**Tech Stack:** TypeScript, Vitest. No new dependencies.

**Spec:** `docs/roadmap/design/sp2-judging-combinators-design.md` (§4.2, §4.5)

## Global Constraints

- **A null span is not a bad citation.** `spanGroundedness(null, transcript)` returns `"ungrounded"`, so a leaf that honestly abstained with no quote is indistinguishable, by that function alone, from one citing text absent from the transcript. Those are opposite things — one is the model declining to answer, the other is the failure this combinator exists to catch. The census keeps them apart, and a policy that conflated them would reject nearly every real result.
- **The rejection is terminal, not transient.** `terminalFallsThrough` continues on a terminal error and gives up on a transient one, because a transient failure means the transport is down and the next strategy shares it. A transient rejection therefore produces the _opposite_ of the intended behaviour, plus a relay retry loop re-running the hallucinating rung. This is settled in the design §4.2 with its reasoning; do not "fix" it back.
- **No other combinator is built.** No `consensus`, no `budget`, no `cached`.
- `ribo-core` must not import from any `ribo-extractor-*` package.
- Tests run from the repo root: `pnpm vitest run packages/<dir>/src/<file>.test.ts`.

---

### Task 1: `groundingCensus`

**Files:**

- Create: `packages/ribo-core/src/grounding-census.ts` and its test
- Modify: `packages/ribo-core/src/index.ts`, `packages/ribo-core/src/index.test.ts`

**Interfaces:**

- Produces: `CensusLeaf` — `{ path: LeafPath; committed: boolean; cited: boolean; groundedness: SpanGroundedness | null }`. `GroundingCensus` — `{ leaves: readonly CensusLeaf[] }` plus counts. `groundingCensus(fields, transcript): GroundingCensus`.

**The three facts per leaf, and why they are three rather than one.**

- `committed` — the leaf holds a non-null value. A model that answered.
- `cited` — the leaf holds a non-null `sourceSpan`. A model that offered a quote.
- `groundedness` — `spanGroundedness` of that quote, **and `null` when `cited` is false.** Never call `spanGroundedness` on a null span and record the answer: it returns `"ungrounded"`, which would mark every honest abstention as a citation failure.

Those three are independent and their combinations mean different things. `committed && cited && "ungrounded"` is a fabricated citation — the failure mode. `!committed && !cited` is an honest abstention. `!committed && cited` is gap-fill's abstained-with-evidence candidate. `committed && !cited` is a value with no quote at all, which is a _different_ failure and one the default policy below deliberately does not act on.

**Counts are a convenience over `leaves`, not a separate source of truth.** Derive them; do not maintain them in parallel. A policy that wants something the counts do not offer walks `leaves`.

- [ ] **Step 1: Write the failing tests**

  Against hand-built enveloped data and a known transcript: a committed leaf quoting verbatim text is `{ committed: true, cited: true, groundedness: "grounded" }`; one quoting text with different case or whitespace is `"near-miss"`; one quoting absent text is `"ungrounded"`; **an abstained leaf with a null span is `{ committed: false, cited: false, groundedness: null }` — not `"ungrounded"`**; a committed leaf with a null span is `{ committed: true, cited: false, groundedness: null }`; paths are structured, and a collection group's leaf carries its index.

  The null-span case is the one that matters most — assert `groundedness` is `null` explicitly rather than merely "not grounded", because `"ungrounded"` is exactly what the underlying function returns and a wrong implementation looks right otherwise.

- [ ] **Step 2: Run to verify they fail** — Expected: FAIL, the module does not exist.

- [ ] **Step 3: Implement** — use `mapExtractedLeaves` as a pure visitor, returning every leaf unchanged.

- [ ] **Step 4: Run to verify they pass, export, typecheck** — [ ] **Step 5: Commit**

---

### Task 2: `validateExtractor`, its error, and the default policy

**Files:**

- Create: `packages/ribo-core/src/validate-extractor.ts` and its test
- Modify: `packages/ribo-core/src/index.ts`, `packages/ribo-core/src/index.test.ts`

**Interfaces:**

- Produces: `ValidationPolicy` — `(census: GroundingCensus) => { ok: true } | { reject: string }`, where the string is a human-readable reason. `ValidationRejectedError extends TerminalError`, carrying the census and the reason. `rejectUngroundedCommitments` — the shipped default. `validateExtractor<F>(extractor, options): Extractor<F>` where options carry `target`, an optional `policy`, and the observer.

**Why it needs the target.** Two reasons: `assertLeafGranularity` runs at construction against `target.extractionSchema`, refusing a `"row"` or `"none"` target before any call — this combinator walks per-leaf envelopes and would otherwise count nothing while returning a result that looks judged. And the transcript for the census comes from the `extract` call, not the target, so only the schema is needed here.

**The default policy rejects a committed, cited, ungrounded leaf** — and nothing else. Specifically it does **not** reject:

- a `"near-miss"`, which is a citation the model reformatted rather than invented, and which the repo's own loosened comparison exists to recognise;
- an honest abstention;
- a committed leaf with no citation at all. That is a real and arguably worse failure, but it is a _different_ one, no measurement here says how common it is, and a default that rejects two things is harder to reason about than one that rejects the thing it is named for. The census surfaces it; a host that wants it rejected writes four lines.

The reason string names how many leaves failed and the path of the first, so a log line identifies the result without the reader re-deriving it.

**The error is terminal, and the test for that is end-to-end.** `ValidationRejectedError extends TerminalError`. Asserting `error instanceof TerminalError` would pin the declaration and prove nothing about the behaviour that matters. The test that matters builds a real `fallbackExtractor` with `terminalFallsThrough`, a first rung wrapped in `validateExtractor` that rejects, and a second rung that succeeds — and asserts **the second rung's result comes back**. That is the assertion that would have caught the design's original backwards classification, and it is why it is specified here rather than left to a unit test on the class.

**A passing result is returned untouched, by identity.** The combinator judges; it does not transform. `toBe` on the result object.

- [ ] **Step 1: Write the failing tests**

  With `FakeExtractor` and hand-built results: a fully grounded result is returned **by identity**; a result with one committed-cited-ungrounded leaf throws `ValidationRejectedError`; a `"near-miss"` does not throw; an honest abstention does not throw; a committed-uncited leaf does **not** throw under the default; a custom policy is consulted and its rejection honoured; the error carries the census and a reason naming the count and first path.

  Then the one that matters: **a `fallbackExtractor` with `terminalFallsThrough`, a rejecting validated first rung and a succeeding second rung returns the second rung's result.** And its converse, to prove the pin is about terminal-ness rather than luck: the same ladder with a first rung throwing a _transient_ error gives up rather than reaching the second.

  Construction: building against a target with a `"row"` group throws, naming the group.

- [ ] **Step 2: Run to verify they fail** — Expected: FAIL, the module does not exist.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run to verify they pass, then the whole core suite** — Expected: PASS, nothing else modified.

- [ ] **Step 5: Export, typecheck** — [ ] **Step 6: Commit**

---

### Task 3: Changeset and the full gate

- [ ] **Step 1: Add a changeset, and commit it before running `changeset status`**

  `@azx/ribo-core` **minor**. Note the ordering: `changeset status` computes changed changesets through `git diff`, so it cannot see an uncommitted changeset file — commit it first or the check is meaningless.

  The summary says what a consumer gains: an extraction result can now be judged on how well it is cited, before it reaches review or a write, and a rejection falls through an arbitration ladder to the next strategy.

- [ ] **Step 2: Run the full gate** — `./check.sh`, `pnpm docs:build`, `pnpm changeset status --since=origin/main`. Expected: PASS.

- [ ] **Step 3: Commit**

---

## Out of scope

- `consensusExtractor`, `budgetExtractor`, `cachedExtractor` — later waves.
- Extending the census to row-provenance groups. The guard refuses those targets; the design records extending the walk as the right end state and deliberately not this sub-project.
- A scoring or thresholding API. The design's §3 and §5 record why.
- Guide updates — the last SP2 wave.

## Notes for the reviewer

Two things most worth adversarial attention. First, whether the census's three facts are actually sufficient for the policies a host would want to write, or whether there is a distinction it collapses — the null-span case is handled, but there may be another. Second, the end-to-end fall-through test: whether it genuinely pins terminal-ness, or whether it would also pass with a transient error for some other reason, which is what its converse assertion is meant to rule out.
