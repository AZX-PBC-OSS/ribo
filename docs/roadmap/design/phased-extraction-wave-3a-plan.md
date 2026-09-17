# Phased Extraction — Wave 3a: the phase vocabulary, with no engine yet

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every type and pure function `phasedExtractor` will be built from, landed and tested without the combinator existing. A phase becomes a value a caller can construct, inspect and validate; nothing runs one yet.

**Architecture:** Five small modules in `@azx/ribo-core`, all pure. The load-bearing one is the phase type itself, which hides its item and contribution types **existentially** rather than erasing them with a cast — so the combinator that lands in Wave 3b cannot hand one phase's items to another phase's `run` without a compile error. Beside it: branded note keys that give the cross-phase bag real types while keeping its keys plain strings at runtime, a homomorphic deep partial for the draft's progressively-filled fields, and a construction-time validator that rejects a mis-wired phase list before any call is paid for.

**Tech Stack:** TypeScript, Vitest. No new dependencies.

**Spec:** `docs/roadmap/design/phased-extraction-design.md` (§4.1, §4.3, §6)

## Global Constraints

- **Purely additive.** No existing behaviour changes. Every existing test passes unmodified; if one does not, stop and report rather than amending it. The one expected exception is `packages/ribo-core/src/index.test.ts`, the barrel manifest, which must grow deliberately alongside each new export — its own header says so.
- **No `as` casts in the phase encoding.** The whole point of the existential shape is that it needs none. `noteKey`'s single documented cast is the only one this wave may contain; if anything else seems to need one, stop and report rather than adding it.
- **Nothing here imports a chat, prompt or provider concept.** These are core types; a phase's `run` is opaque. If a task seems to need `ChatClient` or a message, the task is in the wrong package.
- `ribo-core` must not import from any `ribo-extractor-*` package.
- Tests run from the repo root: `pnpm vitest run packages/<dir>/src/<file>.test.ts`. There is no per-package `test` script.
- Every new file carries an `@file` header in the style of its neighbours in `packages/ribo-core/src/` — what it is, why it exists, and what it deliberately does not do.

---

### Task 1: Branded note keys

**Files:**

- Create: `packages/ribo-core/src/phase-notes.ts`
- Create: `packages/ribo-core/src/phase-notes.test.ts`
- Modify: `packages/ribo-core/src/index.ts`, `packages/ribo-core/src/index.test.ts`

**Interfaces:**

- Produces: `NoteKey<T>` — a `string` intersected with an optional property under a module-private `unique symbol`, whose type is a **function type** `(value: T) => T`. `noteKey<T>(id: string): NoteKey<T>`. `Notes` — an immutable bag with `get<T>(key: NoteKey<T>): T | undefined`, `set<T>(key: NoteKey<T>, value: T): Notes`, and `readonly keys: readonly string[]`. `emptyNotes(): Notes`.

**Why the brand's type is a function and not just `T`.** A bare `{ readonly [Brand]?: T }` makes `NoteKey<T>` covariant in `T`, so a `NoteKey<Roster>` would be assignable to a `NoteKey<unknown>` slot and the wrong-type read this exists to prevent would typecheck. A function type `(value: T) => T` puts `T` in both input and output position, making it invariant — which is what makes a mismatched `get` a compile error. This is the same reason `method syntax defeats strictFunctionTypes` bites elsewhere in this ecosystem: the variance of the position is the whole mechanism.

**Why the key stays a plain string at runtime.** `requires`/`produces` are string arrays, the Wave 3b construction check compares them as strings, and a later planner will emit them as JSON. The brand is a compile-time phantom only — `noteKey` is a cast and nothing else, and `keys` returns plain strings.

- [ ] **Step 1: Write the failing tests**

  Assert, at the type level using the repo's existing `@ts-expect-error` convention (see `extraction-observer.test.ts` for the house pattern): reading a key at the wrong type is an error; storing a value of the wrong type under a key is an error; a `NoteKey<Roster>` is **not** assignable to a `NoteKey<PresenceMap>` slot even though both are strings at runtime (declare two small local interfaces for this — do not import adapter types).

  At the value level: `get` on an absent key returns `undefined`; `set` returns a **new** `Notes` and leaves the original unchanged (assert the original still returns `undefined`, so the immutability is pinned rather than assumed); `set` twice under the same key overwrites; `keys` lists the plain string ids of everything set, in insertion order; `keys` on `emptyNotes()` is empty; and `noteKey<unknown>("scratch")` round-trips any value, so the open-bag escape hatch survives.

