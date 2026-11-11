# Findings from a review of the type story across the nine packages

**Date:** 2026-09-14
**Status:** Findings, for execution. Nothing here is built.
**Scope:** every publishable package. Generic-parameter consistency, variance, whether the types
encode the invariants the prose claims, casts at and away from trust boundaries, zod inference
versus hand-declared types, and the exported surface.

**How each item was established, because that matters more than the count.** Three labels:

- **Ran** — established by running a compiler, a linter or a build. The compile-time probes were
  a throwaway file in `ribo-extractor-openai/src` typechecked with the package's own `tsc`; each
  `@ts-expect-error` line asserts a failure and tsc reports an unused directive if the line
  compiles, so every probe was checked in both directions. The file was deleted before this
  commit.
- **Read** — a fact at a file and line, quoted from the tree. Not a judgement.
- **Reasoned** — an inference about consequences or a proposal, from reading. Treat as a lead.

Baseline (**ran**): `pnpm typecheck` is green on all eleven typechecked projects at the tip this
was written against, so nothing below is a compile error today. Type-level test coverage
(**ran**, grep): `@ts-expect-error` appears at 66 sites across 16 files and `expectTypeOf` in 6 —
core's `enveloped`, `adapter`, `arbitration`, `restrict-to-kind` and `extraction-observer` are
pinned; nothing in `ribo-extractor-openai` beyond `chat-client` is.

Headline, over the 21 items below: **9 verified by running, 10 established by reading, 2
reasoned.** Ordered, as `post-docs-findings.md` is, by whether an item is a bug, a decided change,
or a proposal.

---

## Bugs

### B1. `gapFillExtractor` cannot wrap an extractor whose target declares a `"row"` group — **ran**

`packages/ribo-extractor-openai/src/gap-fill.ts:80,89,107,493` — `GapFillOptions<V>` has no `P`;
`base` is `Extractor<Enveloped<V>>`, `target` is `ExtractionTarget<V>`, and the return is
`Extractor<Enveloped<V>>`. Probe: `gapFillExtractor({ base: perGroupExtractor<V, { rooms: "row" }>(…),
target, … })` is a type error. Every other strategy and wrapper in the package carries `P`
(`SingleShotOptions`, `PerGroupOptions`, `ScopedFillOptions`, `SchemaRetryOptions`); this one was
written before the option existed and never widened.

**What breaks:** the granularity option and the gap-fill pass are mutually exclusive at the type
level, for the whole schema, because one group chose `"row"`.

**Fix:** add `P = NoProvenance` through the options, the return type, `mapLeaves`' callers and the
three exported helpers. The runtime already ignores plain leaves (`isExtractedLeaf` requires a
numeric `confidence`), so behaviour on a row group is already "no candidates". One file, one
changeset. `per-group-composition-design.md` §2.2 records the same defect as motivation.

### B2. `instanceLadder` cannot be built over a target with a `"row"` group — **ran**

`packages/ribo-extractor-openai/src/instance-ladder.ts:36–47,80–82` — `InstanceLadderOptions<V>`
types the arbiter as `ExtractionArbiter<Enveloped<V>>` and each tier's options without `P`,
although all three tier option types accept one. Probe: passing an `ExtractionTarget<V, P>` to
`tier1`/`tier2`/`tier3` fails on each.

**Fix:** thread `P` exactly as B1. Same cost.

### B3. `toSessionExtractStep<F>` accepts an extractor of anything, and a cast hides it — **ran**

`packages/ribo-core/src/extractor.ts:148–158` — `F` is unconstrained and `result.fields as
ExtractedFieldMap` (line 152) asserts a `Record<string, unknown>`. Probe:
`toSessionExtractStep(new FakeExtractor(42))` compiles. The relay then persists `42` as
`session.extracted` and `buildReviewRequest` walks it as an object.

**Fix:** `toSessionExtractStep<F extends Record<string, unknown>>` and drop the cast — `Enveloped<V,
P>` satisfies the bound (it is a mapped type over `keyof V`), so no real caller changes. The
`FakeExtractor` tests that seed primitives, if any, are the only fallout.

### B4. The public docs link to 25 symbols that are not exported — **ran**

