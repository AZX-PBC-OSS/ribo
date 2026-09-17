# Phased Extraction — Wave 5: port `scopedInstanceExtractor` onto the engine

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `scopedInstanceExtractor` becomes two phases — a house-wide inventory pass, then one scoped fill per `(group, piece, instance)` — keeping every behaviour a host depends on except the changes Task 5 names. This is the port that exercises `notes` (the roster crosses a phase boundary), `statedEmptyGroups` (a first-class draft channel), and multi-granularity work.

**Architecture:** The inventory phase runs one item over the whole document, stores the roster in `notes`, and — because `plan` must stay pure — does **all** roster interpretation in its `merge`. The fill phase's `plan` then derives the job list from that settled state and does nothing else. `normalize` stays outside the engine entirely, wrapping it, so it keeps running after the closing parse as it does today.

**Tech Stack:** TypeScript, Vitest. No new dependencies.

**Spec:** `docs/roadmap/design/phased-extraction-design.md` (§4.7)

## Global Constraints

- **`scopedInstanceExtractor`'s signature is unchanged except its observer's unit type.** `ScopedFillOptions` keeps every member with the same meaning, including `inventory`, `instanceCap`, `requireRetryBudget`, `normalize`, the `BackoffOptions` members and the partition cap.
- **The fill item is a `(group, piece, instance)` triple, never a `(group, instance)` slot.** Partitioning multiplies fill calls _per instance_, each piece carrying its own narrowed schema and a suffixed request name; the pieces of one slot recombine with `mergeGroupPieces`. Slot-granularity items would serialise a slot's pieces inside one `run` instead of interleaving them through the pool.
- **`plan` is pure.** Today's job-derivation loop writes `statedEmptyGroups`, seeds empty collection groups and enforces the cap as it builds jobs. All of that moves to the inventory phase's `merge`.

  For the record, because it was the plan's main risk and was checked: job derivation **reads none of** the state that loop writes — only the roster, the prepared groups' metadata, `instanceCap` and the transcript. The `??=` on the collection arrays is write-only at derivation time and is read later, in the post-pool merge that the fill phase's `merge` replaces. There is no read-after-write, so the split is a rearrangement rather than a reordering.

- **The inventory is one-shot.** Called once today, no retry, its failure fails the run. The phase pins `maxRetries: 0`.
- **The cap check moves to the inventory phase's `merge`, deviating from design §4.7**, which puts it in the fill phase's `plan`. Deliberate and behaviourally equivalent — both are pre-fill, both produce the same two events, and a throw discards partial state either way — but it belongs where the roster is interpreted, and a pure `plan` should not throw on a roster property. Recorded so it is not mistaken for a regression.
- Tests run from the repo root: `pnpm vitest run packages/<dir>/src/<file>.test.ts`.

---

### Task 1: `PhaseUnit` carries piece coordinates

**Files:**

