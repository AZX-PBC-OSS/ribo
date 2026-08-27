# Extractor arbitration — implementation plan

**Authority:** `extractor-arbitration-design.md`. Read §3.1 (why the combinators stay separate in
surface), §4.1–§4.3 (the arbiter, the defaults, the fall-through direction) and §5 (observability)
before starting any task. §4.2 was corrected after this plan was drafted; read the current text, not
a cached copy.

**Scope.** The extractor seam only. `hedged.ts`, `first-capable.ts` and every transcriber path are
out of scope, per design §3.1 — a single engine spanning both seams would turn `hedged`'s privacy
property from a type fact into a boolean.

**What this does not build.** The tiered segmentation strategies themselves. This plan delivers the
mechanism; `r1.6-instance-extraction-design.md` supplies the ladder that runs on it.

## Three decisions pinned for this increment

**`compositeExtractor`'s public behaviour does not change.** Not the selection rules, not the error
message, not the TTL caching, not `invalidate()`. It is reimplemented over the shared engine and its
existing suite is the regression gate — **the suite is not edited**. If a test needs changing to make
it pass, you have changed behaviour and the task has failed.

**The arbiter is synchronous.** Design §9.2 leaves async open on a real need; nothing here has one,
and a synchronous callback is far harder to misuse inside a scheduling loop. Do not make it async.

**`usage.calls` semantics are not touched.** Design §8 records that a ladder running three candidates
bills for three while `usage.calls` reports only the accepted candidate's. That divergence is real and
deliberately left alone. Do not "fix" it.

## Global constraints

Every task inherits these.

- ESM-only; `.js` extensions on relative TypeScript imports; `import type` for type-only imports
  (lint-enforced).
- **Verification is light per task and full at the end.** Per task, run `pnpm typecheck`, `pnpm lint`,
  `pnpm format:check` and the **unit tests for the files you touched** — not the whole suite, and
  never a real extraction. Nothing in this plan needs a model, a network call, or a transcript: every
  task is testable with fakes, and a task that reaches for a real extraction has misread its scope.
  `./check.sh` runs **once, after the last task**, and the pack-and-consume tier and the acceptance
  gate are not part of this work at all.
- The suite is green on this base; **any** failure is yours to explain.
- Comments explain **why**, not what. A comment describing behaviour the code no longer has is a
  defect.
- No new dependencies.
- **The `Extractor` seam does not change.** `extract(transcript) → ExtractionResult<F>` is unchanged.
  Two additive widenings only: `usage.strategy` in Task 2, and Task 4's named parse-failure class.
  Neither removes or narrows anything an existing implementation relies on.
- Every new public symbol is exported from `packages/ribo-core/src/index.ts` in the task that creates
  it, with a comment saying why it lives in core — matching the existing `compositeExtractor` export
  block's rationale.
- Commit in small pieces as you go. A run that leaves everything uncommitted produced nothing.
- Each task adds a changeset.

---

## Task 1 — The arbiter contract and the two default arbiters

**Files:** create `packages/ribo-core/src/arbitration.ts` and its test; modify
`packages/ribo-core/src/index.ts`.

**Intent.** The vocabulary, with no scheduling and no extractor in sight. An arbiter is a synchronous
function from the outcomes so far to a verdict. This task is pure data and pure functions, testable
with no fakes beyond plain objects, and it is deliberately landed before anything calls it.

**Interfaces.** An outcome is a candidate identifier plus **either** a result **or** an error — never
both, never neither. The arbiter input carries the outcomes in **settlement** order plus an
`exhausted` flag that is true once **every candidate has settled** — not "none left to start". Both
readings coincide under Task 2's sequential scheduling and diverge under Task 5's; design §4.1 carries
why, and getting it wrong there makes a race unbuildable. A verdict is one of three shapes: accept a
result, continue, or give up with an error. Name the three verdict discriminants so a reader can tell
them apart at a glance and so a mistyped verdict is a compile error rather than a silent `continue`.

Two default arbiters ship with it:

- **`terminalFallsThrough`** — accept the first successful result; on a failure, continue only when
  `isTransientFailure` reports the error is **not** retryable; give up immediately on a transient
  error; at exhaustion give up with the first error seen. Import `isTransientFailure` from
  `./queue/backoff.js`. **Read design §4.2 before writing this — the direction is the opposite of
  what the name suggests on first reading, and a previous revision of the design had it backwards.**
