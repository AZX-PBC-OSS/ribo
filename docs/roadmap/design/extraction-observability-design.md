# Extraction observability — design

One progress hook, every strategy. A full Manual J extraction is 16 model calls and six to ten
minutes; the reviewer sees nothing for that entire time, and "nothing" is indistinguishable from
"hung". Every strategy already divides the work into units and completes them one at a time.
Nothing announces a unit finishing. That is the whole gap.

**Provenance.** Everything from §1 down is the original request, reproduced verbatim from
`RIBO-OBSERVABILITY-PROMPT.md`. §0 records what changed once the code was read — read it first,
because four of its entries contradict the request.

## 0. Amendments made during planning

These were settled against the tree at `258e4af`, not assumed.

**0.1 A sixth unit, not five.** `gapFillExtractor` (`ribo-extractor-openai/src/gap-fill/gap-fill.ts`) is a
strategy the request does not list. It wraps any base extractor and makes ONE focused follow-up
call over the leaves the base left as `value: null` with a non-null `sourceSpan`. That call is a
unit of work, it is invisible today, and it is none of the other five. It gets `unit: "gapfill"`
carrying `candidates` — how many abstained leaves the follow-up is asking about. On the
passthrough path (no candidates) it makes no call and emits nothing, matching its documented "no
second call, no wrapper object, no usage change".

**0.2 `InstanceUnit` needs `part`/`parts`.** The request gives `part`/`parts` to `GroupUnit` only.
But `scopedInstanceExtractor` calls `splitExtractionSchema` with the same union cap the per-group
extractor uses, so tier 1 partitions too — one fill call per piece per instance. Without
`part`/`parts` two calls for the same `(group, instance)` are indistinguishable except by their
opaque id, which is exactly the "parsing an internal convention" the structured fields exist to
avoid. Added, with the same 1-based `1 of 1` convention.

**0.3 `fallbackExtractor` does not build its candidates.** Ask 2's premise is that
`fallbackExtractor` and `instanceLadder` both "build their candidates from options they are
handed". Only `instanceLadder` does. `fallbackExtractor(candidates, arbiter)` takes
already-constructed `Extractor` instances, as do `raceExtractor` and `compositeExtractor` — there
is no options object to thread `onUnit` into, and an already-built extractor cannot have an
observer injected after the fact.

The consequence is smaller than the request feared and different in kind: units are **not** lost,
because the consumer configured each candidate itself and its `onUnit` fires normally. What is
lost is **attribution** — the composite cannot stamp `strategy` onto events emitted by an
extractor it did not construct. So:

- `instanceLadder` threads `onUnit` into all three tiers and stamps each tier's id. This is where
  Ask 2's real risk lives and where its test belongs.
- `fallbackExtractor`, `raceExtractor` and `compositeExtractor` keep their signatures. Core
  exports `stampStrategy`, the one-call wrapper `instanceLadder` uses internally, so a hand-rolled
  ladder gets identical attribution without tracking state.

**0.4 The retry budget is derived by duplicated code, and that is the thing to fix.**
`deriveMaxRetries` and `maxAccumulatedBackoff` exist twice — in `per-group.ts` and in
`instance-fill.ts` — byte-identical apart from one local variable name and an `export` keyword.
Ask 3 adds `onRetryBudget` and `requireRetryBudget` to both, which would be the third copy and the
point at which they drift. `deriveMaxRetries` is not in `ribo-extractor-openai`'s public index, so
the hoist is free: one derivation moves to `ribo-core`, beside `fullJitterDelay`, and returns the
`RetryBudget` event shape rather than a bare number. A retry _library_ was considered and
declined — p-retry, cockatiel and async-retry implement retry execution; this is the inverse
problem (solve for the attempt count that fits a deadline) and none of them answer it.

