# Phased Extraction — Wave 5: port `scopedInstanceExtractor` onto the engine

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `scopedInstanceExtractor` becomes two phases — a house-wide inventory pass, then one scoped fill per `(group, piece, instance)` — keeping every behaviour a host depends on except the changes Task 5 names. This is the port that exercises `notes` (the roster crosses a phase boundary), `statedEmptyGroups` (a first-class draft channel), and multi-granularity work.

**Architecture:** The inventory phase runs one item over the whole document, stores the roster in `notes`, and — because `plan` must stay pure — does **all** roster interpretation in its `merge`: the stated-empty spans, the empty-collection seeds, and the instance-cap check. The fill phase's `plan` then derives the job list from that settled state and does nothing else. Both phases' request assembly and merge logic are today's, moved rather than rewritten.

**Tech Stack:** TypeScript, Vitest. No new dependencies.

**Spec:** `docs/roadmap/design/phased-extraction-design.md` (§4.7)

## Global Constraints

- **`scopedInstanceExtractor`'s signature is unchanged except its observer's unit type.** `ScopedFillOptions` keeps every member with the same meaning, including `inventory`, `instanceCap`, `requireRetryBudget`, `normalize` and the partition cap.
- **The fill item is a `(group, piece, instance)` triple, never a `(group, instance)` slot.** When a group's schema is partitioned for the nullable-union cap, partitioning multiplies fill calls _per instance_, each piece carrying its own narrowed schema and a suffixed request name, and the pieces of one slot recombine with `mergeGroupPieces`. Items at slot granularity would serialise a slot's pieces inside one `run` instead of interleaving them through the pool — a different request sequence and a loss of the concurrency the partitioning exists to exploit.
- **`plan` is pure.** Today's job-derivation loop writes `statedEmptyGroups` and seeds empty collection groups as it goes. Those are state changes and must move to the inventory phase's `merge`; `plan` returns items and nothing else.
- **The inventory is one-shot.** Today it is called once, with no retry, and its failure fails the run. The phase pins `maxRetries: 0`.
- Tests run from the repo root: `pnpm vitest run packages/<dir>/src/<file>.test.ts`.

---

### Task 1: `PhaseUnit` carries piece coordinates

**Files:**