- **`acceptAnySuccess`** — accept the first successful result; continue past any failure; at
  exhaustion accept the first result if any exists, else give up with the first error. Design §4.2
  says "the best result available"; **"first" is the pin**, because there is no quality metric to rank
  results by and inventing one here would be policy the core must not hold. Note this branch is nearly
  unreachable through the engine — the arbiter accepts a success the moment it lands — so test it
  against the bare function.

**Must-fail tests.**

- `terminalFallsThrough` returns `continue` for a `TerminalQueueError` and `giveUp` for an error with
  a 503 status. These two together are the whole point of the arbiter; one without the other passes
  a reversed implementation.
- `terminalFallsThrough` returns `giveUp` for a bare `Error` with no status. This pins the
  interaction with `isTransientFailure`'s documented default-to-retryable, and is the test that would
  catch someone "simplifying" the classification.
- `terminalFallsThrough` at exhaustion gives up with the **first** error, not the last, when two
  terminal failures accumulated.
- `acceptAnySuccess` continues past a `TerminalQueueError` where `terminalFallsThrough` would too,
  but also continues past a 503 where `terminalFallsThrough` gives up. Asserting both arbiters on the
  same input is what proves they are genuinely different policies rather than one with a flag.
- `acceptAnySuccess` at exhaustion with only failures gives up rather than accepting nothing.
- Both arbiters accept a result that appears after an earlier failure, proving a failure does not
  poison the run.

---

## Task 2 — `usage.strategy`, the sequential engine, and `fallbackExtractor`

**Files:** modify `packages/ribo-core/src/extractor.ts`; create
`packages/ribo-core/src/fallback-extractor.ts` and its test; extend `arbitration.ts` with the engine;
modify `index.ts`.
**Depends on Task 1.**

**Intent.** The engine that all three combinators share, plus the first constructor over it. The
engine owns candidate iteration, verdict validation and result stamping; it owns no policy.

**Interfaces.**

`ExtractionResult["usage"]` gains an **optional** `strategy?: string`. Optional for exactly the
documented reason `engine?` is: `FakeExtractor` and both existing extractors report `{ calls }` alone,
and requiring it would break every implementation for the benefit of one. Extend `usage`'s existing
doc comment to say what `strategy` means and how it differs from `engine` — engine is _which
transport_, strategy is _which approach_.

The engine takes candidates (each an identifier, an optional admission probe, and an extractor), a
scheduling mode, an arbiter, a **stamp key**, and a factory that builds the error thrown when no
candidate is ever admitted. Admission is a two-state answer: admitted, or not-admitted carrying an
opaque detail the error factory formats. Fallback supplies no admission probe, so every candidate is
admitted; Task 3's composite supplies one. **The engine must not know what a capability is** — that
vocabulary belongs to `composite-extractor.ts`, for the same reason `SelectableCapability` is
structurally typed.

**Sequential admission is lazy and stops at the first admitted candidate.** A capability probe can hit
the network, so probing candidates behind the winner is a real side effect and a behaviour change from
today's composite. Pin it: under sequential scheduling the engine probes candidate N only after N−1
has been refused admission, and probes nothing after one is admitted.

**`exhausted` means every candidate has settled, not that none is left to start**, and `outcomes` is
ordered by **settlement**, not dispatch. Invisible under sequential scheduling; load-bearing under
Task 5's. Design §4.1 carries the reasoning.

**The stamp is one mechanism with a caller-chosen key.** On accept the engine sets
`usage[stampKey] = acceptedCandidateId`, preserving every other `usage` field. Composite passes
`"engine"` — its candidate ids already _are_ `source.engine`, so the result is byte-identical to the
private stamping it does today, and that private code is deleted. Fallback and race pass `"strategy"`.
There is no suppression flag and no opt-out path, so the conflict where composite must avoid acquiring
a `strategy` key cannot arise. **Do not instead stamp `strategy: undefined` for composite** — that
passes a `toEqual` assertion while leaving `"strategy" in usage === true`, which is a leak no test
catches.

`giveUp` throws the supplied error **unchanged** — not wrapped — so `isTransientFailure` and the
relay's `dead` handling classify it exactly as they would with no combinator in the path.

The engine enforces four validation rules, each throwing a `TypeError` naming the offending arbiter or
candidate rather than failing obscurely later:

1. `continue` returned when `exhausted` is true.
2. `accept` returning a result that is not reference-equal to one carried in `outcomes`.
3. An empty candidate list at construction.
4. **Duplicate candidate identifiers at construction.** This lives in the engine, not in each
   constructor, because the ambiguity it prevents is created by the engine's stamp — so every
   constructor inherits it and `raceExtractor` cannot be built without it by omission.