`pnpm docs:api` reports 48 warnings. 25 are "resolved but not included in the documentation":
`{@link}` targets that exist in source but are not on any barrel — `assertStopFinishReason`,
`parseWithSchema`, `buildMessages`, `mergeGroupPieces`, `narrowToLeaves`, `projectSingletonExample`,
`partitionGroup`, `DEFAULT_MAX_RETRIES` (twice, two packages), `GranularityOf`, `collectFields`,
`completenessIssues`, `buildInstanceKeys`, `AudioCapture.durationMs`, and the DOM's `Response` /
`AbortSignal`. 16 more are relative-path links (`./transcribe.ts`, `./worker.ts`) TypeDoc cannot
resolve, and 7 are the `@file` block tag it does not know. `post-docs-findings.md`'s open
question counted 21 + 7; the number has grown with the recent extractor work.

**Fix:** decide per symbol — export it (B5 covers the ones a consumer actually needs) or demote the
link to plain code formatting. Register `@file` in `typedoc.json`'s `blockTags` so the seven stop.
Mechanical; an hour.

### B5. Two barrels omit things the designs tell a consumer to use — **read**

- `packages/ribo-extractor-ondevice/src/index.ts` does not export `SessionCapabilityError`
  (`session.ts:37`, thrown at `:111`). `extractor-arbitration-design.md` §4.5 says an unadmitted
  on-device candidate in a race "produces a safe, typed, diagnosable error outcome — which the
  arbiter already handles and can fall through from". A host arbiter cannot `instanceof` a class
  it cannot import; today it can only match on `error.name`.
- `packages/ribo-extractor-openai/src/index.ts` does not export `assertStopFinishReason`,
  `completeOrClassify`, `parseWithSchema`, `parseJsonContent` or `buildMessages`
  (`extraction-common.ts`). R3's plan names the first two as "hard-won and must not be
  reimplemented", and `extractor-arbitration-design.md` §3.1 exports the arbitration engine
  precisely so a consumer can write a combinator the repo did not anticipate — but a consumer
  writing a strategy cannot reach the trust-boundary gates that make one correct, and will copy
  them. The harness behind `docs/deep-dives/native-extraction.md` did exactly that.

**Fix:** export both sets. The `extraction-common.ts` header already documents each helper as
public-quality; nothing else changes.

### B6. Three casts are redundant — **ran**

`packages/ribo-core/src/instance-write-step.ts:122,144` (`adapter.schema.parse(…) as V`) and
`packages/ribo-extractor-ondevice/src/three-phase-extractor.ts:253` (`parsed as Enveloped<V, P>`).
Both packages typecheck with the casts deleted: `ValuesSchema<V>` already binds `parse` to `V`
(that is what its `_zod.output` member is for, `adapter.ts:66–69`), and `ZodType<Enveloped<V, P>>`
already parses to `Enveloped<V, P>`. A redundant assertion is not harmless — it is the one that
keeps compiling after the type it asserts has drifted.

**Fix:** delete them. `@typescript-eslint/no-unnecessary-type-assertion` would have flagged all
three and is not running — see P6.

---

## Decided

### D1. `per-group-composition-design.md` §4.4's variance argument was wrong — **ran**, corrected

