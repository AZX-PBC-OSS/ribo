# Arbitration & Fallback

[Extraction](/guide/extraction) covers one `Extractor<F>` doing the work. Real deployments run more
than one — a managed strategy falling back to a weaker one, two strategies racing on a latency
budget, on-device rescuing an offline auditor — and composing them needs a decision vocabulary, not
a retry flag. "Try the next one" means something different depending on
_why_ the first one failed: a structurally broken request is worth handing to a different strategy;
a dead transport is not, because the next strategy shares it. A boolean can't carry that distinction.
An arbiter can.

## Why a fallback lives inside a strategy, not around it

A fallback belongs **inside** each `compositeExtractor` entry, not wrapped around the whole
composite. That keeps two different questions separate: "this strategy failed" is the arbiter's
concern, and "this engine is unavailable" is the composite's. Collapsing them into one flag would
make a single retry knob answer both at once, and get neither right in general.

## The shared engine and its outcomes

`fallbackExtractor`, `raceExtractor`, and `compositeExtractor` all sit on one shared engine. Each
settled candidate becomes an `ExtractionOutcome<F>` — a `candidate` id plus either a `result` or an
`error`, never both — and the arbiter is called after every settlement with an `ArbiterInput<F>`:
every outcome so far, **in settlement order**, and an `exhausted` flag that is true only once every
candidate has settled. Settlement order matters because it is not always dispatch order: under a
race, the second candidate started can be the first to settle.

The arbiter answers with one of three verdicts, named rather than boolean so a mistyped one is a
compile error instead of a silent wrong branch:

```ts
type ArbiterVerdict<F> =
  | { readonly accept: ExtractionResult<F> }
  | { readonly continue: true }
  | { readonly giveUp: unknown };
```

`accept` takes the winning result and stamps the winning candidate's id onto `result.usage.strategy`
(or `.engine`, for `compositeExtractor`). `continue` asks for the next candidate, and is refused by
the engine once every candidate has settled — an arbiter that says "keep going" with nothing left to
try is a caller bug, not a state to paper over. `giveUp` throws the supplied error, unchanged, and
lets the relay's own backoff handle it.

## `fallbackExtractor`: strategies in order

Try a list of strategies sequentially. Each one runs to completion before the next is even started;
the arbiter decides after each settlement whether to accept, move to the next strategy, or give up.

```ts
import { fallbackExtractor, terminalFallsThrough } from "@azx/ribo-core";

const extractor = fallbackExtractor(
  [
    { strategy: "instance-fill", extractor: strongExtractor },
    { strategy: "per-group-array", extractor: weakerExtractor },
  ],
  terminalFallsThrough,
);
```

## `raceExtractor`: strategies at once

Start every strategy at once instead of one at a time, and let the arbiter accept an outcome as it
lands, wait for more, or give up. Same candidate shape, same arbiter contract, same stamping — a
separate constructor rather than a concurrency flag on `fallbackExtractor`, so racing is opt-in by
name and never something a caller flips by accident.

## `compositeExtractor`: the extraction sibling of `firstCapable`

`compositeExtractor` selects between **engines**, not strategies within one engine: an ordered
roster, each entry probed through `capability()`, first one that reports `ready` wins. The shape is
identical to `firstCapable` on the transcription side — same caching, same `invalidate()` — but the
**preference order is inverted**. Transcription prefers on-device first, because it is free, private,
and fast enough when it fits, with a managed fallback for when it doesn't. Extraction prefers
managed first: an on-device model here is a few billion parameters running against a frontier
managed one, so it is accepted only when the managed path cannot run at all — in practice, no
network. Same combinator shape, opposite direction, because what's scarce is inverted between the
two seams.

## The `ExtractionArbiter` contract, and its two defaults

An `ExtractionArbiter<F>` is exactly the function shape above: `(input: ArbiterInput<F>) =>
ArbiterVerdict<F>`. `ribo-core` ships two. They are a pair — do not mix one with the transcription
arbiter below.

**`terminalFallsThrough`** is the conservative default: accept the first success; at exhaustion,
give up with the first error. In between, the direction runs opposite to what the name suggests on
a first read. A **terminal** error means the request itself was structurally broken — exactly what a
different strategy might fix — so the arbiter continues past it. A **transient** error means the
transport is down, and the next strategy on the same engine shares that transport, so continuing
would burn a worse strategy for nothing; the arbiter gives up and lets the relay retry the whole
extraction later instead.

**`acceptAnySuccess`** is the degraded-experience default: accept the first success, continue past
_any_ failure regardless of kind, and at exhaustion accept the first result if one exists or give up
otherwise. Naming it separately from `terminalFallsThrough`, rather than making it a mode flag on
the same function, is how a deployment opts into degrading on purpose instead of by omission.

