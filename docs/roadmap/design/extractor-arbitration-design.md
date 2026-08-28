# Extractor Arbitration — Design

**Date:** 2026-08-27
**Author:** AZX
**Status:** Draft — ready for review
**Task:** Prerequisite infrastructure for R1.6's instance-modeling extraction strategy
(`r1.6-instance-extraction-design.md`), and independently useful on its own.
**Authority it corrects:** [`composite-extractor.ts`](../../../packages/ribo-core/src/composite-extractor.ts)'s
selection rule 5, which forbids exactly the behaviour this design adds — deliberately, and which
therefore stays true of `compositeExtractor` itself.
**Depends on:** R3 (the per-group extractor and its failure classification)
**Blocks:** the tiered segmentation strategy in `r1.6-instance-extraction-design.md`

---

## 1. Goal

**There is no way to say "try this extraction strategy, and if it cannot run, try a worse one."**

`compositeExtractor` chooses an engine by probing its capability, then runs it to completion. Its
rule 5 is explicit that an error propagates untouched and the composite does not fall back
mid-extraction. That rule is correct for what it governs — a mid-extraction transport switch would
invalidate the timing budget the delegate was configured for — but it means the only recovery
available to a failing extraction is the relay's backoff and, eventually, `dead`.

That is the right answer when the failure is transient. It is the wrong answer when the failure is
_structural to the request we sent_ — a response that truncated, a response that would not parse
against a schema the model has never been asked for before — because re-sending an identical request
reproduces an identical failure. `assertStopFinishReason` already knows this and classifies
truncation as `TerminalQueueError` for that exact reason. What is missing is somewhere for a
terminal failure to go other than the floor.

This design adds that: a combinator that selects among **strategies by outcome**, alongside the
existing one that selects among **engines by capability**.

## 2. Why this is not just "add a try/catch"

Three things make it a contract rather than a helper.

**The accept/reject judgement is domain knowledge, and the core does not have it.** Whether a result
is good enough is not answerable from an `ExtractionResult` alone. "Did this segment the house
acceptably" is a question about audit data. `ribo-core` deliberately does not know what a real-time
factor is (`hedged`), and `SelectableCapability` is structurally typed precisely so a core combinator
does not import any one engine's vocabulary. The same discipline applies here: **the core accumulates
outcomes and calls out to an arbiter the host supplies.**

**"Degraded is better than nothing" is a deployment policy, not an SDK opinion.** A field app whose
auditor is standing in a basement with no connectivity is better served by a single-instance record
than by no record. A batch importer is not. An earlier revision of this design tried to legislate
that with an invariant forbidding strategies below a quality floor; that was the wrong layer. The
arbiter is where the decision belongs, and the mechanism that makes it expressible is §4.3's
exhaustion call.

**Silent degradation is worse than the failure it replaces.** A fallback nobody can see is a quality
collapse that reads as success. If a roster schema is subtly malformed and every extraction quietly
runs the degraded strategy, the corpus measures the degraded strategy while we read the numbers as
the primary one's. §5 is not optional polish; it is the thing that makes the mechanism safe to have.

## 3. The shape these combinators share

`compositeExtractor`, `hedged` and the fallback proposed here are one shape with four knobs.

| Knob            | What it decides                     | `compositeExtractor` | `hedged`         | fallback           |
| --------------- | ----------------------------------- | -------------------- | ---------------- | ------------------ |
| **Candidates**  | what may run                        | engines              | two transcribers | strategies         |
| **Admission**   | may this candidate be tried at all? | capability probe     | capability probe | none               |
| **Scheduling**  | when does the next candidate start? | on demand            | after a delay    | on failure         |
| **Arbitration** | given what is back, are we done?    | none                 | first to finish  | outcome classifier |

`raceExtractor` is a fourth setting of the same knobs — no admission, concurrent scheduling, an
arbiter over accumulated outcomes. It is discussed in §4.5, including why it has no admission gate.

The genuine difference is that **`compositeExtractor` gates before running and fallback gates after**,
and neither has the other's gate.

### 3.1 What this design does _not_ unify, and why

`hedged` and `firstCapable` are **`Transcriber`** combinators. `compositeExtractor` is the only
extractor-side one. A single engine spanning both seams would have to be generic over the delegate
operation (`Recording → Transcript` versus `string → ExtractionResult<F>`), which is possible but
means refactoring shipped transcriber behaviour carrying eight documented resolution rules.