- Modify: `packages/ribo-core/src/extraction-observer.ts` (`PhaseUnit`)
- Modify: `packages/ribo-core/src/phase.ts` (`describeItem`'s return type)
- Modify: `packages/ribo-core/src/phased-extractor.ts` (pass them through to the event)
- Modify: `packages/ribo-core/src/phased-extractor.test.ts`

**Interfaces:**

- Produces: `PhaseUnit` gains optional `instance`, `instances`, `part`, `parts` — all `number | undefined`. `describeItem`'s return type widens from `{ key: string; leaf?: string }` to include the same four, all optional.

**Why.** `InstanceUnit` carries `key`, `instance`, `instances`, `part` and `parts`, and a progress consumer uses them to render "HVAC system 2 of 3, part 1 of 2". `PhaseUnit` carries `key` and `leaf` only, so porting the instance strategy onto the engine would silently drop that detail — the events would still arrive, and would say less. All four members are optional, so this is additive for every existing phase.

- [ ] **Step 1: Write the failing tests**

  A phase whose `describeItem` returns the piece coordinates emits them on its `PhaseUnit`s; a phase whose `describeItem` omits them, or declares none at all, emits events with those members **absent** rather than `undefined` (the same omit-rather-than-claim rule the usage members follow).

- [ ] **Step 2: Run to verify they fail** — Expected: FAIL, the members do not exist.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the core suite** — Expected: PASS, nothing else modified.

- [ ] **Step 5: Commit**

---

### Task 2: The inventory phase

**Files:**

- Create: `packages/ribo-extractor-openai/src/inventory-phase.ts`
- Create: `packages/ribo-extractor-openai/src/inventory-phase.test.ts`

**Interfaces:**

- Produces: `inventoryPhase<V, P>(options): Phase<V, P>` — `inventory` (the caller's roster function), `prepared` (the split groups the fill phase will also use) and `instanceCap`. Produces the note key the fill phase requires.

**`plan`** returns exactly one item — a unit value; the inventory is one call over the whole document. `describeItem` returns `{ key: "" }`.

**`run`** calls `options.inventory(ctx.transcript.text)` and returns the `Roster` as its contribution, reporting `{ calls: 1 }` on `PhaseOutput.usage`. It does **not** wrap the roster function or change its contract: the caller supplies it, and the cost of whatever it does internally never reaches this extractor — which is true today and stays true.

**`merge`** does every piece of roster interpretation, because `plan` must stay pure:

- Store the roster in `notes` under an exported key the fill phase `requires`.
- For each collection group whose roster entry is the `stated: "none"` shape, record its span in `draft.statedEmptyGroups` and seed that group's fields with `[]`.
- For each collection group whose roster entry is an array with no `"current"` candidates, seed `[]`.
- Throw when a group's `"current"` candidate count exceeds `instanceCap`, with today's message naming the group, the count and the cap.

**Why the cap throws here rather than in the fill phase's `plan`.** It is a property of the roster, so it belongs where the roster is interpreted; it fails at the inventory boundary rather than one phase later; and `plan` throwing would be a `plan` that does more than plan.

**`maxRetries` is 0.** The inventory is called exactly once today and its failure fails the run. The engine's default of 2 would re-issue whatever calls the caller's roster function makes, which is both a cost change and a behaviour change in someone else's code.

- [ ] **Step 1: Write the failing tests**

  `plan` returns exactly one item whatever the draft holds; `run` calls the supplied inventory with the transcript text and reports one call; `merge` stores the roster under the note key; `merge` records a `stated: "none"` group's span in `statedEmptyGroups` **and** seeds that group with `[]`; `merge` seeds `[]` for a group whose candidates are all non-current; `merge` throws when a group exceeds `instanceCap`, with the group, count and cap in the message; and a group with current candidates is **not** seeded (the fill phase fills it).

- [ ] **Step 2: Run to verify they fail** — Expected: FAIL, the module does not exist.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run to verify they pass, typecheck**

- [ ] **Step 5: Commit**

---

### Task 3: The fill phase

**Files:**

- Create: `packages/ribo-extractor-openai/src/fill-phase.ts`
- Create: `packages/ribo-extractor-openai/src/fill-phase.test.ts`

**Interfaces:**

- Produces: `fillPhase<V, P>(options): Phase<V, P>` — `target`, `chat`, `model`, `maxTokens`, `prepared`, and the instruction builders. `requires` the inventory's note key.

**`plan`** reads the roster from `notes` and derives the job list exactly as today's loop derives it — **minus** the side effects Task 2 took. One job per `(group, piece, instance)`: for a collection group, one per current candidate per piece; for a singleton or the `""` non-grouped fallback, one per piece at instance 0. Preserve today's two message paths: the `""` group uses `buildMessages(target, …)`, every other uses `buildFillMessages(…)` with the group's scope and leaf keys.

**`describeItem`** returns the job's `key`, `instance`, `instances`, `part` and `parts` — which is what Task 1 widened `PhaseUnit` to carry.

**`run`** makes the one chat call for that job and parses it, as today.

**`merge`** recombines the outcomes into the draft: pieces sharing a `(group, instance)` slot merge with `mergeGroupPieces` — the same recombination the per-group extractor uses — and collection groups assemble into their arrays in instance order. Instance order must not depend on completion order, because items fan out through a pool: index by the job's `instanceIndex`, not by arrival.

- [ ] **Step 1: Write the failing tests**

  `plan` yields one job per current candidate for a collection group, and skips a group the inventory seeded; `plan` yields one job per **piece** when a group is partitioned, all sharing the group and instance, with distinct request names; `plan` yields one job at instance 0 for a singleton group; the `""` group's messages come from `buildMessages`, not `buildFillMessages`; `describeItem` reports the piece coordinates; `merge` recombines two pieces of one slot with `mergeGroupPieces`; and — the one that would not fail by luck — **`merge` places instances in `instanceIndex` order even when their outcomes arrive out of order** (drive it with outcomes deliberately reversed).

- [ ] **Step 2: Run to verify they fail** — Expected: FAIL, the module does not exist.

- [ ] **Step 3: Implement** — import the existing helpers (`buildFillMessages`, `projectFillExample`, the scope builders, `mergeGroupPieces`); export any that are private rather than duplicating them.

- [ ] **Step 4: Run to verify they pass, typecheck**

- [ ] **Step 5: Commit**

---

### Task 4: `scopedInstanceExtractor` becomes the preset

**Files:**

- Modify: `packages/ribo-extractor-openai/src/instance-fill.ts`

**The new body.** Prepare the groups as today, then `phasedExtractor({ target, phases: [inventoryPhase(…), fillPhase(…)], normalize, concurrency, maxRetries, stepTimeoutMs, perCallCeilingMs, delay, requireRetryBudget, onRetryBudget, onUnit })`. Delete the hand-rolled orchestration: the pool, the retry loop, the budget derivation, the abort controller, the event emission, the usage tally. Keep the group preparation, every message builder, every scope builder, and every doc comment explaining _why_.

**`normalize` goes to the engine here, unlike in the gap-fill port.** `ScopedFillOptions.normalize` runs once on the merged result, with no passthrough path to exclude it from — so the engine's run-level option is the right home, and it runs where it runs today.

**`requireRetryBudget` passes straight through.** The engine already implements the two-kinds-of-zero rule: a budget zero against the full step timeout is the configuration error and throws `TerminalQueueError`; a budget zero only against the remaining time runs without retries. Today's single derivation throws on the former, so the configuration-error behaviour is preserved and the transient case is new and better.

- [ ] **Step 1: Rewrite the body, widen the observer's unit type, typecheck, commit**

  Do not run the suite yet — Task 5 is where its failures get classified.

---

### Task 5: Classify and amend every failing test

**Files:**

- Modify: `packages/ribo-extractor-openai/src/instance-fill.test.ts`

**Run the suite and read every failure before changing anything.** Each must fall into one of these categories. **A failure fitting none of them is a real regression — stop and report rather than amending it.**

1. **Events change from `InventoryUnit`/`InstanceUnit` to `PhaseUnit`.** Assertions on `unit: "inventory"` and `unit: "instance"` become assertions on `phaseId` and `pass`. The piece coordinates survive (Task 1), so assertions on `instance`, `instances`, `part` and `parts` should need only their unit discriminator changed — if one needs more, that is a Task 1 or Task 3 bug, not an amendment.
2. **The observer's unit type widened.**
3. **`onRetryBudget` now fires per reduced phase rather than once per run.** The existing assertion that exactly one event arrives must become an assertion about which phases reduced. Note that today's single event is derived from the whole run's job count; the ported equivalent is the fill phase's.
4. **Reference identity is lost.** The closing parse rebuilds every object.
5. **The failing-inventory event count changes.** Today an inventory failure emits exactly two events; under the engine it emits a start and an error for the inventory phase's single item, and the fill phase never runs.

- [ ] **Step 1: Run the suite; write down every failure and its category**

- [ ] **Step 2: Amend, with a comment on each amended assertion naming its category**

- [ ] **Step 3: Add the assertions nothing currently covers**

  That the inventory is attempted exactly **once** when it fails transiently (the regression Task 2's `maxRetries: 0` exists to prevent), and that `statedEmptyGroups` is **absent** from the result rather than `{}` when no group stated one.

- [ ] **Step 4: Run the whole package suite** — Expected: PASS.

- [ ] **Step 5: Commit**

---

### Task 6: Changeset and the full gate

- [ ] **Step 1: Add a changeset**

  `@azx/ribo-extractor-openai` **major**, `@azx/ribo-core` **minor** (Task 1 is additive). Name the host-visible changes: the observer's unit type and event shapes, `onRetryBudget`'s per-phase firing, and lost reference identity. Plus what a consumer gains: the inventory-then-fill strategy is a phase list a host can extend or reorder.

- [ ] **Step 2: Run the full gate** — `./check.sh`, `pnpm docs:build`, `pnpm changeset status --since=origin/main`.

- [ ] **Step 3: Commit**

---

## Out of scope

- Porting `threePhaseExtractor` — Wave 6.
- Removing `InventoryUnit`, `InstanceUnit` or `GapFillUnit` from the `ExtractionUnit` union — Wave 6, once nothing emits any of them.
- Retrofitting `groupedExtractor` onto `retryAsync`.
- The acceptance-gate run — once, after every port has landed.

## Notes for the reviewer

Three things most worth adversarial attention. First, whether moving the roster interpretation out of the job loop into the inventory phase's `merge` actually preserves today's behaviour — the loop interleaves seeding, capping and job-building over the same groups, and splitting it in two is where an ordering dependency would hide. Second, whether the fill phase's `merge` really reconstructs collection arrays in instance order under a pool that completes out of order; today's code builds them inside the same loop that creates the jobs, which makes the ordering implicit. Third, whether anything reads `statedEmptyGroups` or the empty-collection seeds _during_ job derivation, which would make the split incorrect rather than merely rearranged.