That section said `Extractor.extract` must become a function-typed property so that "a narrow group
extractor must fail a wide slot". Probe: with today's method syntax, `Extractor<Pick<Enveloped<V,
P>, "rooms">>` is already rejected where `Extractor<Enveloped<V, P>>` is expected — `F` appears only
in the return position, which is checked covariantly for methods and properties alike. Method
bivariance bites on **parameters** that vary with a generic, which is `Transcriber<S>`'s
`transcribe(item: S)` case and not this one. The recommendation stands on consistency and on the
options parameter the design adds; the reason is corrected in that document by the same commit as
this one.

---

## Proposals

### P1. Method syntax on contracts: make the convention mechanical — **ran**

`@typescript-eslint/method-signature-style: ["error", "property"]` run once over the non-test
sources reports **51 members in 15 files**: `Extractor.extract` (`extractor.ts:104`),
`ChatClient.complete` and `CapableChatClient.capability` (`chat-client.ts:133,243`),
`CapabilitySource.capability` (`composite-extractor.ts:39`), `Transcriber.capability`
(`transcriber.ts:196`), `LiveTranscriber`/`LiveSession` (`live.ts`), `Relay`, `Connectivity`,
`CaptureSession`, `PluginStorage`, `CompositeTranscriber`, `CaptureCoordinator`, and the on-device
`LanguageModel`/`LanguageModelSession` mirrors. **None of the 51 is a bug today** — every one has
either no parameters or parameters that do not vary with a type parameter, so bivariance has
nothing to widen (D1 is the demonstration). The repo nonetheless already chose property syntax
twice for a stated reason (`Transcriber.transcribe`, `ToolAdapter.write`), and the next contract
with a generic parameter will be written by someone who does not remember why.

**Proposal:** turn the rule on. The `LanguageModel*` interfaces mirror a browser API and may keep
method syntax under a file-level disable, since they are never implemented by this repo. Cost: a
mechanical rewrite of 51 lines and a lint-config line; the rule is autofixable.

### P2. Absent-versus-`undefined` is load-bearing prose that the compiler is not enforcing — **ran**

The repo keeps "absent" and "explicitly `undefined`" apart on purpose and says so at length:
`ExtractionUsage.cachedPromptTokens` ("absent means no call reported it; `0` means none hit"),
`GroupUnit.usage` in `per-group.ts:648–651` ("`usage: undefined` would still answer `"usage" in
event` with true"), `FakeExtractor`'s `raw`, `ExtractStepResult.usage`, the relay's conditional
spreads. Probe: `{ …, usage: undefined } satisfies ExtractionUnit` compiles, because
`exactOptionalPropertyTypes` is not set in `packages/tsconfig/base.json`. Every one of those
distinctions is held by discipline and conditional spreads, not by the type.

**Proposal:** enable `exactOptionalPropertyTypes`. It is a `strict`-family flag the base config
does not turn on, and it converts each documented convention into a compile error. Cost: unknown
until tried — it is the flag most likely to surface real fallout, typically in test fixtures and
in `?: T` members assigned from `T | undefined` expressions. Run it on a branch and count before
committing to it; if the count is large, the alternative is to accept that the convention is
prose.

### P3. The derivation invariant is prose: any `ZodType<Enveloped<V, P>>` is an `extractionSchema` — **ran**

`adapter.ts` says `enveloped(schema)` is "the ONE supported way" to build `extractionSchema` and
that hand-declaring both is "how they drifted apart unnoticed" (R1.5's motivating defect). Probe:
`{ extractionSchema: z.custom<Enveloped<V>>() }` satisfies `ExtractionTarget<V>`. `ValuesSchema<V>`
binds `schema` to `V` through zod internals precisely so a disagreeing patch schema is refused
(`adapter.ts:56–97`); nothing binds `extractionSchema` to `schema`. The adapter's frozen-fixture
test pins the derivation for Snugg Pro only.

**Proposal:** two options, recorded with the trade the file itself already weighed. (a) Type
`extractionSchema` as `ReturnType<typeof enveloped<T, P>>` and make the adapter generic over the
schema type `T` rather than the values type `V` — the strongest binding, and a large signature
change through `ToolAdapter`, `ExtractionTarget`, every strategy and `ribo-ui-react`. (b) The
`defineToolAdapter(schema, { provenance, … })` factory `adapter.ts` considered and set aside; it
binds the two at every declaration site that uses it and none that does not. Given breaking
changes are acceptable, (a) is the honest version of the claim the prose makes; (b) is the cheap
one. Either way the prose should stop saying "the one supported way" until one of them exists.

### P4. Review's `provenance` is keyed by `string`, and a typo is silent there — **read** / reasoned

`review.ts:757` (`BuildReviewRequestOptions.provenance?: Readonly<Record<string,
ProvenanceGranularity>>`), `use-review.ts:90` (same), consumed at `review.ts:545` as
`provenance[key] ?? "leaf"`. `enveloped()` validates the same map and **throws** on an unknown
group (`enveloped.ts:220–252`), for the stated reason that the failure is otherwise silent.
`buildReviewRequest` does not validate it; an unknown key is ignored and the group renders as a
table of blanks — the exact symptom `group-provenance-granularity-design.md` §9 describes. No test
covers the unknown-key case (grep of `review.test.ts`).

**Proposal:** type it as `ProvenanceMap<T>` by making `buildReviewRequest` generic over the values
schema it already takes (`valuesSchema: T extends z.ZodObject`), and validate at runtime for a JS
caller with the same `validateProvenance` core already has (export it). `useReview` follows. Cost:
small; the map type exists.

### P5. `ArbiterVerdict.accept` is checked at runtime for something the type could say — reasoned

`arbitration.ts:75–86` — `accept: ExtractionResult<F>`, and `applyVerdict` throws a `TypeError`
naming the arbiter if the result "was not produced by any candidate" (`:240–250`), with a
documented near-miss around `undefined`. If `accept` took the `ResultOutcome<F>` (or its index in
`outcomes`) the engine would read the candidate id off it and the check, the `undefined` hazard
and the identity comparison all disappear.

**Proposal:** `{ accept: ResultOutcome<F> }`. Touches the three arbiters in core, `instanceLadder`'s
consumers, and the guide. The design's §0.8 declined retagging the verdict; this is narrower — one
arm's payload — and removes a runtime validation rather than adding a tag.

### P6. Type-aware linting is off, on a stale premise — **read**

`eslint.config.mjs:25–28`: "Syntactic rules only for now. Type-aware linting (recommendedTypeChecked

- projectService) lands once packages have real source to point at … Adding it here would only lint
  an empty repo." The repo is no longer empty. B6's three redundant casts are exactly what
  `no-unnecessary-type-assertion` exists for; `no-unsafe-*` would audit the `as Record<string,