One of those rules is not a convenience. `hedged`'s file header states:

> A deployment that will not let audio leave the device simply never calls `hedged`; the default
> composition stays privacy-preserving.

That property is **structural today** — you cannot accidentally obtain concurrency, because the
constructor you called has no parameter for it. A single configurable combinator with a scheduling
knob converts a type-level fact into a boolean somebody can flip, and starts shipping audio off the
device. `compositeExtractor`'s rule 5 is load-bearing in the same way.

**So the resolution is: combinable in mechanism, separate in surface.** One shared engine
implementing the four knobs; the combinators stay thin, differently-typed constructors that each pin
the knobs they must not expose. Duplication goes away; the guarantees stay structural.

**The engine ships exported, not module-private, and the guarantee survives that.** An earlier draft
of this paragraph said "internal", and the implementation exports it — this is the corrected text,
not a drift to tolerate. What makes §3.1's property structural is not the engine's privacy but the
fact that scheduling is chosen by **which function you call** rather than by a parameter: there is a
`createSequentialExtractor` and a `createConcurrentExtractor`, and no `{ scheduling }` flag anywhere
to flip. Concurrency therefore still has to be asked for by name even by a caller reaching past the
constructors. Exporting it is deliberate for a published SDK, where a consumer writing a combinator
we did not anticipate — a different admission policy, say — would otherwise have to reimplement the
iteration, validation and stamping we just centralised.

**This cut unifies the extractor seam only.** The transcriber combinators are left exactly as they
are. Generalising the engine across both seams is recorded in §8 as a stated future, to be done
against a passing transcriber suite rather than speculatively.

## 4. Design

### 4.1 The arbiter

The host supplies a function. The core calls it each time an outcome lands, with every outcome so
far in candidate order.

```ts
type ExtractionOutcome<F> =
  | { readonly candidate: string; readonly result: ExtractionResult<F> }
  | { readonly candidate: string; readonly error: unknown };

interface ArbiterInput<F> {
  /** Every outcome so far, in the order they SETTLED — not the order candidates were started. */
  readonly outcomes: readonly ExtractionOutcome<F>[];
  /** True when every candidate has settled. The arbiter must accept or give up. */
  readonly exhausted: boolean;
}

type ExtractionArbiter<F> = (
  input: ArbiterInput<F>,
) => { accept: ExtractionResult<F> } | { continue: true } | { giveUp: unknown };
```

**Both fields mean settlement, not dispatch, and under sequential scheduling the distinction is
invisible** — candidates settle in the order they start. Under `raceExtractor` it is load-bearing in
two places, so it is pinned here rather than left to each constructor. If `outcomes` were dispatch-
ordered, `terminalFallsThrough`'s "give up with the first error" would name a different error
depending on scheduling. And if `exhausted` meant "no candidate left to **start**", it would be true
on a race's very first call, making `continue` illegal every time and a race unbuildable.

Three verdicts, and the third is not the same as the second at exhaustion:

- **`accept`** — this result is good enough. The combinator returns it. The accepted result must be
  one drawn from `outcomes`; returning a synthesised result is a validation error, because a result
  that no candidate produced has no provenance and `usage` would be a lie.
- **`continue`** — keep going. Legal only when `exhausted` is false; returning it at exhaustion is a
  validation error rather than a silent throw, so an arbiter that forgot to handle the last call
  fails loudly on its first run rather than intermittently in the field.
- **`giveUp`** — stop and throw the supplied error. This is how an arbiter declines a degraded
  result: at exhaustion it looks at what it has and decides a single-instance record is not worth
  writing, so the item goes to the relay's backoff and `dead` handling exactly as today.

**The exhaustion call is the load-bearing part of this contract.** It is what makes "allow a degraded
experience" expressible without the SDK ranking strategies by quality. The last strategy on the
ladder is not privileged and not forbidden — it is offered, and the host decides.

### 4.2 Default arbiters

A contract nobody can use correctly is not a contract. Two are supplied, and they are the ones we
expect real callers to want:

