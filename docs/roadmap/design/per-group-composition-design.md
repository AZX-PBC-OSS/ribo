# Per-group composition: a group is an `Extractor`, and the whole is a combinator over them

**Date:** 2026-09-14
**Status:** Draft — for review. No implementation plan written yet.
**Question answered:** "Ribo is essentially an extraction pipeline — is it expressible as such? How
we split groups even — each group is almost its own pipeline, right?"
**Depends on:** R3 (`perGroupExtractor`, `splitExtractionSchema`), `extractor-arbitration-design.md`
(the combinator shape), `group-provenance-granularity-design.md` (per-group `P`),
`post-docs-findings.md` P4 (`AnnotatedTranscript`) and P2 (the plugin-storage delivery gap).
**Authority it corrects:** `schema-retry.ts`'s file header, which says the combinator should be wired
"around `singleShotExtractor` or another `buildMessages`-shaped base" — true, and the reason it
cannot be wired around the extractor the playground actually runs (§2.2).

---

## 1. The answer, before the argument

**The pipeline half is already expressed.** Capture → transcribe → combine → extract → review →
write is four contracts (`Transcriber`, `TranscriptCombiner`, `Extractor`, `ToolAdapter`) joined by
two persisted state machines, and `AGENTS.md` §1 is right that a third mechanism for stage
transitions would be a mistake. Inside extraction, `Extractor<F>` is genuinely the composable unit:
`fallbackExtractor`, `raceExtractor`, `compositeExtractor`, `gapFillExtractor`, `schemaRetryExtractor`
and `instanceLadder` all take `Extractor`s and return one. Nothing in that layer needs a pipeline
framework.

**The group half is not expressed.** A group is a loop iteration _inside_ `perGroupExtractor`
(`per-group.ts`) and `scopedInstanceExtractor` (`instance-fill.ts`) — a `PreparedGroup` record with
a schema, a name and a context string. It is not a value a host can hold, wrap, replace or observe on
its own. Every wrapper in the library therefore wraps the whole schema, every strategy chooses for
the whole schema, and every per-group variation that has been needed so far has arrived as a
callback or flag on `PerGroupOptions`.

**Recommendation: build one small thing, not a framework.** A `groupedExtractor` combinator that
runs a per-key map of `Extractor`s and owns the cross-group work (pool, retry budget, merge, the
second trust-boundary parse, usage), plus a pure `projectTarget(target, key)` that narrows an
`ExtractionTarget` to one group. `perGroupExtractor` becomes a preset over the two, issuing the
same requests it issues today. Per-group heterogeneity — a different model, strategy, wrapper or
transport per group — then falls out of composition instead of options. One contract change rides
along (§4.4), and the roster/inventory strategy is deliberately left whole-schema (§4.6).

Do not build a stage/DAG pipeline abstraction, a router, or per-group partial persistence. §5
records why.

## 2. Evidence the problem is real