unknown>` reads in `review.ts:1015–1051` and the transports' body casts (O3) for free.

**Proposal:** enable `recommendedTypeChecked` with `projectService`, then triage. Cost: lint time
(type information per package) and an initial wave of findings; the test files are where most will
land.

### P7. `Roster`, `RosterCandidate` and `FillScope` are declared three times — **read**

Generic hand-written interfaces in `ribo-extractor-openai/src/instance-fill.ts:57–86`; a
zod-inferred `RosterCandidate`/`Roster` in `ribo-adapter-snuggpro/src/inventory.ts:54,98`; and a
second hand-written `FillScope` in `ribo-adapter-snuggpro/src/instructions.ts:639–…` with the
comment "duplicated here so the adapter does not depend on the extractor package". Compatible
today (the typecheck proves it), and the adapter's inferred type is correctly narrower (an enum
eligibility, the two-branch candidate). But the inventory/fill vocabulary is a contract between an
adapter and a strategy, and the adapter cannot import the strategy's package.

**Proposal:** the generic `Roster`/`RosterCandidate`/`FillScope` belong in `ribo-core` beside
`ExtractionTarget`, which both packages already depend on. `instance-fill.ts` re-exports them;
`instructions.ts` deletes its copy. Small.

### P8. `RequiredOnCreate` is `Record<string, readonly string[]>` — reasoned

`adapter.ts:19`. Group and leaf names are untyped against `V`; the adapter pins them with a runtime
walk (`adapter-snuggpro/src/adapter.test.ts:176`), and `ToolAdapter`'s doc comment tells every
adapter author to write that test. `{ [K in keyof V & string]?: readonly (keyof
NonNullable<V[K]>)[] }` (unwrapping an array group's element) would make the typo a compile error
and the test unnecessary. Cost: a type-level helper alongside `Enveloped`, and `review.ts` reads it
by string anyway, so the runtime does not change.

---

## Observations — no action proposed

### O1. Casts that are justified by a contract the code maintains — **read**

Judged one by one. `split-schema.ts:138–144,271,353` and `per-group.ts:280–283,453`: zod 4's
`ZodArray.element` / `ZodObject.shape` are typed against the core API while every schema here is
built through the classic API; each cast has a comment saying so. `gap-fill.ts:290` (`mapLeaves(…)
as Enveloped<V>`): the walk replaces leaf envelopes with leaf envelopes parsed against the leaf's
own schema, so the shape is preserved by construction. `per-group.ts:721` (`responses[i] as
Record<string, unknown>`): each response passed a strict-object parse two lines earlier.
`review.ts:1015–1051`: the patch reassembly casts nodes it created in the preceding walk.
`restrict-to-kind.ts:47` (`item as S`): a runtime `kind` check precedes it and the comment says
TypeScript cannot narrow a generic comparison. `schema.ts:1366` (`described as unknown as T`):
rebuilding a shape by `Object.entries` loses its type; `.describe()` preserves each field's type,
so `T` holds. None of these is papering.

### O2. Two conventions for the "context" generic — **read**

`AudioCapture<C extends z.ZodType>` and `CaptureItem<C extends z.ZodType>` take the **schema** type;
`ToolAdapter<V, C>` and `Recorder<C>` take the **value** type and carry a `ctxSchema: ZodType<C>`
beside it. Both work. A reader meeting `C` in two files must check which it is.

### O3. Transport bodies are cast, then guarded — not zod-parsed — **read**

`openai-chat.ts:124`, `helix-chat.ts:217`, `ribo-transcriber-managed/src/transcribe.ts:142`,
`ribo-transcriber-managed-docs/src/transcribe.ts:180`: `(await response.json()) as
<BodyShape>`, where every leaf of the body shape is `unknown` and each read is `typeof`-guarded
before use, throwing `malformed-response`. That is sound. It is not what `AGENTS.md` §4 says
("Anything crossing a trust boundary — STT responses, extraction output … — is parsed with a zod
schema, not cast"). The extraction **output** is zod-parsed; the transport **envelope** is not.
Either amend the sentence to say so or parse the envelope with a loose zod object — a taste call,
recorded so the next reader does not report it as a defect.

### O4. Session `ctx` is `unknown` until write — **read**

`OpenSessionInput.ctx: unknown` (`outbox.ts:87`), `SessionWriteInput.ctx: unknown` (`relay.ts`),
parsed by `adapter.ctxSchema.safeParse` only in the write step (`write-step.ts:75`,
`instance-write-step.ts:73`), where a mismatch is terminal. `ToolAdapter<V, C>`'s `C` never meets
the session at open time. Structural — the outbox is adapter-agnostic — and `audioCaptureSchema(ctx)`
shows the pattern that would type it (the host hands a schema at open). Accepted as-is; noted
because the type parameter reads as stronger than it is.

### O5. `ReviewOutcome` and `reviewOutcomeSchema` are two declarations of one shape — **read**

`review.ts:355` (hand-written union) and `:1251` (zod, inferred as `PersistedReviewOutcome`). Pinned
by a runtime test (`review.test.ts:676`) that parses each branch of a `resolveReview` result. A
type-level mutual-assignability assertion between the two would catch a drift the runtime test's
three fixtures happen not to exercise. Two lines in the existing test.

### O6. `ValuesSchema<V>` depends on zod internals, by documented choice — **read**

`adapter.ts:99–100` names `_output` and `_zod`, zod pinned at 4.4.3. The comment records the risk,
the reason each member is load-bearing, and that a zod upgrade renaming them fails the typecheck
rather than anything silent. Nothing to do; recorded so it is not rediscovered as a smell.

---

## What this review did not do

- Run the type-checked lint config (P6) or `exactOptionalPropertyTypes` (P2) to count their
  fallout. Both are cheap to try on a branch and expensive to guess at; the numbers should decide.
- Read `ribo-ui-react`'s hook bodies beyond their signatures. Its exported surface is small and
  typed against core; `AnyRecorder = Recorder<Record<string, unknown>>` (`context.ts:28`) erases
  the host's context type through the provider and documents that it does.
- Audit the on-device Whisper worker protocol types (`ribo-transcriber-ondevice/src/protocol.ts`,
  `worker.ts`) beyond the cast survey; their `as unknown as` casts wrap transformers.js pipeline
  objects whose types the library does not export.

## Trial result: `exactOptionalPropertyTypes` (P2)

**Measured 2026-09-15: 52 TypeScript errors across the workspace with the flag enabled.**

Left off. The flag would enforce the absent-versus-`undefined` distinction this repo documents at
length and currently maintains by discipline alone — `UsageTotals` and the conditional-spread
pattern in the extractors exist precisely because `{ usage: undefined }` and `{}` must not be
confused. So the flag is aligned with the codebase's intent, and 52 is a tractable number.

It is not free, though: every one of those sites is a real decision about whether a property is
optional-and-absent or optional-and-explicitly-undefined, and getting one wrong silently changes
behaviour at a boundary the type system was supposed to be guarding. That is a focused piece of
work with its own review, not a flag flip to fold into unrelated tasks.

## Why seven TypeDoc link warnings are accepted (B4 follow-up)

`docs:api` reports 0 errors and 7 warnings, and that is deliberate.

All seven are `{@link CaptureItem}` and `{@link AnnotatedTranscript}` in JSDoc written on
`ribo-core` contracts and **inherited** into implementing classes in the transcriber packages,
where a bare link target is out of scope. The original findings already named this category as
distinct from the resolvable ones.

Two fixes were measured and both are worse:

- `validation.invalidLink: false` meets a zero-warning gate by muting the validator, which hides
  these seven **and every future real break**. That is what Task 14 shipped and it is reverted.
- Qualifying as `{@link @azx/ribo-core!Symbol | Symbol}` raises the count to **42** — this
  TypeDoc reads the qualified form as a literal symbol name rather than a cross-package
  reference.

Warnings do not fail the build. Seven lines of output is the price of the validator still working.