- **`terminalFallsThrough`** — accept the first successful result; continue past a failure only when
  `isTransientFailure` says the error is **not** retryable; give up immediately on a transient error,
  and at exhaustion give up with the first error. The conservative default.
- **`acceptAnySuccess`** — accept the first successful result, continue past any error, and at
  exhaustion accept the best result available or give up if there is none. This is the
  degraded-experience arbiter, and naming it is how a deployment opts into degradation deliberately
  rather than by omission.

**`terminalFallsThrough`'s direction is the opposite of what it first looks like, and an earlier
revision of this section had it backwards.** By the time an error reaches the arbiter the candidate
has already spent its own retry budget, so the two cases mean different things. A **terminal** error
says the request we sent is structurally broken — that is precisely what the next strategy's
different request shape might fix, so fall through. A **transient** error that survived retries says
the transport is down, and the next strategy on the same engine uses the same transport, so running
it now is futile: give up and let the relay's backoff retry the whole extraction later, when the
network may be back. Continuing on transient would burn the degraded strategy at the worst possible
moment and cache its worse result.

**A consequence that lands on the strategies, not on this file — and the obvious fix for it is
wrong.** `isTransientFailure` defaults an unrecognised error to retryable, deliberately, since a
wrongly-`dead` transient failure loses a recording. A zod parse failure carries no HTTP status, so it
classifies as transient and `terminalFallsThrough` would **not** fall through, contradicting §4.3.

The obvious fix is to throw parse failures as `TerminalQueueError`, the way `assertStopFinishReason`
already does for truncation. **Do not do that.** Truncation at a fixed `maxTokens` is deterministic —
re-sending reproduces it exactly, which is what makes it terminal. A schema miss is **sampled**: the
same request can fail zod once and pass on re-send. `parseWithSchema`'s own doc comment already makes
this argument, and it is right. Worse, the cost is asymmetric by path: strict structured outputs make
a schema miss rare on the managed path, but the on-device path — the one this whole design exists to
rescue — has no server-side `strict`, so an occasional one-off miss is its **expected** failure mode.
Terminalising would remove both the per-group retry and the relay's backoff for exactly the offline
recording that has no second chance.

The conflation to avoid is this: **we want the ladder to fall through, not the queue to stop
retrying.** Those got fused only because the arbiter's sole signal is the error. So give the parse
failure its own error type that `isTransientFailure` still classifies as **transient**, and let the
arbiter recognise the type directly. The queue keeps retrying, `parseWithSchema`'s argument stays
true, the tests asserting transience stay green, and §4.3's third row is satisfied. A default arbiter
falls through on a not-retryable error **or** a schema-parse error.

A host that wants a quality judgement — _did this actually segment anything_ — writes its own. That
is the case `r1.6-instance-extraction-design.md` needs, and it is why the input carries results and
not merely errors.

### 4.3 What triggers moving on

The combinator does not classify errors itself; the arbiter does, and the defaults above use the
existing vocabulary. But the intended discipline is worth stating, because it is what the R1.6
arbiter will implement and getting it backwards is expensive:

| Failure                                             | Response                                                                                                                                                                                                                    |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transient (network, 429, 5xx)                       | The candidate's **own** bounded retry runs first. Only an exhausted budget reaches the arbiter. Falling on the first blip would let one hiccup permanently downgrade an item's quality.                                     |
| Terminal (`finishReason: "length"`, content filter) | Move on **immediately**, no retry. Re-sending is documented to truncate at the identical point, but the next strategy has a different request shape and may simply fit. This is the strongest case for the whole mechanism. |
| Schema-parse failure                                | Move on. The likeliest failure for any strategy whose response shape is new, which is exactly the R1.6 roster.                                                                                                              |

### 4.4 Placement in a composition

The fallback goes **inside** each `compositeExtractor` entry, not around the composite:

```
compositeExtractor([
  { source: managedCapability,  extractor: fallbackExtractor([tier1, tier2, tier3], arbiter) },
  { source: onDeviceCapability, extractor: fallbackExtractor([tier2, tier3],        arbiter) },
])
```

Each engine gets its own strategy ladder, and the composite keeps selecting engines by capability.
Wrapping the outside instead would let a strategy failure silently jump from the managed model to
the on-device one — conflating _this strategy failed_ with _this engine is unavailable_, which are
the two axes the composite exists to keep apart. Note also that the ladders differ per engine:
there is no requirement that every engine offer every strategy.