`fallbackExtractor(candidates, arbiter)` returns an `Extractor<F>`. Candidates are `{ strategy,
extractor }` pairs; it passes `"strategy"` as the stamp key and supplies no admission probe. The
duplicate-identifier guard comes from the engine (rule 4 above), not from this constructor.

**Must-fail tests.**

- A first candidate that throws a `TerminalQueueError` and a second that succeeds returns the
  second's fields, and the first extractor is invoked exactly **once**. The call count is the half
  that catches an accidental retry loop.
- The result's `usage.strategy` names the accepted candidate — asserted both when the first candidate
  succeeds and when a later one does. Only testing the fallback path lets a bug through where the
  happy path is unstamped.
- `usage.calls` and `usage.engine` survive stamping unchanged.
- `giveUp` propagates the error identity — assert the caught error is the **same object** the arbiter
  supplied, and that `isTransientFailure` returns the same verdict on it as it does outside the
  combinator.
- An arbiter returning `continue` at exhaustion throws a `TypeError` mentioning the arbiter, not a
  generic failure from inside the loop.
- An arbiter returning an `accept` carrying a synthesised result object throws a `TypeError`.
- Later candidates are **not** invoked once one is accepted.
- A duplicate strategy identifier throws at construction, before any extraction.
- An empty candidate list throws at construction.

---

## Task 3 — Reimplement `compositeExtractor` over the engine

**Files:** modify `packages/ribo-core/src/composite-extractor.ts`; create
`packages/ribo-core/src/composite-extractor-rules.test.ts`. **Do not touch
`composite-extractor.test.ts`.**
**Depends on Task 2.**

**Intent.** Prove the engine is general enough to express capability selection, and delete the
duplicated iteration. This is the task that makes design §3.1's "combinable in mechanism, separate in
surface" true rather than asserted.

**Interfaces.** `compositeExtractor`'s exported signature, its options, and every exported type are
unchanged. Internally it becomes: a capability probe adapted into the engine's admission hook (the
TTL cache and `invalidate()` stay here — the engine has no clock), plus an arbiter that accepts the
first result and gives up with any error, which is exactly rule 5. The `no extractor is ready — …`
error (that is its literal wording — grep for it) is
built by composite's own factory so its wording is preserved byte-for-byte.

Keep the existing behaviours that live in this file and are not the engine's business: `needs-download`
is never admitted but is reported in the error; a probe that throws becomes an unavailable engine
rather than taking the caller down; duplicate engine ids are refused; `usage.engine` is stamped with
the winning engine.

**Stamping is already decided** — Task 2's stamp key. Composite passes `"engine"`, which reproduces
today's stamp byte-for-byte and deletes the private stamping code at the same time. No `strategy` key
can appear, so nothing here needs a suppression path.

**The gate, and why the obvious version of it is not enough.** Two independent reviews found the same
defect in an earlier draft of this task, and it is worth stating so nobody restores it: **the existing
suite never exercises rule 5.** No test has an extractor that rejects — the fake always resolves. So a
reimplementation that caught an extractor error and fell through to the next engine — building, by
accident, exactly the behaviour this design adds _elsewhere_ — would pass all 7 tests. Rule 5 would
not merely be unproven; **its inverse would pass the gate.**

Four more behaviours are equally unguarded. `usage.engine` stamping is **vacuously** covered: both
stamping tests use fakes that self-report an `engine` equal to `source.engine`, so dropping the stamp
entirely still passes. A thrown probe becoming `unavailable` (rule 4), the duplicate-engine-id
`TypeError`, and the empty-entries `TypeError` have no tests at all. Lazy probing is half-covered —
test 1 asserts the losing extractor is not invoked, never that its source is not probed, so an eager
engine passes.

So the gate is two rules, not one:

1. **`composite-extractor.test.ts` is not edited.** Existing assertions stay byte-stable. Run it
   first and record the count — currently 7. If you believe an existing test is wrong, stop and
   report rather than editing it.
2. **Add the missing pins in a new sibling file**, `composite-extractor-rules.test.ts`, so rule 1
   stays literally true. An earlier draft forbade adding tests anywhere, which froze a weak gate
   instead of strengthening it.

**Must-fail tests** (the new file):

- **Rule 5 and lazy probing together:** first entry ready, its extractor throws a sentinel object;
  assert the _same object_ propagates, the second ready entry's extractor is **never invoked**, and
  its source is **never probed**. This single test is what makes Task 3's claim falsifiable.
- **The stamp is the engine's, not the fake's:** a fake reporting `engine: undefined` (or a
  deliberately wrong engine) comes back stamped with `source.engine`.