**0.5 `derived === 0` is an event, with an opt-in throw.** Non-negotiable 2 ("no behaviour change
when absent") settles the default: `onRetryBudget` fires whenever the budget was reduced, and
`requireRetryBudget` (default `false`) is what turns a derived-to-zero budget into a throw. The
default must stay non-throwing because the current production wiring _does_ derive to zero — at
16 calls and concurrency 2 the defaults leave no budget at all — so throwing by default would
break the live path in the same change that makes it visible. `perGroupExtractor` derives at
construction and throws a plain `Error` there; `scopedInstanceExtractor` cannot derive until the
roster is back, so it throws a `TerminalQueueError` from `extract()` — no retry fixes a
configuration error, and the queue should say `dead` rather than burn the attempt budget.

**0.6 The relay discriminant is built at the callback boundary, not persisted.** Ask 5 proposes a
`kind` on the session document, calling it cheap. It is not: `SessionItem` is a persisted RxDB
document, and `session-schema.ts` records at length that adding a property without a version bump
is refused at `addCollections` — and because `openOutboxDatabase` adds `outbox` and `sessions` in
one call on one database, a rejected open takes the outbox down with it, stranding an auditor's
recordings and their audio attachments on the device. A `kind` on the documents means sessions
v2 → v3 _and_ outbox v6 → v7, both with migrations and both with a `z.preprocess` stamp rather
than a `.default()` (zod reads the raw discriminator before defaults run).

The stated gap is that `RelayOptions.onError` cannot tell a recording from a session without
probing for `audioReady`. That is fully closed at the boundary: `onError` takes a tagged
`RelaySubject` the relay constructs at call time, where the two are already distinguishable. It
narrows under `switch`, it is breaking for `onError` consumers, and it touches no persisted
schema.

**0.7 `onCall` was never public.** The request asks to retire `ThreePhaseExtractorOptions`'
`onCall`. There is no such option — `onCall` is an internal parameter threaded through the four
phase helpers from a local `recordCall` closure. Retiring it means the internal counter becomes
the observer's emitter and the call count derives from it; nothing public is removed.

**0.8 `ExtractionOutcome` gets a tag; `ArbiterVerdict` does not.** The `?: never` idiom on
`ExtractionOutcome` already produced one documented near-miss — an error outcome written with an
explicit `result: undefined` read as a SUCCESS under `"result" in outcome` — and
`ResultOutcome`/`FailureOutcome` being hand-written `Extract<>` aliases is the manual version of
what a tag does. It gets one. `ArbiterVerdict`'s three arms already carry three distinct required
key names, narrow correctly under `in`, and have no bug history; tagging them would rewrite every
arbiter in the repo and every consumer arbiter for no new safety. Declined, and recorded here so
the next reader does not re-open it.

## 1. The problem

A full Manual J extraction is 16 model calls and **six to ten minutes**. The reviewer sees
nothing for that entire time, and "nothing" is indistinguishable from "hung".

Every strategy already divides the work into units and completes them one at a time.
**Nothing announces a unit finishing.** That is the whole gap, and it is one gap rather than
several:

| strategy                               | its unit of work                                       | units on a real Manual J           |
| -------------------------------------- | ------------------------------------------------------ | ---------------------------------- |
| `singleShotExtractor`                  | the whole document                                     | 1                                  |
| `perGroupExtractor`                    | a group, or one part of a partitioned group            | 16                                 |
| `scopedInstanceExtractor` (tier 1)     | the inventory pass, then each `(group, instance)` fill | 1 + N                              |
| `fallbackExtractor` / `instanceLadder` | a candidate strategy                                   | 1–3, each expanding into the above |

## Ask 1 — `ExtractionObserver`, a shared options mixin

One hook, declared once, inherited by every extractor's options — the pattern
`BackoffOptions` already establishes (`PerGroupOptions`, `ScopedFillOptions` and
`RelayOptions` all extend it).

```ts
/**
 * Observation points shared by every extraction strategy.
 *
 * `U` is the set of units the extractor being configured can actually emit, so an options
 * type states its own vocabulary rather than every consumer handling events that will
 * never arrive. The default keeps the general case general.
 */
export interface ExtractionObserver<U extends ExtractionUnit = ExtractionUnit> {
  /** Called as each unit of extraction work starts and settles. Must not throw. */
  onUnit?: (event: U) => void;
}
```

```ts
export interface PerGroupOptions<V>
  extends BackoffOptions, ExtractionObserver<GroupUnit> { … }
export interface ScopedFillOptions<V>
  extends BackoffOptions, ExtractionObserver<InventoryUnit | InstanceUnit> { … }
export interface SingleShotOptions<V> extends ExtractionObserver<WholeUnit> { … }
export interface LadderOptions<V> extends ExtractionObserver { … } // the full union
```

`onUnit` is a **parameter** position, so this narrowing costs a consumer nothing. Because
the hook is declared as a property with a function type, `strictFunctionTypes` checks it
contravariantly, and one broadly-typed handler is assignable to every site:

| passed                                           | to                                   | result                             |
| ------------------------------------------------ | ------------------------------------ | ---------------------------------- |
| `(e: ExtractionUnit) => void`                    | `ExtractionObserver<GroupUnit>`      | assignable                         |
| `(e: GroupUnit) => void`                         | `ExtractionObserver<ExtractionUnit>` | **rejected**, correctly            |
| a ladder's own `onUnit`                          | a `perGroupExtractor` it constructs  | assignable — Ask 2 threads cleanly |
| `case "instance"` in a handler typed `GroupUnit` | —                                    | **compile error**, not dead code   |

(Checked against `tsc --strict`, not assumed.) So a progress panel still writes one handler
for the whole run, and a consumer that wants only one tier gets told when it is handling an
event that cannot occur. One caveat, worth knowing rather than fixing: a single-variant `U`
is an intersection, not a union, so the `const _: never = e` exhaustiveness idiom does not
apply at a narrow site — the fields are just read directly, which is the point.

The cost is worth naming but is **accepted**: widening an extractor's declared set is a
breaking change for a narrowly-typed handler. That is the same exposure a non-generic union
has when a variant is added, except localised to the extractors that gained an event rather
than every consumer that switches. Take the parameterised version; a widening later is a
major changeset, and the changeset should say which set widened and why, so a consumer's
compile error arrives with its explanation.

The variants are exported individually (`WholeUnit`, `GroupUnit`, `InventoryUnit`,
`InstanceUnit`) as well as in the union, since the parameter now names them.

**The event is a discriminated union, not one interface with optional fields.** That
distinction is the whole difference between "shared" and "vague": a `"whole"` unit has no
part number and a `"group"` unit has no instance index, so a single flat shape would carry
four fields that are meaningless three-quarters of the time and a consumer would have to
know which combinations are real.

```ts
/** Fields every unit carries, whatever divided the work. */
interface UnitBase {
  /**
   * Stable across this unit's `start` and its `done`/`error`, so a consumer correlates the
   * two without bookkeeping.
   */
  readonly id: string;
  readonly phase: "start" | "done" | "error";
  /** 1 on the first try. The only way a retry is observable at all — see Ask 3. */
  readonly attempt: number;
  /** The composing strategy, when one is running, so a unit is attributable to its tier. */
  readonly strategy?: string;
  /** On `"done"`. */
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
  /** On `"error"`. */
  readonly error?: unknown;
}

export type ExtractionUnit =
  /** `singleShotExtractor`: the document in one call. */
  | (UnitBase & { readonly unit: "whole" })
  /** `perGroupExtractor`: one group, or one part of a partitioned group. */
  | (UnitBase & {
      readonly unit: "group";
      readonly key: string;
      readonly part: number;
      readonly parts: number;
    })
  /** `scopedInstanceExtractor`: the house-wide roster pass. */
  | (UnitBase & { readonly unit: "inventory" })
  /** `scopedInstanceExtractor`: one instance's fill. */
  | (UnitBase & {
      readonly unit: "instance";
      readonly key: string;
      readonly instance: number;
      readonly instances: number;
    });
```

`key`, `part`, `parts` are **required** where they apply and absent where they do not, so
`switch (event.unit)` narrows and there is nothing to guess. An unpartitioned group reports
`part: 1, parts: 1` rather than omitting them — a consumer should not need two code paths
for "one part" and "several".

Structured fields rather than a display label, throughout. Without them a consumer is
reduced to parsing `wholeHome_2of3` out of a response-schema name the library happens to
construct — coupling to an internal convention that breaks silently on a rename, which is
what a consumer does today for want of this hook.

## Ask 2 — the composites must thread it through

The important half, and the easy half to miss.

`fallbackExtractor` and `instanceLadder` build their candidates from options they are handed.
If `onUnit` is not passed down, then wrapping a working `perGroupExtractor` in a ladder
**silently loses every progress event** — the composite reports its own attempts and nothing
underneath. A consumer would see three events for a ten-minute run.

So: a composite passes `onUnit` to each candidate it constructs, and stamps `strategy` on
what it forwards, so a unit is attributable to the tier that produced it without the
consumer tracking state. A composite's own `U` is the union of its candidates', which is why
it takes the default parameter.

## Ask 3 — surface the derived retry budget

Adjacent, and the reason `attempt` above matters.

`deriveMaxRetries` decrements the requested budget until the worst case fits
`stepTimeoutMs`, floor 0. On a 16-call extraction at concurrency 2 the defaults derive to
**zero**, and nothing says so. Asking for `maxRetries: 5` and getting none is
indistinguishable from asking for 5 and needing none.

Not hypothetical: it cost three wrong diagnoses and explained a **2-in-3 document loss
rate** against a gateway measuring ~12% errors under load. With zero retries a 16-call
document has an ~87% chance of dying; with two, ~3%. It presents as slightly less data
rather than an error, which is why it hid.

```ts
/** Called when the retry budget had to be reduced to fit the step timeout. Must not throw. */
readonly onRetryBudget?: (event: RetryBudget) => void;

export interface RetryBudget {
  readonly requested: number;
  readonly derived: number;
  readonly batches: number;
  readonly perCallCeilingMs: number;
}
```

Consider whether `derived === 0` while `requested > 0` should be a hard error by default.

## Ask 4 — `onPage` on the document transcriber

Cheap and separate. `readText()` is a `for (let i = 1; i <= doc.numPages; i++)` sweep that
emits nothing, while `pageCount` is documented "free once open" — so the total is known
before the loop starts. On a 35-page report that is real, currently invisible, progress.

```ts
/** Called after each page is read. Must not throw. */
readonly onPage?: (event: PageRead) => void;

export interface PageRead {
  readonly page: number;
  readonly of: number;
  /** Non-whitespace characters this page yielded. */
  readonly chars: number;
}
```

`chars` earns its place beyond a progress bar: a scanned insert in an otherwise text-layer
PDF shows up as a run of zero-character pages, worth surfacing before the whole-document
`no-text-layer` threshold decides.

## Ask 5 — the same pattern where it already pays

Breaking changes are fine, so this is not a separate negotiation. A survey of the repo turned
up one place where the pattern is not optional if Ask 1 lands, and three exported unions that
have the shape Ask 1 argues against.

**`threePhaseExtractor` is the fifth variant, and it already exists.** Its units are none of
the four: phase 0 asks presence per group, phase 1 asks for verbatim quotes per group, and
**phase 2 classifies one leaf at a time** — on a document with hundreds of grounded spans
that is the longest-running loop in the library, and it is the one a reviewer would most want
to watch. So:

```ts
/** `threePhaseExtractor`: one call in the presence → quote → classify sequence. */
| (UnitBase & {
    readonly unit: "phase";
    readonly pass: 0 | 1 | 2;        // presence, quote, classify
    readonly key: string;            // the group
    readonly leaf?: string;          // phase 2 only — one leaf per call
  })

export interface ThreePhaseExtractorOptions<V> extends ExtractionObserver<PhaseUnit> { … }
```

That variant is also the argument for the parameterised observer rather than one flat union:
`leaf` is meaningful in exactly one of three passes, and a `GroupUnit` consumer should never
see it at all.

**And it retires `onCall`.** `three-phase-extractor.ts` threads `onCall: () => void` through
all four phase helpers (lines 243, 317, 399, 427) purely to count calls. If `onUnit` lands
and `onCall` stays, there are two mechanisms for one job and the newer one is strictly
better-informed. Derive the count from the observer, or mark `onCall` internal and say so.

**Untagged unions that should narrow the way `ExtractionUnit` will.** The reason the event is
tagged on `unit` is that `switch` narrowing makes a consumer's job mechanical. Three exported
unions do not have that, and the workarounds are already in the file:

| type                                                 | how it is "discriminated" today                                                                                   |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `ExtractionOutcome<F>` (`arbitration.ts:23`)         | `result?: never` / `error?: never`, plus hand-written `Extract<>` aliases `ResultOutcome` / `FailureOutcome`      |
| `ArbiterVerdict<F>` (`arbitration.ts:72`)            | three different key names — `accept`, `continue`, `giveUp`                                                        |
| `OutboxItem \| SessionItem` (`RelayOptions.onError`) | nothing: `SessionItem` is `sessionDocumentSchema` as-is, so a consumer separates them by probing for `audioReady` |

The `?: never` idiom is defensible and narrows under `in` and truthiness, so treat the first
two as a judgement call rather than a defect — but `ResultOutcome = Extract<…>` existing at
all is the manual version of what a type parameter does, and if the tags land those aliases
derive from the tag instead of from a property name. The relay one is not a judgement call:
an error handler that cannot tell a recording from a session without structural probing is a
real gap, and a `kind` on the session document is cheap now that breakage is permitted.

**Where the pattern does not apply**, so the list is not padded: `PrimeProgress` is already
tagged on `stage` and only the on-device transcriber has `prime`, which emits every stage —
nothing to narrow. `TranscriberFallback` and `onRecovered` carry single shapes. And
`RelayOptions.onError`'s union is genuinely both arms — one relay handles recordings _and_
sessions — so its fix is a discriminant, not a type parameter.

## A question rather than an ask: stage transitions

Nothing announces a change of _stage_ — read, extract, check, review. But the relay already
owns exactly that state machine (`queued → transcribing → extracting → awaiting-review →
writing → done`), persisted in the outbox, and a consumer that skips the queue throws it
away along with durability.

We skipped it, reasoning that a reviewer at a desk has no offline-capture problem. That now
looks wrong: **a ten-minute extraction that dies on an accidental page refresh is a real
problem.** So rather than a duplicate mechanism, the request is a documented answer to "how
should a non-queue consumer observe stage changes?" — and if the answer is "use the queue",
that belongs where a host will read it before repeating our mistake.

### The answer: use the queue. There is no second mechanism, deliberately.

A host observes stage changes by subscribing to the outbox and session documents. That is
what `useOutboxItems` already does, and a host outside React reads the same documents
through `Outbox` directly. The stage **is** `OutboxItem.status` and `SessionItem.status`;
there is nothing to add.

**Why there is no non-queue answer, rather than one we have not built yet.** A stage
transition is a fact that has to survive the thing that destroys it. Extraction is the
longest step in the pipeline, and the failure the request correctly identifies — a
ten-minute extraction dying on an accidental page refresh — is precisely a failure of
in-memory state. A second, in-memory stage mechanism would be at its least trustworthy in
exactly the situation that motivates wanting one. Worse, a host given both would have two
sources of truth for one fact and no rule for which wins after a reload.

So the queue is not the durable option among several. It is the only one that answers the
question that was actually asked.

**The distinction to hold on to, and the reason both exist:**

|             | `onUnit`                     | the queue's status         |
| ----------- | ---------------------------- | -------------------------- |
| answers     | how far through _this_ stage | which stage                |
| lifetime    | the `extract()` call         | persisted, survives reload |
| granularity | one model call               | one pipeline step          |
| on refresh  | gone, and that is correct    | resumes where it left off  |

`onUnit` is progress _within_ a stage and is deliberately not durable — persisting sixteen
call-level events per extraction would be a write amplification the outbox exists to avoid,
and none of them is meaningful after the run they describe has ended. The queue is what
makes the stage itself survive. Reaching for the hook to answer "which stage" gets you a
mechanism that forgets; reaching for the queue to answer "how far through extraction" gets
you nothing, because the queue does not see inside a step. Use both, for what each is.

**The corollary a host should read before designing around it:** a consumer that skips the
queue is not merely opting out of stage observability, it is opting out of durability,
retry, backoff, ordering and work-safety at the same time — those are one mechanism, not
five. "I only need progress, not durability" is not a reachable position, and a reviewer at
a desk turns out to need durability anyway.

## Not asked for

- **The extraction plan.** `splitExtractionSchema` is exported and pure, so the unit count is
  knowable before the first request. Genuinely already available.
- **Cost.** Computable from `usage` and a price table the consumer owns anyway.
- **Mid-generation token progress.** A separate, larger question — `complete()` resolves a
  whole completion, so a 90-second call is one unit not moving however good `onUnit` is. Only
  worth raising once per-unit progress exists and the remaining gap is visible.

## Non-negotiables

1. **Optional, and documented "Must not throw"**, matching `FirstCapableOptions.onFallback`.
2. **No behaviour change when absent.** These are observation points.
3. **No model output in the event.** `usage` and identifiers only — an event carrying
   unparsed content would put it in front of consumers ahead of the trust boundary, which is
   what `parseWithSchema` exists to prevent.
4. A named `readonly` event interface per hook, per house style.

## Done means

- `./check.sh` passes.
- A test per extractor proving `onUnit` fires with the right variant and identifiers, and
  that the union narrows — a `"whole"` unit must not compile with a `part`.
- A type-level test for the two directions of the table above: one broad handler assignable
  to every extractor's options, and a handler narrower than the site it is passed to
  rejected.
- **A test that a composite forwards it** — `fallbackExtractor` wrapping a
  `perGroupExtractor` must emit the inner groups' units, not only its own attempts. That is
  the assertion that fails if Ask 2 is missed, and Ask 2 is the easy one to miss.
- A test proving each path is unchanged when no callback is passed.
- A changeset — major, naming each narrowed set, since a consumer's compile error should
  arrive with its explanation.

## Report back

- Whether the five union variants (four plus `threePhaseExtractor`'s) covered every strategy
  honestly, or whether something had to be forced into one. A sixth is a better outcome than
  a stretched fifth.
- Whether the per-extractor `U` held up once every call site was typed, or whether some
  extractor's real emissions did not match the set its options claimed.
- Whether tagging `ExtractionOutcome` and `ArbiterVerdict` was worth it having tried it, or
  whether the `?: never` idiom was carrying its weight after all.
- Whether `derived === 0` should be an error rather than an event, having seen the code.
- What a non-queue consumer should do about stages, so it can be written down.