- [ ] **Step 2: Run to verify they fail**

  Run: `pnpm vitest run packages/ribo-core/src/phase-notes.test.ts`
  Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement**

  Back `Notes` with a `ReadonlyMap`, copying on `set`. The bag is small (a handful of keys per run) so copying is the right trade against the invariant that `merge` owns every write.

- [ ] **Step 4: Run to verify they pass, export from the barrel, typecheck**

  Expected: PASS. Then `pnpm --filter @azx/ribo-core typecheck`.

- [ ] **Step 5: Commit**

---

### Task 2: `PhaseDraft` and its deep partial

**Files:**

- Create: `packages/ribo-core/src/phase-draft.ts`
- Create: `packages/ribo-core/src/phase-draft.test.ts`
- Modify: `packages/ribo-core/src/index.ts`, `packages/ribo-core/src/index.test.ts`

**Interfaces:**

- Produces: `DeepPartial<T>` — the homomorphic mapped type `{ [K in keyof T]?: DeepPartial<T[K]> }`. `PhaseDraft<V, P>` with **`readonly`** `fields: DeepPartial<Enveloped<V, P>>`, `statedEmptyGroups: Readonly<Record<string, string>>`, `raw?: unknown`, and `notes: Notes`. `emptyDraft<V, P>(): PhaseDraft<V, P>`.

**Every member is `readonly`, and that is a design commitment rather than tidiness.** The design's must-fail list requires that a `run` receiving the draft cannot write through it — items within a phase run concurrently, so a mutating `run` races its siblings, and `merge` owning every write is what makes the phase contract coherent. Declaring the members mutable here would foreclose the type-level half of that check permanently, since this wave freezes the shape. Every writer rebuilds anyway: `emptyDraft` constructs, `extractorPhase`'s merge spreads. The group keys inside `DeepPartial` are already `readonly`, so this only extends the same discipline one level out.

**Why homomorphic, and why not `Partial`.** A top-level `Partial<Enveloped<V, P>>` cannot express what the strategies need: a span phase that learned one leaf's `sourceSpan` would still have to supply `value` and `confidence` for that leaf and every sibling leaf of the group. Since the whole design splits presence, span and classify into phases that each know a **different member of the same envelope**, the top-level partial is a non-starter. The homomorphic form preserves `readonly`, preserves optionality, keeps a collection group's `z.array` shape as an array whose element becomes possibly-undefined, and leaves leaf enum unions intact.

**The three-state leaf is a feature, not an accident.** Under the deep partial a leaf's `value` reads as `T | null | undefined`. "Not yet asked" (`undefined`) and "asked, answered null" (`null`) are different claims, and keeping them apart is exactly what `provenance.ts`'s anti-hallucination rule is for. Say so in the doc comment, because the first merge helper anyone writes will otherwise collapse them with `?? null`.

**Why `statedEmptyGroups` is required on the draft but optional on the result.** On the draft it is always present (empty when nothing has been recorded), so a phase's `merge` never has to guard it. On `ExtractionResult` it is optional and its **absence is meaningful** — `extractor.ts` documents absence as "this extractor ran no roster pass". Wave 3b is what omits it when empty; this task only has to make the draft's side unconditional.

- [ ] **Step 1: Write the failing tests**

  Type-level, against a small hand-written `V` that mirrors the real shape — one flat group of enveloped leaves and one array-shaped collection group, with at least one **enum** leaf (do **not** import the Snugg adapter; core must not depend on it). Assert: a draft can carry one leaf's `sourceSpan` with no sibling leaves present; a collection group stays an array; a `readonly` group key cannot be assigned directly, and neither can a `PhaseDraft` member itself; a fully-populated `DeepPartial<Enveloped<V>>` is **not** assignable to `Enveloped<V>` (pinned with `@ts-expect-error` — this is what makes Wave 3b's closing trust-boundary parse structurally required rather than optional); and a leaf's `value` includes `undefined` as well as `null`.

  **Pin the enum leaf's union exactly**, with a type-equality assertion (a conditional-type `Eq` helper, not an assignability check): the deep partial of an enum leaf's `value` must be exactly `Member1 | Member2 | null | undefined`. Assignability alone would not catch this. The failure mode is silent and therefore the one most worth a test — a later "simplification" of `DeepPartial` to a non-homomorphic or conditional form mangles enum leaves into something write-compatible, so valid members still assign and nothing fails; the only symptom is leaf validation quietly disappearing.

  Value-level: `emptyDraft()` has empty `fields`, empty `statedEmptyGroups`, absent `raw`, and empty `notes.keys`.