Cascading is therefore composition, not a new combinator. `compositeExtractor` keeps rule 5 intact
and untouched, because a `fallbackExtractor` that gives up throws, and the composite propagates that
error exactly as it does today.

### 4.5 `raceExtractor`

Falls out of the same engine with the scheduling knob set to concurrent, and is included in this
design because it is what makes the arbiter's accumulated-outcomes input worth having: an arbiter
called as each result lands can accept early or wait for a better one, which is strictly more useful
than "first to finish."

It is a **separate constructor with no scheduling parameter**, per §3.1, and that separation is doing
real work rather than mirroring `hedged` for symmetry's sake.

The privacy exposure is smaller here than on the transcriber seam but it is **not zero**, and an
earlier draft of this section wrongly said it was. A sequential ladder reaches a managed engine only
when the ones before it failed; a race reaches every raced candidate every time. For extraction the
default composition already prefers managed-first (`composite-extractor.ts` inverts the transcriber's
preference on purpose), so racing usually reveals the transcript to nobody new — but a host that
deliberately ordered an on-device engine first for privacy reasons would have that intent silently
reversed by a scheduling flag. Keeping `raceExtractor` a distinct constructor means concurrency is
always something a caller asked for by name, which is the same property `hedged` protects, obtained
the same way.

**`raceExtractor` has no admission gate, and that is a decision rather than an omission.** The
four-knob table in §3 lists admission for `compositeExtractor` and `hedged` and omits race entirely,
which left the asymmetry looking accidental — it was asked about, the answer had to be reconstructed
from the code, and the likely "fix" from a reader who reconstructs it differently is to add a probe.
So it is written down here.

**A probe buys laziness, and a race has no laziness to buy.** Sequential admission is worth its cost
because it lets the engine probe candidate N only after N−1 is refused, and probe nothing once one
is admitted. A race starts every candidate immediately, so there is nothing behind a winner to skip.
Adding admission means either probing all candidates up front — paying the latency in full — or
gating each before starting it, which serialises the start and stops it being a race. Both trade
away the round-trip a race exists to remove.

**And the hazard admission would guard against is already handled, one layer down.** For the
on-device path, `SessionHolder` probes availability before `LanguageModel.create()` and throws a
typed `SessionCapabilityError` rather than proceeding; Chrome independently refuses to begin a model
download from a background context, because that needs user activation. So an unadmitted candidate
in a race produces a safe, typed, diagnosable error outcome — which the arbiter already handles and
can fall through from. Defence in depth belongs in the extractor, which is the only component that
knows what "ready" means for itself, rather than replicated into every combinator that might compose
it.

**The known limit, stated rather than discovered.** `compositeExtractor`'s rule 2 — never select a
`needs-download` engine, because that fetch needs a human's consent and a background drain cannot
obtain one — is a **policy the concurrent path cannot express**. A race will attempt such an engine
and get a clean failure instead of skipping it. The behaviour is correct and the cost is a wasted
call plus a worse first error; it is only reachable by a consumer who races an on-device engine, and
nothing in this repo does. If that changes, this is the paragraph to revisit.

**What a probe actually costs, since the asymmetry only makes sense with the number.** On the managed
path `capability()` reads an in-memory `connectivityStatus` kept current by a subscription — a
boolean comparison, no I/O. On the on-device path it is a local `availability()` lookup. Both are
effectively free, which is why sequential admission is worth having at all: it turns a `fetch` that
hangs to timeout on every item of an offline queue drain into a boolean read. **The probe is
advisory, not authoritative** — it is TTL-cached and connectivity can drop between probe and extract
— so failure handling is required regardless. It avoids the predictable case; it does not replace
the error path.

## 5. Observability

The accepted candidate's identity lands on `ExtractionResult.usage`.

`usage` is `{ calls: number; engine?: string }` today, and `engine`'s doc comment already states the
rationale for an optional provenance field in the terms this needs:

> It exists because a review card has to be able to say "this draft came from the on-device beta
> model" — the reviewer's question is not which engine produced field 12, it is whether to trust this
> card less than usual.