- A probe that throws is reported as `unavailable` in the no-ready error rather than propagating.
- A duplicate engine id throws `TypeError` at construction.
- An empty entries array throws `TypeError` at construction.
- Capability re-probes after the TTL expires, using the injectable clock — the existing suite pins
  only the within-TTL and `invalidate()` directions, so a cache that never expires passes today.

---

## Task 4 — A recognisable schema-parse failure that stays retryable

**Files:** modify `packages/ribo-extractor-openai/src/extraction-common.ts` (the shared
`parseWithSchema` and its doc comment); modify `packages/ribo-core/src/arbitration.ts`
(`terminalFallsThrough`); extend `per-group.test.ts`, `single-shot.test.ts` and the Task 1 arbiter
tests.
**Depends on Task 1** (it extends `terminalFallsThrough`). Independent of Tasks 2, 3 and 5.

**Intent, and a reversal from an earlier draft.** `isTransientFailure` defaults an unrecognised error
to retryable. A zod failure carries no HTTP status, so it classifies as **transient**, and
`terminalFallsThrough` would not fall through on it — design §4.3's third row would be a lie.

An earlier draft closed that by throwing parse failures as `TerminalQueueError`. **That was wrong and
must not be restored.** Truncation at a fixed `maxTokens` is deterministic, which is what makes it
terminal; a schema miss is **sampled**, so the same request can fail zod once and pass on re-send.
`parseWithSchema`'s existing doc comment already argues this and is correct. The cost is also
asymmetric by path: strict structured outputs make a schema miss rare on the managed path, but the
on-device path — the one the ladder exists to rescue — has no server-side `strict`, so an occasional
miss is its _expected_ failure. Terminalising would strip both the per-group retry and the relay's
backoff from precisely the offline recording that gets no second chance.

The conflation to undo: **we want the ladder to fall through, not the queue to stop retrying.** Those
fused only because the arbiter's sole signal is the error. So the parse failure gets its own
**recognisable type that `isTransientFailure` still classifies as transient**, and the arbiter tests
for the type directly.

**Interfaces.** A named error class thrown by `parseWithSchema` in place of the current plain `Error`
— carrying the zod issue text in its message and the `ZodError` as `cause`, exactly as today. It must
**not** extend `TerminalQueueError`, and `isTransientFailure` must keep returning `true` for it; the
class exists to be recognised, not to reclassify. Decide where it lives and say so in your report: it
is thrown in `ribo-extractor-openai` but read by `terminalFallsThrough` in `ribo-core`, and core
cannot import from the extractor package. `terminalFallsThrough` then falls through on a
not-retryable error **or** a schema-parse failure.

**Scope, pinned rather than discovered.** The earlier draft said "check whether any existing test
asserts the current retrying". They exist; here they are, and all three are **in scope to update**:

- `per-group.test.ts:476` — "a schema-invalid group response is transient (queue retries)".
- `single-shot.test.ts:248` — the same for single-shot, inside a describe block named "failure is
  transient (queue retries)".
- `extraction-common.ts:217–228` — `parseWithSchema`'s doc comment, which argues the current policy.
  Under this plan's own global rule a stale comment is a defect, so rewrite it to say the failure
  stays transient **and** is now recognisable, and why both halves matter.

Their **assertions do not change** — the failures stay transient. Only their names and comments need
to stop implying that transient is the whole story.

`parseWithSchema` is shared, so this reaches **both** extractors and both of per-group's call sites
(the group parse and the merged-whole parse). That is intended: a split where the same malformed
response is recognisable under one extractor and not the other would be worse than either policy.

**Must-fail tests.**

- A response that parses as JSON but violates the schema throws the new type, and
  `isTransientFailure` still returns **true** for it. Both halves in one assertion — this is the test
  that stops someone "simplifying" it back into a `TerminalQueueError`.
- That failure is still retried: assert the transport is called more than once, proving queue
  resilience was preserved rather than traded away.
- `terminalFallsThrough` returns `continue` for the new type, even though it is transient. This is
  the row of design §4.3 that the whole task exists to make true.
- The message still contains the offending path or issue text, so failures stay diagnosable.
- A non-JSON body (`parseJsonContent`) stays a plain transient `Error` and does **not** become the new
  type — otherwise a too-broad change that relabels every parse failure passes.
- A 503 is still retried and still causes `terminalFallsThrough` to give up, unchanged.

---

## Task 5 — `raceExtractor`

**Files:** create `packages/ribo-core/src/race-extractor.ts` and its test; modify
`packages/ribo-core/src/arbitration.ts` (add the concurrent scheduling mode) and `index.ts`; modify
`AGENTS.md`.
**Depends on Task 2.**