- Modify: `packages/ribo-core/src/extraction-observer.ts`, `phase.ts` (`describeItem`'s return type), `phased-extractor.ts`, `phased-extractor.test.ts`

**Interfaces:**

- Produces: `PhaseUnit` gains optional `instance`, `instances`, `part`, `parts`. `describeItem`'s return type widens to include the same four, all optional.

**Why.** `InstanceUnit` carries all four, and a progress consumer uses them to render "HVAC system 2 of 3, part 1 of 2". `PhaseUnit` carries `key` and `leaf` only, so the port would silently downgrade what a consumer sees — the events still arrive and say less. All four optional, so additive for every existing phase.

- [ ] **Step 1: Write the failing tests**

  A phase whose `describeItem` returns the coordinates emits them; a phase that omits them, or declares no `describeItem`, emits events with those members **absent** rather than `undefined` — the same omit-rather-than-claim rule the usage members follow.

- [ ] **Step 2: Run to verify they fail** — Expected: FAIL, the members do not exist.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the core suite** — Expected: PASS, nothing else modified.

- [ ] **Step 5: Commit**

---

### Task 2: The inventory phase

**Files:**

- Create: `packages/ribo-extractor-openai/src/inventory-phase.ts` and its test
- Modify: `packages/ribo-extractor-openai/src/index.ts` (export the phase and its options — Task 6's changeset claims hosts can compose these, which requires them to be public; `gapFillPhase`'s export is the pattern)

**Interfaces:**

- Produces: `inventoryPhase<V, P>(options): Phase<V, P>` — `inventory`, `prepared`, `instanceCap` — plus the exported note key it `produces`.

**`plan`** returns exactly one item. `describeItem` returns `{ key: "" }`.

**`run`** calls `options.inventory(ctx.transcript.text)`, returns the `Roster`, reports `{ calls: 1 }`. It does not wrap the roster function or change its contract — whatever it costs internally never reaches this extractor, today or after.

**`merge`** does every piece of roster interpretation:

- Store the roster in `notes` under the exported key.
- **Only for collection groups** — a singleton's roster entry is ignored today, because the singleton branch runs before any roster interpretation. A merge that iterates roster keys without checking `isCollection` leaks a singleton key into `statedEmptyGroups` and passes every existing test.
- A `stated: "none"` entry records its span in `draft.statedEmptyGroups` and seeds that group with `[]`.
- An entry that is **missing from the roster entirely** seeds `[]` — today's `roster[group.key] ?? []`. A literal reading of "an array with no current candidates" skips this and leaves the group `undefined` instead of `[]`. No existing test covers it, because the test roster builder always fills every key.
- An array with no `"current"` candidates seeds `[]`.
- Throw when a group's `"current"` count exceeds `instanceCap`, with today's message naming group, count and cap.

**`maxRetries` is 0.**

- [ ] **Step 1: Write the failing tests**

  `plan` returns exactly one item whatever the draft holds; `run` calls the inventory with the transcript text and reports one call; `merge` stores the roster under the note key; a `stated: "none"` collection group gets its span recorded **and** is seeded `[]`; **a `stated: "none"` shape under a _singleton_ key is ignored — `statedEmptyGroups` stays empty**; **a collection group absent from the roster is seeded `[]`**; a group whose candidates are all non-current is seeded `[]`; a group with current candidates is **not** seeded; and the cap throw names group, count and cap.

- [ ] **Step 2: Run to verify they fail** — Expected: FAIL, the module does not exist.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run to verify they pass, typecheck**

- [ ] **Step 5: Commit**

---

### Task 3: The fill phase

**Files:**

- Create: `packages/ribo-extractor-openai/src/fill-phase.ts` and its test
- Modify: `packages/ribo-extractor-openai/src/index.ts`

**Interfaces:**

- Produces: `fillPhase<V, P>(options): Phase<V, P>` — `target`, `chat`, `model`, `maxTokens`, `prepared`, the instruction builders. `requires` the inventory's note key.

**`plan`** reads the roster from `notes` and derives the job list exactly as today's loop does, minus the side effects Task 2 took. One job per `(group, piece, instance)`: for a collection group, one per current candidate per piece; for a singleton or the `""` fallback, one per piece at instance 0. Preserve both message paths — the `""` group uses `buildMessages(target, …)`, every other uses `buildFillMessages(…)`.

**`describeItem`** returns the job's `key`, `instance`, `instances`, `part`, `parts`.

**`run`** makes the one chat call for that job and parses it, as today.

**`merge`** recombines outcomes into the draft: pieces sharing a `(group, instance)` slot merge with `mergeGroupPieces`, and collection groups assemble into arrays **indexed by the job's `instanceIndex`**, never by arrival order.

**`merge` also writes `raw`**, and this is the finding that sank the previous port's first draft. Today `raw` is **always present** on the result. The engine emits `raw` only when a merge wrote it, so a port that does not write it drops the member entirely — and the existing suite cannot catch that, because its only `raw` assertion compares two results' `raw` to each other, which passes when both are absent. Write it to the assembled pre-normalize record, matching today and matching `gap-fill-phase.ts`'s precedent.

- [ ] **Step 1: Write the failing tests**

  `plan` yields one job per current candidate and skips a seeded group; `plan` yields one job per **piece** for a partitioned group, sharing group and instance, with distinct request names; `plan` yields one job at instance 0 for a singleton; the `""` group's messages come from `buildMessages`; `describeItem` reports the coordinates; `merge` recombines two pieces of one slot with `mergeGroupPieces`; `merge` writes `raw`.

  **The ordering test must drive `merge` directly**, through `phase.with(def => def.merge(draft, outcomes))` with the outcomes deliberately reversed — the pattern `gap-fill-phase.test.ts` already uses. It cannot be driven through `extract()`: `mapWithPool` writes `results[index]` and returns an index-ordered array, and the engine passes that straight to `merge`, so outcomes always arrive in plan order and an extract-level "reversed" test would pass against any implementation, including one that pushes in arrival order.

- [ ] **Step 2: Run to verify they fail** — Expected: FAIL, the module does not exist.

- [ ] **Step 3: Implement** — import the existing helpers; export any that are private rather than duplicating them.

- [ ] **Step 4: Run to verify they pass, typecheck**

- [ ] **Step 5: Commit**

---

### Task 4: `scopedInstanceExtractor` becomes the preset

**Files:**

- Modify: `packages/ribo-extractor-openai/src/instance-fill.ts`

**The new body.** Prepare the groups as today, build the engine with `phasedExtractor({ target, phases: [inventoryPhase(…), fillPhase(…)], concurrency, maxRetries, stepTimeoutMs, perCallCeilingMs, delay, baseMs, capMs, random, requireRetryBudget, onRetryBudget, onUnit })`, and **wrap it** (below). Delete the hand-rolled orchestration: the pool, the retry loop, the budget derivation, the abort controller, the event emission, the usage tally. Keep the group preparation, every message and scope builder, and every doc comment explaining _why_.

**Pass the `BackoffOptions` members through.** `ScopedFillOptions extends BackoffOptions`, and `baseMs`, `capMs` and `random` are all used today. The signature is unchanged either way, so TypeScript will not catch dropping them, and no test supplies them — a silent loss of injectable jitter, which is what makes retry tests deterministic.

**`normalize` wraps the engine rather than being handed to it, and both halves of that matter.** Today `normalize` runs **after** the closing parse and takes a full `Enveloped<V, P>`. The engine's run-level `normalize` runs **before** the parse and takes the draft's `DeepPartial`. Handing it over would change two things at once: a `normalize` whose output does not satisfy the schema would newly throw, and the preset would need a cast to bridge the types. So the preset returns an `Extractor` whose `extract` awaits the engine and then applies `normalize` to `result.fields` — preserving today's order exactly, and needing no cast because the parsed fields are already `Enveloped<V, P>`.

**`requireRetryBudget` passes straight through.** The engine implements the two-kinds-of-zero rule: zero against the full step timeout is the configuration error and throws `TerminalQueueError`; zero only against the remaining time runs without retries. Today's single derivation throws on the former, so that behaviour is preserved and the transient case is new and better.

- [ ] **Step 1: Rewrite the body, widen the observer's unit type, typecheck, commit**

  Do not run the suite yet — Task 5 is where its failures get classified.

---

### Task 5: Classify and amend every failing test

**Files:**

- Modify: `packages/ribo-extractor-openai/src/instance-fill.test.ts` **and `instance-ladder.test.ts`** — the ladder's tier 1 is this extractor, and three of its assertions check `unit === "inventory"` on these events. They are category 1, not regressions.

**Run both suites and read every failure before changing anything.** Each must fall into one of these categories. **A failure fitting none of them is a real regression — stop and report.**

1. **Events change from `InventoryUnit`/`InstanceUnit` to `PhaseUnit`.** Assertions on the unit discriminator become `phaseId`/`pass`. The piece coordinates survive (Task 1), so an assertion on `instance`, `instances`, `part` or `parts` should need only its discriminator changed — if one needs more, that is a Task 1 or Task 3 bug, not an amendment.
2. **The observer's unit type widened.**
3. **`onRetryBudget` now fires per reduced phase, and its `batches` value drops by one.** Today's estimate pads the inventory call into the job count; the ported fill phase's batches are derived from the fill jobs alone. The pinned value changes accordingly.
4. **Reference identity is lost.** The closing parse rebuilds every object.
5. **The failing-inventory event count changes.** Today an inventory failure emits exactly two events; under the engine, a start and an error for the inventory phase's one item, and the fill phase never runs.
6. **`usage.calls` counts successful items, not attempts.** Today every attempt increments the tally before the call; the engine sums usage from resolved outcomes only. A fill that succeeds on its second attempt reports `calls: 2` today and `1` after. This is a real semantic change, it is host-visible, and it goes in the changeset.
7. **Retry classification tightens.** Today's inline loop retries everything except `TerminalQueueError` and abort, so a 404 or 401 burns the whole budget. The engine composes `retryAsync`, which stops on a 4xx with a status and on cancellation. Fewer attempts, different event counts.

- [ ] **Step 1: Run both suites; write down every failure and its category**

- [ ] **Step 2: Amend, with a comment on each amended assertion naming its category**

- [ ] **Step 3: Add the assertions nothing currently covers**

  `result.raw` is **defined** and has the assembled shape including the seeded `[]`s — a presence assertion, not a comparison between two results, since two absent `raw`s compare equal. The inventory is attempted exactly **once** when it fails transiently. `statedEmptyGroups` is **absent** rather than `{}` when no group stated one. A fill failing once transiently then succeeding pins the new `usage.calls` semantics. A fill failing with a 4xx status is attempted exactly once.

- [ ] **Step 4: Run the whole package suite** — Expected: PASS.

- [ ] **Step 5: Commit**

---

### Task 6: Changeset and the full gate

- [ ] **Step 1: Add a changeset**

  `@azx/ribo-extractor-openai` **major**, `@azx/ribo-core` **minor** (Task 1 is additive). Name every host-visible change: the observer's unit type and event shapes; `onRetryBudget`'s per-phase firing and changed `batches`; lost reference identity; `usage.calls` counting successful items rather than attempts; and retry classification no longer burning the budget on a 4xx. Plus what a consumer gains: the inventory-then-fill strategy is a phase list a host can extend or reorder.

- [ ] **Step 2: Run the full gate** — `./check.sh`, `pnpm docs:build`, `pnpm changeset status --since=origin/main`.

- [ ] **Step 3: Commit**

---

## Out of scope

- Porting `threePhaseExtractor` — Wave 6.
- Removing `InventoryUnit`, `InstanceUnit` or `GapFillUnit` from the `ExtractionUnit` union — Wave 6.
- Retrofitting `groupedExtractor` onto `retryAsync`.
- The acceptance-gate run — once, after every port has landed.

## Reviewed

Reviewed by OpenCode (`glm-5p3-flash`, run a8a6) before implementation. All findings applied.

It answered the plan's own main risk in the affirmative: splitting today's job-derivation loop is safe, because job derivation reads none of the state that loop writes. That is now recorded in the constraints rather than left as a worry.

`raw` would have vanished again — the identical miss the previous port made — and again the suite could not have caught it, because its only `raw` assertion compares two results to each other and passes when both are absent. Two further semantic changes were unnamed: `usage.calls` stops counting failed attempts, and retry classification tightens so a 4xx no longer burns the budget. Both are host-visible and are now categories and changeset lines.

Three things would have been silently dropped: the `BackoffOptions` members (unchanged signature, so no typecheck error and no test supplies them), the barrel exports the changeset's own claim depends on, and the `?? []` that seeds a collection group missing from the roster entirely.

Two of my own specifications were wrong. `normalize` "runs where it runs today" was false on both counts — the engine runs it _before_ the parse where today it runs _after_, and the types differ — so it now wraps the engine instead, which preserves the order and removes the need for a cast. And the reversed-outcomes ordering test is not implementable through `extract()`: `mapWithPool` returns an index-ordered array, so outcomes always reach `merge` in plan order and an extract-level test would pass against any implementation. It drives `merge` directly instead.

Two more would have tripped the stop-and-report rule for no reason: `instance-ladder.test.ts` also breaks (its tier 1 is this extractor) and was not in the files list, and the cap-check placement deviates from design §4.7 deliberately.

One hole where a wrong implementation passed everything: a `merge` that iterates roster keys without checking `isCollection` leaks a singleton's stated-none into `statedEmptyGroups`, and no existing assertion would notice.
