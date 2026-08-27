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
  The only contract widening anywhere is `usage.strategy`, in Task 2.
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
both, never neither. The arbiter input carries the outcomes in attempt order plus an `exhausted` flag
that is true when no candidate remains. A verdict is one of three shapes: accept a result, continue,
or give up with an error. Name the three verdict discriminants so a reader can tell them apart at a
glance and so a mistyped verdict is a compile error rather than a silent `continue`.

Two default arbiters ship with it:

- **`terminalFallsThrough`** — accept the first successful result; on a failure, continue only when
  `isTransientFailure` reports the error is **not** retryable; give up immediately on a transient
  error; at exhaustion give up with the first error seen. Import `isTransientFailure` from
  `./queue/backoff.js`. **Read design §4.2 before writing this — the direction is the opposite of
  what the name suggests on first reading, and a previous revision of the design had it backwards.**
- **`acceptAnySuccess`** — accept the first successful result; continue past any failure; at
  exhaustion accept the first result if any exists, else give up with the first error.

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
scheduling mode, an arbiter, and a factory that builds the error thrown when no candidate is ever
admitted. Admission is a two-state answer: admitted, or not-admitted carrying an opaque detail the
error factory formats. Fallback supplies no admission probe, so every candidate is admitted; Task 3's
composite supplies one. **The engine must not know what a capability is** — that vocabulary belongs to
`composite-extractor.ts`, for the same reason `SelectableCapability` is structurally typed.

The engine enforces three validation rules, each throwing a `TypeError` naming the offending
arbiter rather than failing obscurely later:

1. `continue` returned when `exhausted` is true.
2. `accept` returning a result that is not reference-equal to one carried in `outcomes`.
3. An empty candidate list at construction.

On accept, the engine stamps `usage.strategy` with the accepted candidate's identifier, preserving
every other `usage` field. `giveUp` throws the supplied error **unchanged** — not wrapped — so
`isTransientFailure` and the relay's `dead` handling classify it exactly as they would with no
combinator in the path.

`fallbackExtractor(candidates, arbiter)` returns an `Extractor<F>`. Candidates are `{ strategy,
extractor }` pairs. Duplicate strategy identifiers are refused at construction with a `TypeError`,
mirroring `compositeExtractor`'s duplicate-engine guard and for the same reason: the stamp would be
ambiguous.

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

**Files:** modify `packages/ribo-core/src/composite-extractor.ts`. **Do not touch
`composite-extractor.test.ts`.**
**Depends on Task 2.**

**Intent.** Prove the engine is general enough to express capability selection, and delete the
duplicated iteration. This is the task that makes design §3.1's "combinable in mechanism, separate in
surface" true rather than asserted.

**Interfaces.** `compositeExtractor`'s exported signature, its options, and every exported type are
unchanged. Internally it becomes: a capability probe adapted into the engine's admission hook (the
TTL cache and `invalidate()` stay here — the engine has no clock), plus an arbiter that accepts the
first result and gives up with any error, which is exactly rule 5. The "no entry ready" error is
built by composite's own factory so its wording is preserved byte-for-byte.

Keep the existing behaviours that live in this file and are not the engine's business: `needs-download`
is never admitted but is reported in the error; a probe that throws becomes an unavailable engine
rather than taking the caller down; duplicate engine ids are refused; `usage.engine` is stamped with
the winning engine.

**A note on stamping.** The engine now stamps `usage.strategy`. Composite must **not** acquire a
strategy stamp as a side effect — its existing test asserts `usage` equals `{ calls: 7, engine:
"managed" }` exactly, and an extra key fails it. Either pass the candidate identifier through in a way
that leaves `strategy` unset, or make stamping opt-in per constructor. Decide which and say so in your
report; the test is the arbiter of correctness here.

**Must-fail tests.** The gate is that **`composite-extractor.test.ts` passes unedited** — currently 7
tests. Run it before you start and record the count. Add no new tests to that file. If you believe a
test is wrong, stop and report rather than editing it.

Add one new test, in the engine's own test file rather than composite's: the engine invokes
candidates in order and skips non-admitted ones without invoking their extractors.

---

## Task 4 — Schema-parse failures become terminal

**Files:** modify `packages/ribo-extractor-openai/src/per-group.ts` and/or
`extraction-common.ts`; extend the corresponding tests.
**Independent of Tasks 1–3; may be done in parallel.**

**Intent.** Close the gap design §4.2 records. `isTransientFailure` defaults an unrecognised error to
retryable — deliberately, since a wrongly-`dead` transient failure loses a recording someone drove to
a house to make. A zod parse failure carries no HTTP status, so it classifies as **transient**, which
means `terminalFallsThrough` would not fall through on it and design §4.3's third row would be a lie.

A response that does not satisfy its schema will not satisfy it on a re-send of the identical request,
which is precisely the reasoning `assertStopFinishReason` already applies to truncation. So a
schema-parse failure must be thrown as a `TerminalQueueError`, with the zod issue text preserved in
the message so the failure is still diagnosable.

**Scope carefully.** This changes retry behaviour for the _existing_ extractor, independent of any
ladder: a parse failure that today burns the per-group retry budget will now fail fast. That is the
intended improvement, but it is a behaviour change to shipped code — call it out in the changeset,
and check whether any existing test asserts the current retrying.

**Must-fail tests.**

- A chat response that parses as JSON but violates the group schema throws a `TerminalQueueError`,
  and `isTransientFailure` returns false for it.
- That failure is **not** retried — assert the transport was called exactly once, which is the
  assertion that actually proves the budget is no longer burned.
- The thrown message still contains the offending path or issue text, so the failure stays
  diagnosable.
- A genuinely transient failure (503) is still retried, unchanged. Without this, a too-broad change
  that terminalises everything passes.

---

## Task 5 — `raceExtractor`

**Files:** create `packages/ribo-core/src/race-extractor.ts` and its test; modify `index.ts`.
**Depends on Task 2.**

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
- An arbiter that waits sees outcomes accumulate in **completion** order, not candidate order.
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

**§7's "a transient failure does not reach the arbiter until the candidate's retry budget is spent"
is not a combinator behaviour.** The combinator has no retry loop and never gains one; the retrying
belongs to the candidate, which is already `perGroupExtractor`'s tested behaviour. What this plan can
and does assert is the other half — Task 2's "the first extractor is invoked exactly once" — which
proves the combinator adds no retry of its own. Do not add retry to the engine to satisfy the design
sentence.

## Sequencing and review points

Tasks 1 → 2 → 3 are strictly ordered; each is independently reviewable and independently revertible.
Task 4 is independent and can run in parallel with any of them. Task 5 depends only on Task 2, so it
can run alongside Task 3 rather than after it.

**Task 3 is the risk.** It is the only task that touches shipped, exercised behaviour, and its gate is
an unedited test file. Review it before starting Task 4 if they are running concurrently, so a
regression there is not diagnosed through an unrelated change.