## `SchemaParseError`: retryable, and recognisable at once

A model response can parse as JSON and still violate the extraction schema. `SchemaParseError` names
that failure and is deliberately **not** a `TerminalError`: the same request can miss the schema
once and pass on re-send, so the queue has to keep retrying it. But it also needs to be
_recognisable_, because `terminalFallsThrough` treats a schema-parse miss as a shape mismatch a
different strategy might avoid, and falls through to the next candidate rather than repeating the
same request shape. Both are true of the same error: nondeterministic enough to retry, specific
enough to hand to a different strategy. That is why it is its own class, not a generic `Error`.

## The judging layer: turning quality into an outcome an arbiter can see

Everything above arbitrates on **how a strategy failed**. But a strategy can also succeed badly —
return confident, well-formed, entirely fabricated fields — and nothing on this page can tell that
apart from a good result. The arbiter sees a fulfilled promise either way.

Four combinators close that gap. None of them produces a result; each wraps an `Extractor` and
either judges what came back or bounds what it cost. Because they express a verdict as a **thrown
error**, they plug into the vocabulary this whole page is built on: a rung that hallucinates can now
fall through exactly like a rung that threw.

```ts
import {
  consensusExtractor,
  validateExtractor,
  budgetExtractor,
  cachedExtractor,
  unanimousValues,
  rejectUngroundedCommitments,
} from "@azx/ribo-core";
```

### `validateExtractor`: an ungrounded result is a failure

`validateExtractor(extractor, { target, policy })` runs the inner extractor, tallies how well each
committed leaf is cited against the transcript, and hands that tally to a policy. The shipped
default, `rejectUngroundedCommitments`, rejects a leaf that **committed to a value, cited a span,
and the span is not in the transcript** — a fabricated quote. It deliberately does not reject a
near-miss (a citation the model reformatted) or an honest abstention.

A rejection throws `ValidationRejectedError`, which **extends `TerminalError`**. That is the
load-bearing detail and it is the opposite of the intuition: `terminalFallsThrough` _continues_ on
terminal and _gives up_ on transient, so terminal is what makes the ladder try the next rung.
Classifying it transient would make the ladder give up, the relay call the step failure retryable,
and the whole extraction re-run — hallucinating rung included — on backoff until `dead`. A
hallucination detector that becomes a full-price retry loop.

### `consensusExtractor`: agreement is a signal a model cannot assert about itself

`consensusExtractor(candidates, { target, arbiter })` runs a list of candidates over the same
transcript and compares the survivors leaf by leaf. Where they agree, the value passes through.
Where they disagree, the leaf comes back `value: null, confidence: 0` **with a citation kept** — the
same shape an abstention produces, so gap-fill already re-asks about it and review already flags it.
No new state, no migration.

This matters because [confidence carries no information](/guide/provenance): the on-device path
writes `1` when a leaf got a value and `0` when it did not. Agreement between independent samples is
something a model cannot fake by asserting it.

```ts
const extractor = consensusExtractor([managed, onDevice, managedAgain], {
  target,
  arbiter: unanimousValues,
  onContested: (path) => console.warn("contested", path.join(".")),
});
```

Four things to know before you reach for it:

- **It costs N times a single extraction.** Three candidates triple the bill and the wall clock.
  Choosing candidates is choosing a multiplier.
- **A candidate that fails is a missing sample, not a failed run.** The run continues while
  `minSamples` survived (default 2) and throws `ConsensusFailedError` below that. That error is
  **transient** — the reverse of `validateExtractor`'s, deliberately: falling below quorum usually
  means the transport is down, and the next rung shares it.
- **The first candidate is structurally authoritative.** Put your most trusted one first.
- **Instances are compared by position.** If two candidates find the same three rooftop units but
  list them in different orders, they are compared unit-1-against-unit-3 and reported as
  disagreeing. The output is still safe — disagreement nulls, it never fabricates — but the
  contested count is not a reliable measure of structural agreement. `unanimousValues` is the
  default because it fails safe here; `majorityValues` does not.

### `budgetExtractor`: a detector, not a governor

`budgetExtractor(extractor, { maxCalls, maxTotalTokens, … })` reads the returned result's usage
against your ceilings and throws `BudgetExceededError` when one is breached. Be clear about what
that is worth: **it cannot prevent the spend it reports.** A wrapper only learns the cost after the
work is done. It is honest around one strategy, where the number it reads is the number that
strategy spent; around a ladder it reports only the rung that happened to return.

It earns its place because after the agentic layer the call count is chosen by a model rather than
by a person, and an unbounded number nobody is measuring is how a bill becomes a surprise.

### `cachedExtractor`: memoise on the whole prompt, or not at all