None of the spike measurements bear on whether to split or how; they measure citation fidelity
and native-vs-flattened quality, and the split-vs-single-shot accuracy comparison R3 §8 asked for
has never been run (`docs/roadmap/index.md`: "there is **no current measurement of extraction
quality**"). So this design stands on composition and correctness evidence, all of it in the tree.

### 2.1 The library's own author hand-rolled the combinator

The harness for the matched-schema measurement behind
`docs/deep-dives/native-extraction.md` (a 126-leaf Manual J, flatten-then-extract arm) carried a
per-group extractor written from scratch: four hand-declared parts, a `singleShotExtractor` per
part, `Promise.all`, a per-part retry loop, merge by key, usage summed — and no second
trust-boundary parse. The reason: `perGroupExtractor` was the first choice and
`splitExtractionSchema` collapsed the schema to one call. The specific collapse cause
(`isGroupObject` refusing an array-of-envelopes property) has since been fixed by
`isExtractedSchema`, but the all-or-nothing rule remains — one top-level key that is not a group
still collapses _every_ group into one call — and, more to the point, the shape of the workaround
is the finding. When the derived grouping did not fit, the only recourse was to rebuild the
combinator by hand and lose a trust-boundary check doing it.

### 2.2 The wrappers are whole-schema, and two of them break on per-group facts

`schemaRetryExtractor` around `perGroupExtractor`: a `SchemaParseError` from one group's call
propagates out of `extract()`, and the retry re-asks with `buildMessages(target, …)` pinned to the
**full** `target.extractionSchema`. On the Snugg target that is the 39,741-byte request per-group
exists to avoid (cap 32,768) — a `400`, which `isTransientFailure` classifies as terminal. The
combinator that exists to feed a validation error back to the model cannot be used with the
extractor the playground runs, and its own header says so obliquely.

`gapFillExtractor`: `GapFillOptions<V>` carries no `P`, so `base: Extractor<Enveloped<V>>` does not
accept an `Extractor<Enveloped<V, P>>` whose `P` names a `"row"` group — a compile error on any
target that uses the granularity option at all. Its leaf walker (`isExtractedLeaf`) also skips plain
leaves, so a row group's ungrounded row span is never a candidate. Both are correct behaviours _for
a leaf group_; they are applied to the whole schema because that is the only unit a wrapper can
address.

### 2.3 The strategies are whole-schema too

`threePhaseExtractor` throws at construction if **any** group was derived at `"row"` or `"none"`
(`packages/ribo-extractor-ondevice/src/three-phase-extractor.ts`, `extractGroups`). The refusal is
right for that group and wrong for the
other nineteen: one row group makes the on-device path unusable for a schema whose other groups it
handles perfectly well. `group-provenance-granularity-design.md` §8 records the fix as "a different
strategy, not a patch" — which is exactly a per-group strategy choice with nowhere to be made.

`instanceLadder` falls the **whole schema** from tier 1 to tier 2 when any one group fails. Of Snugg
Pro's twenty groups (`SNUGG_GROUP_KEYS`), only the collections need an inventory at all; the
singletons ride along through `singletonFillScope`, a placeholder roster candidate invented so the
whole-schema strategy has something to say about a group it has nothing to say about. That is
per-group heterogeneity implemented by hand inside a whole-schema loop.

### 2.4 Per-group configuration is leaking in as callbacks and flags

`groupInstructions(key)`, `singleton`, `maxNullableUnionsPerGroup` on `PerGroupOptions`;
`buildFillInstructions(groupKey, scope)` on `ScopedFillOptions`; `SnuggRule.groups` tagging rules
by group in the adapter. `post-docs-findings.md` P3 used precisely this smell — "a boolean bolted
onto a policy function" — as the evidence that `joinSessionTranscript` wanted a seam. The same
pressure is visible here, relieved the same way, three times.

### 2.5 Duplication where the cross-group work lives

`mapWithPool` is byte-identical in `per-group.ts` and `instance-fill.ts` (one comment differs). The
retry loop, `PreparedGroup` construction, the index-aligned merge and the second parse are
near-identical. The retry-budget derivation was already hoisted once
(`extraction-observability-design.md` §0.4) because two copies had begun to drift. The remaining
copies are the combinator this design names.

### 2.6 Sibling loss, recorded not fixed

One group's failure aborts every in-flight sibling and discards every completed one; the relay
retries the whole step (R3 §5's accepted cost). This design does not change that. It is listed
because per-group `Extractor`s are the precondition for ever persisting a group's success across
attempts, and because a reader should not mistake §4 for a fix to it.

## 3. What "each group is its own pipeline" cannot mean

Groups are independent in **what they ask the model** and dependent in **how the run is scheduled
and validated**. The second half is real and lives in the code today:

| cross-group fact                          | where                                                                                   |
| ----------------------------------------- | --------------------------------------------------------------------------------------- |
| retry budget derived from the group count | `deriveRetryBudget({ batches: ceil(G / concurrency) … })` in both multi-call extractors |
| shared abort on sibling failure           | one `AbortController` per `extract()`, threaded into every `chat.complete`              |
| second trust-boundary parse               | the merged whole parsed against the full `extractionSchema`                             |
| normalize once                            | `normalize(parsed)` on the merged result, by design (R3 §4)                             |
| usage summed, `statedEmptyGroups` unioned | `UsageTotals`, the roster's stated-empty map                                            |
| the house-wide inventory                  | R1.6 §5.1: cross-group _on purpose_, because miscategorisations cross groups            |
| the transcript sent G times               | R3 §7's still-open caching decision                                                     |

So the framing in the question is half right. A group is its own _call_ — its own prompt, schema,
model, retry, wrapper — and the whole is its own _run_. The design below gives each half an owner:
the group `Extractor` owns the call, the combinator owns the run.

## 4. Design

### 4.1 `projectTarget` — narrow a target to one group, purely

A pure function beside `splitExtractionSchema`: given an `ExtractionTarget<V, P>` and a top-level
key, return an `ExtractionTarget` whose `extractionSchema` is the one-key strict object R3 already
sends (`{ [key]: groupSchema }`, so the response is shaped like the final answer and merges by
assignment), whose `examples` are projected to that key with the existing `projectExample` /
`projectSingletonExample` / `narrowToLeaves`, and whose `instructions` are the supplied per-group
text or the target's own. Options carry `leafKeys` for a partitioned piece and `singleton` for the
tier-3 shape. Type-level: `ExtractionTarget<Pick<V, K>, Pick<P, K>>`, so a group extractor built
over it is an `Extractor<Pick<Enveloped<V, P>, K>>` and a wrong key is a compile error.

This is `buildGroupMessages` with the message assembly taken back out: today the projection and
the assembly are fused, which is why a projected target cannot be handed to anything but the
per-group loop.

### 4.2 `groupedExtractor` — the run

Lives in `ribo-core` beside `fallbackExtractor` and `raceExtractor`: it is a combinator over
`Extractor`s and knows nothing about chat, prompts or providers. (The retry budget, `nextUnitId`
and `GroupUnit` are already core exports; the merge helper and the second parse need only zod and
`ExtractionTarget`, both core.) Putting it in core also means `ribo-extractor-ondevice` can compose
per group without deepening its declared exception of depending on `ribo-extractor-openai`.

Options: the `target` (for the full-schema parse and the coverage check), a `groups` map from
top-level key to either one `Extractor<Pick<Enveloped<V, P>, K>>` or an ordered list of them (the
pieces of a partitioned group, recombined with today's `mergeGroupPieces`), the existing
`concurrency` / `maxRetries` / `stepTimeoutMs` / `perCallCeilingMs` / `BackoffOptions` /
`RetryBudgetObserver` / `ExtractionObserver<GroupUnit>` mixins, and `normalize`.

Behaviour, all of it already specified by R3 and the observability design, relocated:

- **Coverage is checked at construction.** Every top-level key of `target.extractionSchema` must be
  named in `groups`, and no key outside it may be — thrown with the key named, in the style of
  `enveloped()`'s `validateProvenance`. Silent partial coverage would surface as a second-parse
  failure after every call had been paid for.
- **Scheduling.** A bounded pool over the flattened list of group entries; the retry budget is
  derived from that count exactly as today (`batches = ceil(entries / concurrency)`), so the
  observable `RetryBudget` for the Snugg wiring does not move.
- **Retry.** A transient failure of a group entry's `extract()` is retried with `fullJitterDelay`
  up to the derived budget; `TerminalQueueError` is never retried; `SchemaParseError` stays
  transient (arbitration design §4.2's argument is unchanged). The unit of retry becomes the group
  extractor's `extract()` rather than the chat call alone — message assembly re-runs per attempt,
  which is cheap and was outside the loop for tidiness, not correctness.
- **Merge, second parse, normalize once, usage sum, `statedEmptyGroups` union.** As today.
- **Observability.** The combinator emits `GroupUnit` (`key`, `part`, `parts`, `attempt`) around
  each group entry's `extract()`, which is the honest unit of _its_ work and keeps today's event
  vocabulary for consumers. A group extractor's own units (a `WholeUnit` from a `singleShotExtractor`,
  a `GapFillUnit` from a wrapper) flow through whatever `onUnit` its builder gave it — the
  already-built-candidates rule from `extraction-observability-design.md` §0.3, applied
  consistently.

### 4.3 `perGroupExtractor` becomes a preset — and the preset's plan is a value

`splitExtractionSchema(target.extractionSchema, cap)` → for each piece,
`singleShotExtractor({ target: projectTarget(target, key, { leafKeys, singleton, instructions:
groupInstructions?.(key) }), chat, model, maxTokens })` → `groupedExtractor`. `perGroupArrayExtractor`
and `perGroupSingletonExtractor` remain names for the two `singleton` settings. The requests —
`response_format.json_schema.name`, the schema, the message list — are byte-identical to today's,
and the existing per-group suite (44 tests, including partitioning and progress units) is the
regression gate, along with the adapter's `per-group-cap.test.ts` and the frozen fixture, which
this design does not touch (the derivation is unchanged).

**The intermediate step is exported, not hidden.** If the preset built its map internally, the
common case — the defaults everywhere except one group — would mean reconstructing twenty entries
by hand with `projectTarget`, and nobody would; hosts would keep calling `perGroupExtractor` and
the per-group capability would go unused. So the preset is two steps, and the first is public:

- `perGroupPlan({ target, chat, model, maxTokens, groupInstructions, singleton,
maxNullableUnionsPerGroup })` returns `{ groups, targets }`: `groups` is the exhaustive per-key map
  of default entries (a `singleShotExtractor` per piece), and `targets` is the index-aligned map of
  the projected `ExtractionTarget`s those entries were built from. Both are plain values a host can
  read, log, assert on and spread.
- `perGroupExtractor(options)` is `groupedExtractor({ target, groups: perGroupPlan(options).groups,
…timing })` and nothing more.

**Overriding one group wraps the default rather than rebuilding it.** For an unpartitioned group a
spread is enough: `groups: { ...plan.groups, rooms: singleShotExtractor({ target: plan.targets.rooms,
chat: cheapChat, model: cheapModel }) }`. The projected target is what makes that line short — the
caller never touches `projectTarget` for the group it is replacing, let alone the nineteen it is not.

A partitioned group is where a bare spread breaks down, and the obvious example is partitioned:
`health` is fourteen enveloped leaves, twenty-eight nullable unions against a cap of sixteen, so
`plan.groups.health` is **two** entries sharing the key, and `gapFillExtractor({ base:
plan.groups.health })` does not type-check. Rather than make every override author learn which
groups are partitioned, `overrideGroups(plan, { health: (entry, target) => gapFillExtractor({ base:
entry, target, chat, model }) })` applies an override function **per piece**, handing it the piece's
extractor and its projected target, and returns the full map with the other keys untouched. The
same function replaces a group outright by ignoring its first argument. Wrapping per piece is also
the semantically right unit: a piece's gap-fill re-asks exactly that piece's leaves against a
schema that fits, at the cost of one follow-up call per piece instead of one per group. A
group-level wrapper over merged pieces would need the pieces recombined first, which would move
partitioning inside the group extractor and out of the combinator's pool — changing today's
scheduling and splitting the retry budget across two levels. Declined; `Extractor | readonly
Extractor[]` per key stays the combinator's shape, and `overrideGroups` is the ergonomic layer
over it.

**Why exhaustive plus spread, rather than exhaustive plus explicit.** The map type stays
exhaustive: a missing group is a compile error, never a silent skip, and the construction-time
coverage check catches a JS caller. An explicit twenty-line map is more greppable than a spread,
and that argument was weighed: what a reviewer needs to know is _which groups deviate from the
default_, and a spread with two overrides states exactly that, while twenty explicit lines bury the
two that matter among eighteen that restate the preset. The full running map is still a value —
`plan.groups` after overrides — so a test or a status panel can enumerate it and name the
overridden keys; that is the diffability an explicit map would have provided, recovered where it is
actually consumed.

**When the default and an override disagree about `model` or `maxTokens`, nothing happens, and that
is the design.** The plan's `chat`, `model` and `maxTokens` reach only the default entries it
builds; an override carries its own by construction and the combinator never sees either. There is
no merge, so there is no conflict to resolve. What the combinator _does_ own is shared across every
entry regardless of who built it — `concurrency`, `maxRetries`, `stepTimeoutMs`,
`perCallCeilingMs`, backoff, `normalize` — and one of those needs saying: `perCallCeilingMs` is a
physical bound on the slowest entry, so a host that routes one group to a slower model raises the
combinator's ceiling to that model's, not the default's. `usage` sums from each entry's result, so
an override that makes more calls (a gap-fill's follow-up, a self-correction retry) is counted
honestly; and the combinator's `GroupUnit` reports the group whichever extractor ran it, with the
override's own inner units flowing through whatever `onUnit` the override was built with.

### 4.4 One contract change: `extract(transcript, options?)` with a signal

Once a group is an opaque `Extractor`, the shared `AbortController` in `per-group.ts`'s closure has
no way to reach the group's chat call. Keeping today's sibling-abort behaviour needs the signal to
cross the contract: `extract(transcript, options?: { signal?: AbortSignal })`. Two other things want
the same slot:

- `raceExtractor` today lets losers run to completion (it only attaches rejection handlers), and
  the relay's `withTimeout` abandons a timed-out step whose calls keep running. Both are the same
  gap.
- **P2's delivery gap** (`post-docs-findings.md`): the plugin-storage substrate is built and
  unreachable because the only handle is `Outbox.pluginStorage(...)`, and the note says to close it
  "as a `PluginStorage` handed to a plugin alongside its input". That is this options bag. Decide the
  two together so the contract is widened once, not twice.

Declare `extract` as a function-typed property, not a method, for consistency with
`Transcriber.transcribe` and `ToolAdapter.write` — and because the options bag is a parameter, the
position where method bivariance can bite the day it varies with a type parameter. It is **not**
needed for the `Pick<…>` narrowing in §4.1: `F` sits in the return position, which is covariant for
methods and properties alike, so a narrow group extractor already fails a wide slot under today's
method syntax (verified by a compile probe — `type-story-findings.md` D1; an earlier draft of this
paragraph claimed otherwise). Blast radius is
P4's list — six implementations, `FakeExtractor`, `toSessionExtractStep`, two call sites in
`arbitration.ts` — and, like P4, the argument is timing: nothing is published.

The alternative — have the combinator _construct_ its groups from factories so the signal can be
closed over — was rejected. It reintroduces the "composite builds its candidates" shape §0.3 of the
observability design steered away from, and a factory cannot be wrapped from outside by `gapFill`
or `schemaRetry`, which is the capability this design exists to provide.

### 4.5 What falls out

Each is expressed with existing exports plus §4.1–4.2, and none needs a new option anywhere:

- A `"row"` group gets `schemaRetryExtractor` around its `singleShotExtractor`; the leaf groups get
  `gapFillExtractor`; the re-ask for either is pinned to that group's one-key schema and fits.
- `hvac` gets its own `fallbackExtractor([tier2-hvac, tier3-hvac], arbiter)`; `health` does not
  fall anywhere because a fourteen-test matrix has no tier to fall to.
- The on-device composite entry runs `threePhaseExtractor` over the leaf groups and a
  `singleShotExtractor` over `OnDeviceChat` for the row group; the three-phase refusal becomes a
  fact about one group rather than a veto over the schema.
- `basedata` on a cheaper model than `health`; a group routed through `helixChat` while the rest
  stay on `openAiChat`. Each group extractor carries its own `chat` and `model` by construction,
  which is the inference-configuration-belongs-to-the-host rule `SingleShotOptions.maxTokens`
  already states.
- The matched-schema spike's arm B is `groupedExtractor` with four `singleShotExtractor`s and gets
  its second parse back.

### 4.6 The inventory and the ladder — deliberately not in this increment

`scopedInstanceExtractor` is the one strategy that is cross-group by design: the roster is
house-wide because an attic air handler is an `hvac` instance and only a call that sees both groups
can say so. It stays a whole-schema `Extractor` here and composes exactly as it does today, either
as a `groups` entry covering every collection key (if the combinator allows one extractor to cover
several keys — a small generalisation worth taking, since coverage is checked by key set) or as the
top of a `fallbackExtractor` whose lower rungs are grouped presets.

The re-expression that would make it per-group is visible and worth recording: an inventory
pre-pass that writes the roster into `AnnotatedTranscript.annotations`, and per-group fill
extractors that read it — P4 left the bag open for "a real transcriber" to produce something, and a
roster is the first real candidate. `statedEmptyGroups` would then be a per-group result field the
combinator unions. It is not built here because §4.1–4.3 deliver their value without it, and
because an untyped annotation used as a side channel between two extractors is exactly the hidden
coupling P4 warned against; if pursued, the roster annotation gets a type and a name first.

### 4.7 `splitExtractionSchema`'s all-or-nothing rule

With an explicit `groups` map, the collapse-to-one-call fallback is no longer the only answer to a
top-level leaf: the caller names an extractor for it, or groups the leftovers into one entry. The
preset keeps today's derived behaviour untouched; the combinator's coverage check replaces the
collapse for anyone composing by hand. The spike's workaround (§2.1) stops being necessary.

## 5. Considered and rejected

- **A stage/DAG pipeline abstraction** (typed stages, edges, a runner). The stage pipeline already
  exists as the two persisted state machines and four contracts, and `AGENTS.md` §1 records that a
  third mechanism was nearly built and would have been a mistake. Extraction's internal structure is
  fan-out over one input and merge, which a combinator expresses completely; a DAG adds a dependency
  and a vocabulary to a browser bundle and buys nothing the arbitration engine does not already give.
- **Groups declared on the `ToolAdapter`** (`target.groups: { key: { instructions, examples,
model?, strategy? } }`). Per-group _instructions_ are adapter knowledge and are already there
  (`snuggGroupInstructions`, `SnuggRule.groups`); `projectTarget` takes them as an option rather than
  moving them. Model, transport and strategy are host inference configuration and do not belong on
  an adapter — the existing rationale on `SingleShotOptions.maxTokens`.
- **More group-keyed options on `perGroupExtractor`** (a `modelByGroup` map, a `wrapGroup(key,
extractor)` callback). Each is a group-keyed map of configuration that reinvents "a map of
  `Extractor`s" with strictly less power, and each is the next flag in §2.4's sequence.
- **A router that skips unmentioned groups.** R3 §3's reasoning stands: a wrongly skipped group is
  indistinguishable from one the auditor never discussed. Orthogonal to this design and still not
  this increment.
- **Per-group partial persistence across relay attempts.** R3 §5's reasoning stands (a
  half-extracted session in a review contract that assumes `extracted` is complete). This design is
  the precondition, not the implementation.
- **Keeping the combinator in `ribo-extractor-openai`.** It needs no chat vocabulary, and core is
  where every other `Extractor` combinator lives. Rejected only as a placement; §4.2 says why core.

## 6. Interfaces

Described rather than typed in full; the two shapes that are load-bearing:

- `projectTarget<V, P, K extends keyof V & string>(target: ExtractionTarget<V, P>, key: K,
options?: { instructions?: string; leafKeys?: readonly string[]; singleton?: boolean })
: ExtractionTarget<Pick<V, K>, Pick<P, K>>` — pure, in `ribo-extractor-openai` beside
  `splitExtractionSchema`.
- `groupedExtractor<V, P>(options: GroupedExtractorOptions<V, P>): Extractor<Enveloped<V, P>>`
  where `groups` is `{ [K in keyof V & string]: Extractor<Pick<Enveloped<V, P>, K>> |
readonly Extractor<Pick<Enveloped<V, P>, K>>[] }`, and the options object extends
  `BackoffOptions`, `ExtractionObserver<GroupUnit>` and `RetryBudgetObserver` — in `ribo-core`.
- `perGroupPlan<V, P>(options: PerGroupOptions<V, P>): { groups: GroupMap<V, P>; targets:
GroupTargets<V, P> }` where `GroupTargets` mirrors `GroupMap` key for key and index for index
  with the projected `ExtractionTarget`s; and `overrideGroups<V, P>(plan, overrides: Partial<{ [K]:
(entry: Extractor<Pick<…, K>>, target: ExtractionTarget<Pick<V, K>, Pick<P, K>>, index: number) =>
Extractor<Pick<…, K>> }>): GroupMap<V, P>` — both in `ribo-extractor-openai` beside the preset.
- `Extractor<F>.extract: (transcript: AnnotatedTranscript, options?: ExtractOptions) =>
Promise<ExtractionResult<F>>` with `ExtractOptions` carrying `signal?` now and P2's storage handle
  when that lands — in `ribo-core`.

## 7. Costs

- **Code and bundle.** The combinator is the scheduling half of `per-group.ts` moved, not added;
  `per-group.ts` shrinks to a preset; `instance-fill.ts` can adopt the same pool and retry later.
  No new dependency. Net size flat to smaller.
- **Breaking.** The `Extractor` contract widening touches every implementation and the arbitration
  call sites — the same walk P4 already did once. Nothing is published.
- **Tests.** The per-group suite must pass against the preset unchanged: same requests recorded by
  the fake chat, same partition boundaries, same `GroupUnit` events, same derived retry budget.
  New tests are §9.
- **Semantics that move.** Retry now wraps a group extractor's `extract()`, so a wrapper _inside_ a
  retried group (a `gapFill` over one group) is retried with it; document that the combinator's
  retry is for transient transport failure and that a `schemaRetry`-wrapped group will have
  self-corrected before the combinator sees a miss. The "aborted sibling emits no event" reasoning
  in `per-group.ts` carries over verbatim.
- **Documentation.** `docs/guide/schema-at-scale.md` and `docs/guide/arbitration.md` gain the
  composition examples in §4.5; `schema-retry.ts`'s header loses its caveat.

## 8. What would make this the wrong call

- **Nobody composes per group.** If the only per-group variation that ever materialises is
  instructions — already served by `groupInstructions` — then §4.1–4.3 are a refactor with no
  consumer. The test is §2.2 and §2.3: would the owner otherwise fix `schemaRetry × perGroup`, the
  `gapFill` type gap and the three-phase veto by adding per-group paths _inside_ each wrapper? That
  is the "more flags" road, and it is the alternative to this design, not a reason against it.
- **The inventory becomes the strategy for everything.** If every group ends up a collection, the
  cross-group pre-pass dominates and every group extractor is a fill that needs the roster. Then
  §4.6's annotation channel is not optional and belongs in the same increment.
- **Measurement shrinks the splitting story.** R3 §8's before/after corpus comparison has never been
  run. If single-shot over a mid-size schema turns out no worse than per-group on the fields the
  vendor descriptions were supposed to help, the case for splitting at all narrows to the byte cap
  and the union cap — but composition is still how "single-shot for most groups, split only the
  oversized one" would be written.
- **The combinator grows a vocabulary.** If `groupedExtractor` acquires scheduling modes, group
  dependencies or a routing hook, it has become the framework §5 declined. The arbitration design's
  discipline applies: new behaviour is a new constructor, not a flag.

## 9. Must-fail tests

- The preset issues byte-identical requests to today's `perGroupExtractor` for the Snugg target —
  names, schemas, messages — across partitioned pieces and in singleton mode.
- Two groups wired to two different fake chats each receive exactly their own group's request.
- A `groups` map missing a top-level key, or naming one the schema lacks, throws at construction
  with the key in the message.
- A group extractor returning a one-key object of the wrong shape is rejected by the merged parse
  with a `SchemaParseError` naming the merge context, never emitted.
- When one group entry fails terminally, a sibling still in flight observes an aborted signal and
  no further entry starts (needs §4.4).
- The derived `RetryBudget` for the Snugg preset equals today's, event for event.
- `gapFillExtractor` around one leaf group of a target whose `P` declares a `"row"` group compiles;
  the same wrapper around the whole extractor does not (type-level, pinned both ways).
- `schemaRetryExtractor` around one group re-asks with that group's one-key schema and a message
  list built from the projected target, never the full schema.
- `overrideGroups(plan, { health: … })` returns a map whose every non-`health` entry is
  reference-equal to `plan.groups`'s, whose `health` override was invoked once per piece with that
  piece's projected target, and which rejects an unknown key at the type level.
- A group replaced through the plan's projected target sends requests only through the override's
  own chat; the plan's `chat` receives none for that key and all of them for every other key.

## 10. Sequencing

1. The `Extractor` contract widening (§4.4), with the P2 storage slot decided in the same change
   even if its wiring lands later.
2. `projectTarget`, pure, with its tests — `buildGroupMessages` re-expressed over it.
3. `groupedExtractor` in core, with the tests in §9.
4. `perGroupPlan` and `overrideGroups`, then `perGroupExtractor` / `perGroupArrayExtractor` /
   `perGroupSingletonExtractor` as presets over them; the existing suite green unchanged.
5. Guide updates and the `schema-retry.ts` header.

Later, each on its own evidence: `scopedInstanceExtractor` onto the same pool and retry; the
roster-as-annotation re-expression (§4.6); and the R3 §8 corpus comparison, which this design makes
easier to run per group but does not depend on.