- [ ] **Step 2: Run to verify they fail**

  Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement, then measure the type cost**

  After it typechecks, run `pnpm --filter @azx/ribo-core typecheck` and confirm it completes in the same order of magnitude as before. The deep partial over a large enveloped schema was measured during design at roughly +3% type instantiations, which is negligible — but if this typecheck becomes visibly slower, stop and report rather than proceeding.

- [ ] **Step 4: Run to verify they pass, export, typecheck**

- [ ] **Step 5: Commit**

---

### Task 3: `PhaseOutput` and `PhaseItemOutcome`

**Files:**

- Create: `packages/ribo-core/src/phase-outcome.ts`
- Create: `packages/ribo-core/src/phase-outcome.test.ts`
- Modify: `packages/ribo-core/src/index.ts`, `packages/ribo-core/src/index.test.ts`

**Interfaces:**

- Produces: `PhaseOutput<C>` — `{ readonly value: C; readonly usage?: ExtractionUsage }`. `PhaseItemOutcome<I, C>` — a union discriminated on `outcome`: `{ outcome: "result"; item: I; output: PhaseOutput<C>; error?: never }` and `{ outcome: "error"; item: I; error: unknown }`.

**Why `outcome: "result" | "error"` and not a `Settled`-shaped type.** `arbitration.ts` already establishes this exact discriminator for `ExtractionOutcome` and `TranscriptionOutcome`; a second outcome vocabulary in the same package would be one too many. A type named `Settled` with `status`/`fulfilled`/`rejected` would also read as `PromiseSettledResult` while having a different shape (it carries the item), inviting the wrong mental model in a file that also uses `Promise.allSettled`.

**Why `error?: never` on the success arm.** It makes `.error` narrow on the discriminant without a cast, matching `arbitration.ts`'s treatment.

**Why `run` returns `PhaseOutput<C>` rather than bare `C`.** Wave 3b's combinator owns usage accumulation, but the ported phase definitions will not wrap an `Extractor` — they assemble messages and call a transport directly, and one `run` can make several calls. Without a usage channel the combinator would undercount every strategy it hosts. Note in the doc comment that `usage` is optional precisely because a phase that computes rather than calls has none to report.

- [ ] **Step 1: Write the failing tests**

  Type-level: on the `"error"` arm, `error` is present and reading `.output` **is** an error (that member genuinely does not exist); narrowing on `outcome` works without a cast.

  **Do not pin the result arm's exclusivity with a read.** `error?: never` makes the member _exist_ on the success arm — reading it yields `undefined` and compiles clean, so a `@ts-expect-error` above the read is an unused directive and fails the build with TS2578, the same trap `extraction-observer.test.ts` already documents. Pin it by **write and by construction** instead: assigning to `.error` on a result arm errors, and a `PhaseItemOutcome` object literal carrying both `outcome: "result"` and an `error` errors. That is also what `arbitration.ts` does for its own `never` members, which this type is modelled on.

  Value-level: a small helper constructing each arm round-trips its members.

- [ ] **Step 2: Run to verify they fail** — Expected: FAIL, module does not exist.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run to verify they pass, export, typecheck**

- [ ] **Step 5: Commit**

---

### Task 4: The phase type, existentially quantified

**Files:**

- Create: `packages/ribo-core/src/phase.ts`
- Create: `packages/ribo-core/src/phase.test.ts`
- Modify: `packages/ribo-core/src/index.ts`, `packages/ribo-core/src/index.test.ts`

**Interfaces:**