A `strategy?: string` alongside it is the same field doing the same job for a different axis. It is
additive and optional for the same documented reason `engine` is: `FakeExtractor` and the two
existing extractors report `{ calls }` and nothing else, and requiring it would break every existing
implementation for the benefit of one.

Two consequences follow, and both matter more than the field does:

- **A degraded result is labelled by construction**, not by anyone remembering to label it.
- **Any measurement run must report strategy distribution**, or its headline number is not measuring
  what its title says. A corpus run in which 40% of items fell to tier 2 is a different number from
  one where none did, and the two are indistinguishable without this.

## 6. What changes where

| Package / file                            | Change                                                                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `ribo-core/extractor.ts`                  | `usage` gains optional `strategy`                                                                                        |
| `ribo-core/arbitration.ts` _(new)_        | the four-knob engine, `ExtractionOutcome`, `ArbiterInput`, `ExtractionArbiter`, default arbiters                         |
| `ribo-core/fallback-extractor.ts` _(new)_ | `fallbackExtractor(candidates, arbiter)` — sequential, no admission gate                                                 |
| `ribo-core/race-extractor.ts` _(new)_     | `raceExtractor(candidates, arbiter)` — concurrent, no admission gate                                                     |
| `ribo-core/composite-extractor.ts`        | reimplemented over the engine; **public behaviour and rule 5 unchanged**, proven by its existing suite passing untouched |
| `ribo-core/index.ts`                      | exports                                                                                                                  |

`hedged.ts`, `first-capable.ts` and every transcriber path: **no change**.

## 7. Testing

The must-fail tests, stated as the behaviours that would be broken:

- A candidate list whose first entry throws a terminal error and whose second succeeds returns the
  second's result, and makes exactly one call to the first.
- A transient error does **not** reach the arbiter until the candidate's own retry budget is spent.
- An arbiter returning `continue` at exhaustion raises a validation error naming the arbiter, not a
  generic throw from inside the engine.
- An arbiter returning an `accept` whose result is not in `outcomes` raises a validation error.
- `giveUp` propagates the supplied error unchanged, so `isTransientFailure` and the relay's `dead`
  handling classify it exactly as they would without the combinator in the path.
- `usage.strategy` names the accepted candidate, including when the accepted candidate is the first.
- Every discarded promise in `raceExtractor` has a rejection handler, so a losing failure never
  surfaces as an unhandled rejection — the same guard `hedged` documents.
- `compositeExtractor`'s existing suite passes with no edits. This is the regression gate for the
  reimplementation, and it is the reason rule 5 can be claimed to survive rather than asserted to.

## 8. Out of scope, recorded so it is not rediscovered

- **`usage.strategy` stops at the `ExtractionResult` and never reaches review.** Stated here because
  §5's own motivating scenario is a reviewer trusting a degraded card less, and this increment does
  not deliver that. `toExtractStep` forwards only `fields` and `usage.engine`, so every production
  extraction drops the strategy label at the relay boundary — it reaches no outbox column, no relay,
  no card. Closing it means widening `ExtractStep` and the outbox schema the way `engine` was widened
  for the on-device work, which is a relay change and does not belong in a combinator increment.
  **The R1.6 consumer must not assume the label reaches review**; if it needs that, it owes the
  widening.

- **Cross-seam unification.** Making the engine generic over the delegate operation so `firstCapable`
  and `hedged` share it. Real, and worth doing against a passing transcriber suite once the extractor
  side has proven the shape. Not done blind, and not done in the same change that introduces the
  engine.
- **A transcriber-side arbiter.** Same reasoning.
- **Cost accounting across candidates.** A ladder that runs three strategies bills for three. `usage.calls`
  currently reports the accepted candidate's calls; whether it should report the total is a real
  question and is deliberately left as-is here rather than changed in passing.

## 9. Open questions

1. **Does `usage.calls` mean "calls that produced this result" or "calls this extraction cost"?**
   They diverge the moment a ladder runs more than one candidate. Today the question does not arise.
   Listed rather than answered because the answer belongs to whoever first needs the number for
   billing, and guessing now sets a precedent for them.
2. **Should the arbiter be async?** A quality judgement that needs to consult anything outside the
   result would need it. Nothing in R1.6 does, and a synchronous callback is much harder to misuse
   inside a retry loop. Proposed: synchronous, revisited on a real need.
