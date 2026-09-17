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

- Produces: `CensusLeaf` — `{ path: LeafPath; committed: boolean; cited: boolean; groundedness: SpanGroundedness | null }`. `CensusEmptyGroup` — `{ group: string; groundedness: SpanGroundedness }`. `GroundingCensus` — `{ leaves: readonly CensusLeaf[]; emptyGroups: readonly CensusEmptyGroup[] }` plus counts. `groundingCensus(fields, statedEmptyGroups, transcript: string): GroundingCensus`.

**The transcript parameter is the canonical `string`, not the `AnnotatedTranscript`.** `extract`
receives the annotated object; `spanGroundedness` takes the text. The repo's precedent is
`spanGroundedness(extracted.sourceSpan, transcript.text)`. Passing the object would not fail a type
check at a loosely-typed call site and would blow up inside the string comparison at runtime — so the
parameter is typed `string` and the wrapper passes `transcript.text`.

**The census also covers `statedEmptyGroups`, and omitting them would have been the same failure this
sub-project exists to prevent.** `ExtractionResult.statedEmptyGroups` carries a per-group verbatim
span where a roster recorded "none of these" — a committed claim with a citation, written straight
from model output with **no grounding check anywhere in the pipeline**. A fabricated "there is no
attic" quote is exactly the failure mode this combinator is for, and a census over `fields` alone
could not see it: not merely unchecked by the default, but invisible to every policy a host could
write. `emptyGroups` records one entry per group, with `groundedness` computed the same way.

**The three facts per leaf, and why they are three rather than one.**

- `committed` — the leaf holds a non-null value. A model that answered.
- `cited` — the leaf holds a **non-null and non-blank** `sourceSpan`. A model that offered a quote.

  Blank matters: the envelope schema legalises `""`, and `spanGroundedness("")` returns
  `"ungrounded"` — the same answer it gives for `null`. If `cited` meant merely non-null, a committed
  leaf with an empty span would be judged a _fabricated citation_ and rejected, while the identical
  leaf with a null span would be tolerated as uncited. Both mean "no checkable quote", and the
  default policy's single rule must not silently split them on a distinction neither the model nor
  the schema treats as meaningful.

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

**The default policy rejects a committed, cited, ungrounded leaf — and an ungrounded stated-empty
group span, which is the same claim at group scale.** "There are none of these, and here is the
sentence saying so" is a commitment with a citation; a quote absent from the transcript makes it a
fabrication whether it decorates a leaf or a group.

It rejects nothing else. Specifically it does **not** reject:

- a `"near-miss"`, which is a citation the model reformatted rather than invented, and which the repo's own loosened comparison exists to recognise;
- an honest abstention;
- a committed leaf with no citation at all. That is a real and arguably worse failure, but it is a _different_ one, no measurement here says how common it is, and a default that rejects two things is harder to reason about than one that rejects the thing it is named for. The census surfaces it; a host that wants it rejected writes four lines.

The reason string names how many leaves failed and the path of the first, so a log line identifies the result without the reader re-deriving it.

**The error is terminal, and the test for that is end-to-end.** `ValidationRejectedError extends TerminalError`. Asserting `error instanceof TerminalError` would pin the declaration and prove nothing about the behaviour that matters. The test that matters builds a real `fallbackExtractor` with `terminalFallsThrough`, a first rung wrapped in `validateExtractor` that rejects, and a second rung that succeeds — and asserts **the second rung's result comes back**. That is the assertion that would have caught the design's original backwards classification, and it is why it is specified here rather than left to a unit test on the class.

**A passing result is returned untouched, by identity** — on the direct call. The combinator judges;
it does not transform. Note this does **not** survive an arbitration ladder, which returns a stamped
shallow copy of whichever result it accepted; that is the engine's business and not a violation of
this claim. Scope the `toBe` accordingly.