`cachedExtractor(extractor, { target, cache, keyFor })` keys on the transcript text **and** the
instructions, examples and schema. Anything less serves a result computed against a different
prompt — data that parses cleanly and is wrong, which nothing downstream can detect. A failure is
never cached, and a broken cache degrades to a miss rather than taking extraction down with it. A
hit reports `calls: 0`, because a hit made no model calls and a budget reading otherwise would book
a spend that never happened.

### Two limits that are not bugs

`consensusExtractor` and `validateExtractor` both work by walking per-leaf provenance envelopes, so
they **refuse `"row"` and `"none"` provenance groups at construction** rather than silently judging
nothing. And none of the four inspects a strategy's internals — they see what an `Extractor`
returns, which is what makes them composable over every strategy on this page.

## Within one strategy: phases, retries, timeouts

Arbitration chooses **between** strategies — that is everything above. A multi-pass strategy also
has an **inside**, and the inside is a composition now too: the successive passes are a list of
phases over a shared draft, run by `phasedExtractor`. The split is exactly the two axes of this
page's opening: arbitration picks one strategy from several; phases are the steps within one.
[Extraction](/guide/extraction#phased-composition-a-multi-pass-strategy-is-a-list-of-phases) covers
that layer; this page stays between strategies.

Two wrappers landed alongside it and are independently useful over any `Extractor`:

- **`retryExtractor(extractor, options)`** wraps one extractor with the attempt loop — transient
  failures retried with full-jitter backoff, terminal errors and cancellations rethrown untouched.
- **`timeoutExtractor(extractor, options)`** races one extractor against a deadline, with an
  `AbortSignal` the inner extractor can honour. Its `ExtractionTimeoutError` is deliberately **not**
  cancellation-branded — a deadline elapsing and a caller cancelling are different events, and the
  missing brand is what makes `isTransientFailure` treat a timeout as transient, so an **outer**
  `retryExtractor` retries it: a per-attempt deadline with retries around it, which is the
  composition worth having. A cancellation-branded timeout would make that composition silently do
  nothing.

## The transcriber siblings

Transcription has the same composition problem, solved with a parallel vocabulary, not a shared
module: a `Transcript` carries no field map to stamp a strategy onto, and the transcriber error
vocabulary (`UnsupportedItemError`, `TranscriberUnavailableError`) is not the extractor's.

- **`firstCapable`** selects an **engine** by calling `capability()` on each candidate in
  preference order and running the first one that answers `ready`. It is the transcription
  counterpart of `compositeExtractor`, not of `fallbackTranscriber` below.
- **`fallbackTranscriber`** tries transcribers **in order, per item, without consulting
  `capability()` at all**, and lets a caller-supplied arbiter judge each settled outcome.
  **`fallbackTranscriber` is not "`firstCapable` with retries."** `firstCapable` asks "which engine
  can run at all, right now" —
  an engine-level question a cached capability answer can settle in advance. `fallbackTranscriber`
  asks "did running this engine on _this_ item work" — a question `capability()` cannot answer,
  because a `ready` engine can still fail on one specific document, and there is no capability
  bucket for "this engine, this item."
- **`hedgedTranscriber`** races a preferred engine against a fallback on a latency budget — a sibling of
  `firstCapable`, not a scheduling flag inside it, for the same reason `raceExtractor` is a separate
  constructor from `fallbackExtractor`: concurrency opted into by name stays visible in a way a
  boolean does not.
- **`unsupportedFallsThrough`** is the default arbiter `fallbackTranscriber` is built to be handed:
  - It accepts the first success.
  - At exhaustion it gives up, preferring a retryable error over a terminal one if both are present.
  - It continues past an `UnsupportedItemError` or a `TranscriberUnavailableError`, because both mean
    "not this engine" and demoting the engine for next time is `firstCapable`'s job, not the
    ladder's.
  - Anything else gives up immediately, because that is an ordinary attempt failure the queue already
    owns.

  This is **not** the same default as `terminalFallsThrough` — the two arbiters answer different
  questions for different seams, and reusing one where the other belongs would apply the wrong retry
  policy to the wrong failure vocabulary.

**API pages:** [`fallbackExtractor`](/api/fallback-extractor) and the arbitration wrappers — the
ladder, the two shipped arbiters, `SchemaParseError`'s retryable-but-recognisable behaviour, and
the retry/timeout/hedge/consensus/cache/budget family as one overview.

## Next

[Extraction](/guide/extraction) covers the single-strategy seam these combinators compose, and the
phased composition inside one.
[Schema at Scale](/guide/schema-at-scale) covers `instanceLadder`, the concrete `fallbackExtractor`
ladder that turns a partitioned schema into real per-instance data. [Captures & Sources](/guide/captures-and-sources)
covers `firstCapable`, `fallbackTranscriber`, and `hedgedTranscriber` from the transcription side, composing
audio and document engines into one roster.