- Produces: `PhaseContext<V, P>` (the immutable inputs a phase reads: the transcript, the extraction target, and the caller's `signal` and `deadline`). `PhaseDef<V, P, I, C>` — the three functions, an optional `describeItem`, plus the metadata. `PhaseMeta` — `id`, optional `requires`, `produces`, `concurrency`, `onItemFailure`, `maxRetries`. `Phase<V, P>` — `PhaseMeta` plus a single `with` member. `phaseBuilder<V, P>()` returning a function that takes a `PhaseDef<V, P, I, C>` and returns a `Phase<V, P>`.

**`describeItem` exists because `PhaseUnit` needs a key the combinator cannot otherwise obtain.** `PhaseUnit` carries a required `key: string` and an optional `leaf?: string`, and the design gives the **combinator** the unit stream. But a phase's `run` is opaque and `I` is existentially hidden, so the Wave 3b scheduler has no way to learn what group an item belongs to. Every other member of the event is derivable — `phaseId` and `pass` from position and metadata, `usage` from `PhaseOutput`, `attempt` from the retry loop — and `key`/`leaf` are not. So `PhaseDef` carries `describeItem?: (item: I) => { key: string; leaf?: string }`, callable inside `with` where `I` is bound.

It is **optional**, defaulting to `key: ""`. That is not a placeholder: `groupedExtractor`'s `GroupMap` already uses the `""` arm to mean "one entry covering the whole schema", and a phase whose single item _is_ the whole document — `extractorPhase`, the inventory pass — has no meaningful group key. The default and the convention agree.

This wave is where `PhaseDef` is frozen, which is why the member lands now rather than when Wave 3b discovers it missing.

**The encoding, precisely.** `Phase<V, P>` exposes its metadata as ordinary properties and hides `I` and `C` behind one member: `with`, a function taking a **generic callback** (`<I, C>(def: PhaseDef<V, P, I, C>) => R`) and returning that callback's `R`. The combinator writes `phase.with(def => …)` and, inside that callback, `I` and `C` are bound and correlated — so `def.plan`'s items provably feed `def.run`, and handing another phase's items to this one's `run` is a compile error.

**Why not an erasing cast.** The obvious alternative is `Phase<V, P> = PhaseDef<V, P, unknown, unknown>` with `definePhase` doing an `as unknown as`. That compiles, and it makes the single most likely bug in Wave 3b's scheduling loop — an off-by-one over the phase list, a retry re-dispatching against a stale index — invisible to the compiler, in the exact code that is hardest to test. The design's §4.4 claims this combinator deletes a bug class; funding that by introducing one is not a trade worth making. The encoding costs one level of indentation in the loop.

**Why curried.** TypeScript has no partial type-argument inference, and every `V`/`P`-generic constructor in this repo is called with explicit `<V, P>`. A single four-parameter `definePhase<V, P, I, C>` therefore fails at the call site the moment anyone writes the two they know — the failure mode is `TS2558: Expected 4 type arguments, but got 2`. Currying fixes `V`/`P` once per strategy and infers `I` and `C` per phase from the definition.

- [ ] **Step 1: Write the failing tests**

  Value-level, with two hand-written phases over a tiny `V`: build a phase whose items are `string` and contribution is `boolean`, and another whose items are `number`; call `.with()` on each and assert the definition's own functions come back and behave (call `plan` on an empty draft, feed one item to `run`, fold the outcome through `merge`).

  Type-level, and these are the point of the task: assert with `@ts-expect-error` that inside one phase's `with` callback, passing the **other** phase's item type to `run` is an error; that `PhaseMeta` is readable off a `Phase` without calling `with` (the construction check and a later planner need this); and that `phaseBuilder<V, P>()` infers `I` and `C` from the definition with no type arguments at the inner call.

  Also pin `describeItem`: a phase that supplies one returns its key and leaf for a given item, and a phase that omits one is still a valid `Phase` (the combinator's `""` default is Wave 3b's concern, not this task's — only the optionality is pinned here).

  **`noUncheckedIndexedAccess` is on**, so `plan`'s `readonly I[]` indexes as `I | undefined` and `def.run(items[0], …)` will not compile. Use `for…of`, or a non-null assertion — **not** a cast. This is called out because this plan's no-`as` constraint would otherwise send an implementer to a cast and then into the stop-and-report tripwire for a problem that is purely about index access.

  Assert the file contains no `as` cast, by construction rather than by grep — if the implementation needs one, the encoding is wrong and you should stop and report.

- [ ] **Step 2: Run to verify they fail** — Expected: FAIL, module does not exist.

- [ ] **Step 3: Implement**

  `phaseBuilder<V, P>()` returns a closure that wraps a `PhaseDef` into a `Phase` by spreading the metadata and supplying `with` as `use => use(def)`. That is the whole implementation.

- [ ] **Step 4: Run to verify they pass, export, typecheck**

- [ ] **Step 5: Commit**

---

### Task 5: The construction-time phase-list validator

**Files:**

- Create: `packages/ribo-core/src/validate-phases.ts`
- Create: `packages/ribo-core/src/validate-phases.test.ts`
- Modify: `packages/ribo-core/src/index.ts`, `packages/ribo-core/src/index.test.ts`

**Interfaces:**

- Produces: `validatePhases<V, P>(phases: readonly Phase<V, P>[]): void` — throws on a mis-wired list, returns nothing on a good one.

**What it rejects, and the message each throw carries.** An empty phase list. A duplicate `id` (naming the id). A phase whose `requires` names a key that no **earlier** phase `produces` (naming both the phase id and the missing key — order matters, so a key produced by a later phase is still an error). A `concurrency` that is not a positive integer, and a `maxRetries` that is negative, both naming the phase and the value.

**Why this is the piece that makes a model-emitted plan safe.** It is the same move `groupedExtractor`'s coverage check and `enveloped()`'s `validateProvenance` make: a composition error surfaces before the first call is paid for rather than after every other phase's calls have been spent. In the eventual agentic layer it is also the admission control — a planner cannot emit a list that wires phases in the wrong order, because construction rejects it and the rejection names the key, which is the repair prompt for the next attempt. It is a key-presence check and not a type system; Task 1's branded keys are what make it more than that.

- [ ] **Step 1: Write the failing tests**

  One test per rejection, each asserting both that it throws and that the message names the offending phase id and key/value — a validator whose message does not identify the problem is half a validator, and the agentic use above depends entirely on the message. Plus: a well-formed list with a key produced by phase 1 and required by phase 3 passes; a list where phase 1 requires what phase 2 produces **throws**; a phase with no `requires` and no `produces` passes; and a single-phase list passes.

- [ ] **Step 2: Run to verify they fail** — Expected: FAIL, module does not exist.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run to verify they pass, export, typecheck**

- [ ] **Step 5: Commit**

---

### Task 6: `extractorPhase` — any `Extractor` becomes a phase

**Files:**

- Create: `packages/ribo-core/src/extractor-phase.ts`
- Create: `packages/ribo-core/src/extractor-phase.test.ts`
- Modify: `packages/ribo-core/src/index.ts`, `packages/ribo-core/src/index.test.ts`

**Interfaces:**

- Produces: `extractorPhase<V, P>(id: string, extractor: Extractor<Enveloped<V, P>>): Phase<V, P>`.

**What it is for.** It is the primitive that makes `phasedExtractor` the outer shell for the whole family rather than a fourth sibling beside the existing combinators: any existing `Extractor` — a `singleShotExtractor`, a `perGroupExtractor`, a `gapFillExtractor` — becomes a phase in a list. Wave 4's gap-fill port is a base extractor phase followed by a follow-up phase, and this is the base.

**Its shape.** One item (a unit value — the whole document), so `plan` returns a single-element array regardless of the draft. `run` calls `extractor.extract`, forwarding the context's `signal` and `deadline`, and returns the result's `fields` as the contribution with the result's `usage` on the `PhaseOutput`. `merge` installs those fields into the draft, and carries `raw` and `statedEmptyGroups` across when the result had them.

**The merge is a shallow top-level assign, and that is deliberate.** A lifted extractor returns a complete `Enveloped<V, P>` for the keys it covers, so a deep merge would be solving a problem that does not exist here while quietly deciding precedence questions this task has no basis to decide. Wave 3b's own phases do finer-grained merging; this one does not need to.

- [ ] **Step 1: Write the failing tests**

  With `FakeExtractor`: `plan` returns exactly one item whatever the draft holds; `run` forwards both the context's `signal` and its `deadline` (assert via `FakeExtractor.callOptions` — it exists so a dropped forward is visible); the result's `usage` arrives on the `PhaseOutput`; `merge` installs the fields into an empty draft and leaves `notes` untouched; `merge` carries `raw` and `statedEmptyGroups` through when present and leaves them absent/empty when not; and a phase built this way passes `validatePhases` as a single-element list.

  One more, which is the interesting one: `merge` applied to a draft that already holds fields overwrites only the keys the extractor returned, leaving other top-level keys as they were.

- [ ] **Step 2: Run to verify they fail** — Expected: FAIL, module does not exist.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run to verify they pass, export, typecheck**

- [ ] **Step 5: Commit**

---

### Task 7: Changeset and the full gate

**Files:**

- Create: `.changeset/<generated-name>.md`

- [ ] **Step 1: Add a changeset**

  `@azx/ribo-core` is **minor** — this wave is purely additive. The program's `major` is already declared by Wave 2's changeset; do not restate it.

  The summary should say what a consumer gains: the vocabulary for describing a multi-pass extraction strategy as a list of phases, with the wiring checked at construction. Note that nothing runs a phase yet.

- [ ] **Step 2: Run the full gate**

  `./check.sh`, then `pnpm docs:build` and `pnpm changeset status --since=origin/main`. Expected: PASS.

  Bare `pnpm changeset status` fails on a pre-existing mixed changeset unrelated to this work; use `--since=origin/main`, and if it still fails, verify the same failure exists at this wave's base commit before treating it as yours.

- [ ] **Step 3: Commit**

---

## Out of scope (confirmed against the design doc)

- `phasedExtractor` itself — Wave 3b. Nothing in this wave runs a phase, schedules items, retries, derives a budget, emits a `PhaseUnit` or parses a result.
- The per-phase-boundary `produces` verification (a phase that declares a key and does not write it). That check runs **during** a run, so it belongs with the engine in Wave 3b. This wave's validator is construction-time only.
- Porting `gapFillExtractor`, `scopedInstanceExtractor` or `threePhaseExtractor` — Waves 4, 5, 6.
- Removing `GapFillUnit`, `InventoryUnit` or `InstanceUnit` from the `ExtractionUnit` union — Wave 6.
- Retrofitting `groupedExtractor` or `instance-fill.ts` onto `retryExtractor` — still deliberately carried.

## Notes for the reviewer

Two things most worth adversarial attention. First, Task 4: whether the existential encoding actually delivers the correlation it claims, or whether there is a way to smuggle one phase's items into another's `run` that still compiles — the value of the whole encoding rests on that. Second, Task 2: whether the homomorphic deep partial behaves on a `z.array`-shaped collection group and under the `"row"` provenance intersection, since those are the two shapes in the real schema most likely to break a mapped type.

## Reviewed

Reviewed by OpenCode (`glm-5p3-flash`, run f706) before implementation. All five findings applied.
The review verified its claims by running an in-memory TypeScript program against the real
`Enveloped` and zod rather than reasoning about what the compiler would do.

The finding that changed the shape of the wave: `PhaseUnit` carries a required `key`, the combinator
owns the unit stream, a phase's `run` is opaque and `I` is existentially hidden — so Wave 3b's
scheduler would have had no way to learn an item's group key, and this wave is where `PhaseDef` is
frozen. Hence `describeItem`, optional, defaulting to the `""` convention `groupedExtractor` already
uses for "one entry covering the whole schema".

Three test-specification errors: `error?: never` makes the member exist, so pinning the result arm's
exclusivity with a **read** yields an unused `@ts-expect-error` and TS2578 — it must be pinned by
write and by construction. The enum-union survival claim had no test at all, and its failure mode is
silent because a mangled deep partial stays write-compatible. And `noUncheckedIndexedAccess` makes
`items[0]` a `I | undefined`, which this plan's own no-`as` rule would have turned into a
stop-and-report over a pure index-access problem.

One shape commitment: `PhaseDraft`'s members are now `readonly`, because the design requires that a
`run` cannot write through the draft it is handed, and declaring them mutable here would foreclose
the type-level half of that check permanently.

The review independently confirmed the encoding delivers its central claim — items cannot be
smuggled between phases through a bare or generic callback, a captured `def`, or the callback's
return type, and `any` is blocked by the lint config — and that the homomorphic deep partial behaves
on all three real shapes, including `"row"`-provenance intersections. The branded key's variance
reasoning was checked against `strict: true` implying `strictFunctionTypes`.