- [ ] **Step 1: Write the failing tests**

  With `FakeExtractor` and hand-built results: a fully grounded result is returned **by identity**
  (`toBe`, on the direct call — see the caveat below); a result with one committed-cited-ungrounded
  leaf throws `ValidationRejectedError`; a `"near-miss"` does not throw; an honest abstention does
  not throw; a committed-uncited leaf does **not** throw under the default; **a committed leaf with a
  blank span does not throw either**, which is the pin on `cited` meaning non-blank; **an ungrounded
  stated-empty group span does throw**; a custom policy is consulted and its rejection honoured; the
  error carries the census and a reason naming the count and first path.

  **Forwarding, which nothing else here would catch.** This is a delegating combinator, and the repo
  has already shipped a bug where one dropped the options bag — `fallback-extractor.test.ts` carries a
  test that exists solely to catch it, and `FakeExtractor.callOptions` is the recorder for it. Assert
  the inner extractor receives the caller's `signal` **and** `deadline`. Without this the omission
  typechecks and every other test passes.

  Then the one that matters: **a `fallbackExtractor` with `terminalFallsThrough`, a rejecting
  validated first rung and a succeeding second rung reaches the second rung.**

  **Assert on `.fields`, not object identity, in the ladder test.** The arbitration engine returns a
  stamped shallow copy of the accepted result — it rewrites `usage` to record the winning strategy —
  so `toBe` against the second rung's own object fails by construction, and an implementer chasing it
  would "fix" a correct engine. Identity is asserted on the unwrapped `validateExtractor` call only.

  **The converse runs its transient error through a `validateExtractor`-wrapped rung too.** A bare
  throwing fake would only re-pin the arbiter, which `fallback-extractor.test.ts` already covers, and
  would say nothing about this combinator. Wrapping it pins the additional thing worth pinning: that
  the wrapper propagates an inner error **unchanged** rather than converting or swallowing it. Add an
  explicit assertion that the error reaching the ladder is the inner one, by identity.

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

## Reviewed

Reviewed by OpenCode (`glm-5p3-flash`, run e6a8) before implementation. All findings applied.

It verified the terminal mechanism end to end rather than taking the plan's word: a
`ValidationRejectedError extends TerminalError` reaches `terminalFallsThrough`'s final
`{ continue: true }` because nothing earlier intercepts it, and `isTransientFailure` returns false on
a `TerminalError` before its status heuristic runs. It also found the headline test is **stronger**
than the plan claimed — an implementation that forgets `extends TerminalError` is classified
transient by the default-true rule, so the test fails. The class and the behaviour are pinned
together, which is exactly what makes an end-to-end test worth writing over an `instanceof`
assertion.

The serious finding: **the census was blind to `statedEmptyGroups`.** Those are per-group verbatim
spans where a roster recorded "none of these", written straight from model output with no grounding
check anywhere in the pipeline — a committed claim with a citation, and a fabricated one is exactly
this combinator's target. A census over `fields` alone could not see them: not merely unchecked by
the default, but invisible to every policy a host could write. That is §4.5's "counts nothing while
looking judged" recurring one level up. The census now covers them and the default policy rejects an
ungrounded one.

Three mechanism corrections. `cited` must mean **non-blank**, not merely non-null: the schema
legalises `""`, `spanGroundedness("")` is `"ungrounded"`, so a committed leaf with a blank span would
have been rejected as a fabrication while the identical leaf with a null span was tolerated — the
same fact, split by the one rule that was supposed to be simple. The `transcript` parameter is the
canonical `string`; passing the `AnnotatedTranscript` would survive a loose call site and fail inside
the string comparison at runtime. And `ExtractOptions` forwarding was unspecified and untested, which
this repo has already shipped a bug for once — there is now a pin on the inner extractor receiving
the caller's `signal` and `deadline`.

Two test-design corrections. The `toBe` identity claim is false **through a ladder**, because the
arbitration engine returns a stamped shallow copy of the accepted result — an implementer chasing
that would have "fixed" a correct engine. Identity is now scoped to the direct call, with the ladder
asserting on `.fields`. And the converse transient case must run through a `validateExtractor`-wrapped
rung; a bare throwing fake would only re-pin the arbiter, which another suite already covers, and say
nothing about this combinator — wrapping it additionally pins that the wrapper propagates an inner
error unchanged.

One nit recorded rather than fixed: an empty object group passes the granularity guard vacuously,
since `every` over no properties is true. Degenerate — there is nothing to judge in a zero-leaf
group — but it is the one input where "the guard catches every such case" does not hold.