**Task 2 builds the sequential mode only**, so the concurrent branch of the engine lands here, with
this task's tests as its first and only coverage. That is why `arbitration.ts` is in this file list —
an earlier draft omitted it and left the concurrent scheduler owned by nobody. It also means Task 5
and Task 3 both touch files Task 2 created; run Task 3 first if you would rather not review two
engine changes at once.

**Fold the docs update in here**, as the last task to touch `ribo-core`'s public surface: AGENTS.md §1
describes that surface, and this increment adds three public modules plus a `usage` widening. No
earlier task carries it, and doing it once at the end beats four partial edits.

**Built, not deferred — and the reason is worth stating, because a YAGNI argument against it looks
strong until you account for what this repo is.** R1.6 composes only `fallbackExtractor`, so an
internal-product reading says defer until a caller exists. This is a published open-source SDK, and
its consumers are not on this roadmap. Shipping two of the three schedulings the engine already
supports, with the third withheld because our own first consumer does not happen to need it, leaves a
visible hole in the surface and makes the engine's generality unverified by anything except
`compositeExtractor`. Design §4.5's argument stands on its own: a race is what makes the
accumulated-outcomes input meaningfully more expressive than "first to finish", and building it is
what proves the scheduling knob was not designed around a single consumer.

**Intent.** The same engine with concurrent scheduling: start every candidate, call the
arbiter as each outcome lands with everything accumulated so far, and let it accept early or wait.

**Interfaces.** `raceExtractor(candidates, arbiter)`, a separate constructor with **no scheduling
parameter** — per design §3.1, concurrency must be something a caller asked for by name, never a flag
on a shared constructor. No admission hook.

**Must-fail tests.**

- Every discarded promise has a rejection handler: a losing candidate that rejects after another has
  been accepted must not surface as an unhandled rejection. Assert this explicitly with a process-level
  handler or vitest's unhandled-rejection detection — this is the guard `hedged` documents and the one
  most easily lost.
- An arbiter that accepts the first landed outcome returns before the slower candidate settles.
- An arbiter that waits sees outcomes accumulate in **settlement** order, not dispatch order — with
  a slow first candidate and a fast second, the second's outcome is `outcomes[0]`. Design §4.1 pins
  this; it is what makes `terminalFallsThrough`'s "first error" mean the same thing under both
  schedulings.
- `exhausted` is false while any candidate is still in flight, and becomes true only once all have
  settled. Without this the arbiter can never legally return `continue` in a race.
- `usage.strategy` names the accepted candidate, not the first-started one.

---

## Two things in the design that no task builds, on purpose

Checked by walking the design section by section; recorded so a reviewer does not read them as
omissions.

**§4.4's placement rule — fallback inside each composite entry, never around the composite — is
guidance for a consumer, not code.** Nothing in this plan wires a real composition; the first one is
built by `r1.6-instance-extraction-design.md`. The rule is preserved by the fact that both
constructors return a plain `Extractor<F>`, so either nesting is expressible and neither is
privileged. If you find yourself adding a helper that assembles the composition for the caller, stop —
that would pick a topology the design deliberately leaves to the host.

**§5's "any measurement run must report strategy distribution" has no task, and should not.** The
measurement tooling lives in `packages/ribo-adapter-snuggpro/acceptance/`, and no ladder is wired into
a real composition in this increment — so there is no distribution to report yet. It becomes real when
`r1.6-instance-extraction-design.md` lands its strategies, and belongs to that plan. Recorded here
because a requirement nobody writes down is a requirement somebody rediscovers.

**§7's "a transient failure does not reach the arbiter until the candidate's retry budget is spent"
is not a combinator behaviour.** The combinator has no retry loop and never gains one; the retrying
belongs to the candidate, which is already `perGroupExtractor`'s tested behaviour. What this plan can
and does assert is the other half — Task 2's "the first extractor is invoked exactly once" — which
proves the combinator adds no retry of its own. Do not add retry to the engine to satisfy the design
sentence.

## Sequencing and review points

Tasks 1 → 2 → 3 are strictly ordered; each is independently reviewable and independently revertible.
Task 4 depends on Task 1 only (it extends `terminalFallsThrough`) and is otherwise independent, so it
can run alongside Tasks 2 and 3. Task 5 depends on Task 2 and shares `arbitration.ts` with Task 3, so
prefer running it after Task 3 rather than concurrently.

**Task 3 is the risk.** It is the only task that touches shipped, exercised behaviour, and its gate is
an unedited test file. Review it before starting Task 4 if they are running concurrently, so a
regression there is not diagnosed through an unrelated change.
