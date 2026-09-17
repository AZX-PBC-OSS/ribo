# SP2 — Wave 1: the leaf walk moves to core, and the granularity guard both judging combinators need

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The two pieces every later SP2 wave depends on: the runtime walk over enveloped data, moved out of `gapFillExtractor` into core where a core combinator can reach it; and the construction-time guard that refuses a target whose groups are not `"leaf"` granularity. No combinator is built in this wave.

**Architecture:** A move and a small pure module. The walk is lifted verbatim — it has one behaviour, structure-preserving identity, that a later merge depends on and that is easy to lose in a rewrite. The guard is new, and reuses the `isExtractedSchema` predicate core already exports rather than re-deriving what an envelope looks like.

**Tech Stack:** TypeScript, Vitest. No new dependencies.

**Spec:** `docs/roadmap/design/sp2-judging-combinators-design.md` (§4.5, §4.6)

## Global Constraints

- **The walk is moved, not rewritten.** Its identity-preservation — a subtree keeps its reference when nothing under it changed — is what lets `gapFillExtractor`'s merge leave untouched leaves reference-equal to the base, and that is pinned by existing tests. A rewrite that returns fresh objects everywhere passes a naive test and breaks the property.
- **`gap-fill.ts`'s existing suite passes unmodified.** That is the gate on the move. If an assertion needs changing, stop and report: it means the move changed behaviour.
- **No combinator is built here.** No `consensus`, no `validate`, no `budget`, no `cached`. This wave is their shared foundation and nothing else.
- `ribo-core` must not import from any `ribo-extractor-*` package.
- Tests run from the repo root: `pnpm vitest run packages/<dir>/src/<file>.test.ts`.

---

### Task 1: Move the walk into core

**Files:**

- Create: `packages/ribo-core/src/extracted-leaves.ts` and its test
- Modify: `packages/ribo-extractor-openai/src/gap-fill.ts` (delete the private copies, import instead)
- Modify: `packages/ribo-core/src/index.ts`, `packages/ribo-core/src/index.test.ts`

**Interfaces:**

- Produces: `LeafPath` — `readonly (string | number)[]`. `isExtractedLeaf(node: unknown): node is Extracted<unknown>`. `mapExtractedLeaves(node, path, fn)` — the structure-preserving map.

**What moves, verbatim.** `gap-fill.ts` currently holds `isExtractedLeaf`, the `LeafPath` type and `mapLeaves` as module-private declarations. All three move to the new core module. `mapLeaves` is renamed `mapExtractedLeaves` on the way out — `mapLeaves` is too generic a name for a core barrel that already exports `isExtractedLeaf` and `isExtractedSchema`, and the new name joins that family.

**The property that must survive the move.** The walk returns the _same object_ for a subtree where `fn` changed nothing, and a fresh object only along the path that changed. `gapFillExtractor`'s merge relies on it so untouched leaves stay reference-equal to the base extractor's, and its suite asserts that with `toBe`. Keep the `changed` flag logic exactly as written; do not "simplify" to always rebuilding.

**Note for the mover.** `isExtractedLeaf`'s comment explains that the load-bearing check is `confidence` being a **number** — a group's members are themselves envelopes or groups, never bare numbers. Move that comment with it; it is the reason the predicate is shaped the way it is, and it is what makes the walk safe on a `"row"` group's plain leaves (it passes them through rather than mistaking them for envelopes).

- [ ] **Step 1: Write the core module's failing tests**

  Against hand-built enveloped data — a flat group of envelopes and a collection group that is an array of them: `mapExtractedLeaves` visits every leaf with its structured path (`["hvac", 0, "fuel"]`, not a string); a visitor returning every leaf unchanged returns the **same root object** by identity; a visitor changing one leaf returns a fresh root, a fresh containing group, and the **untouched sibling leaves by identity**; `isExtractedLeaf` accepts an envelope and rejects a group, an array, `null`, a string, and a `"row"`-shaped object (plain values plus a row-level `sourceSpan` but no `confidence`).

- [ ] **Step 2: Run to verify they fail** — Expected: FAIL, the module does not exist.

- [ ] **Step 3: Move the three declarations**

  Cut from `gap-fill.ts`, paste into the new module with their comments, rename `mapLeaves`, and have `gap-fill.ts` import all three. Delete nothing else from `gap-fill.ts`.

- [ ] **Step 4: Run to verify they pass, and run the gap-fill suite unmodified**

  Run `pnpm vitest run packages/ribo-core/src/extracted-leaves.test.ts`, then
  `pnpm vitest run packages/ribo-extractor-openai/src/gap-fill.test.ts`. Expected: both PASS, with no
  change to `gap-fill.test.ts`. **If a gap-fill assertion fails, stop and report** — the move changed
  behaviour, which it must not.

- [ ] **Step 5: Export from the barrel and the manifest, typecheck**

- [ ] **Step 6: Commit**

---

### Task 2: The `"leaf"`-granularity guard

**Files:**

- Create: `packages/ribo-core/src/assert-leaf-granularity.ts` and its test
- Modify: `packages/ribo-core/src/index.ts`, `packages/ribo-core/src/index.test.ts`

**Interfaces:**

- Produces: `assertLeafGranularity(schema: z.ZodType, options: { combinator: string }): void` — returns nothing on a fully `"leaf"`-granularity schema, throws otherwise.

**Why this exists.** `consensusExtractor` and `validateExtractor` both work by walking per-leaf provenance envelopes. A `"row"` group has none — it is plain nullable values plus one row-level span — and a `"none"` group has none either. The walk from Task 1 passes both straight through, so a combinator running against such a target would **compare nothing and count nothing** while returning a result that looks judged. That is the worst available outcome, because row provenance exists precisely because per-cell citations were measured 37% fabricated: the combinators would be silently blind where hallucination is worst.

So a host with such a target learns at construction, before any call is made — the same refusal `threePhaseExtractor` already makes for the same reason.

**How to detect it.** Core already exports `isExtractedSchema`, which answers "is this zod type the three-key envelope" — reuse it rather than re-deriving what an envelope looks like. For each top-level group of the extraction schema: unwrap a `z.ZodArray` (a collection group is an array of row objects) and any optional/nullable wrapper, then check every property of the resulting object. A group is `"leaf"` granularity when **every** property is an `isExtractedSchema`; it is not when any property is a plain value.

**Distinguish the two failures in the message, because the fix differs.** A group carrying a row-level `sourceSpan` key alongside plain leaves was derived at `"row"`; one with plain leaves and no such key was derived at `"none"`. `ROW_SOURCE_SPAN_KEY` is exported from `enveloped.ts` — use it rather than the literal. The message names the combinator, the group, which granularity it appears to be, and that the combinator needs per-leaf envelopes. Follow the tone of `three-phase-extractor.ts`'s refusal, which is the closest precedent.

**One thing to get right rather than assume:** a group whose properties are themselves nested groups (not leaves) is not automatically a failure. Check what `enveloped()` actually produces for a nested group before deciding — if nesting is possible at `"leaf"` granularity, the check must recurse rather than reject. Read `enveloped.ts` and say in the commit message which it is.

- [ ] **Step 1: Write the failing tests**

  Build schemas with `enveloped()` rather than by hand, so the fixtures are what the library really produces: an all-`"leaf"` schema passes; a schema with one `"row"` group throws, naming the combinator and that group; a `"none"` group throws, naming it; a schema mixing a `"leaf"` group and a `"row"` group throws naming **only** the offending one; a collection group (array of envelopes) at `"leaf"` granularity passes, which is the case an array-unwrap bug would break.

  Assert on the message content, not just that it throws: a guard whose message does not identify the group is half a guard, and the host reading it has to find the group themselves.

- [ ] **Step 2: Run to verify they fail** — Expected: FAIL, the module does not exist.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run to verify they pass, export, typecheck**

- [ ] **Step 5: Commit**

---

### Task 3: Changeset and the full gate

- [ ] **Step 1: Add a changeset**

  `@azx/ribo-core` **minor** — three new exports plus the guard. `@azx/ribo-extractor-openai` **patch**: its behaviour is unchanged, but it now imports the walk rather than defining it.

  The summary should say what a consumer gains: the runtime walk over enveloped data is public, so a host writing their own combinator over extraction results does not have to rewrite it — and there is a guard for the combinators that can only serve per-leaf provenance.

- [ ] **Step 2: Run the full gate** — `./check.sh`, then `pnpm docs:build` and `pnpm changeset status --since=origin/main`. Expected: PASS.

  Bare `pnpm changeset status` fails on a pre-existing unrelated changeset; if `--since=origin/main` also fails, verify the same failure at this wave's base commit before treating it as yours.

- [ ] **Step 3: Commit**

---

## Out of scope

- Every combinator: `consensus`, `validate`, `budget`, `cached`. Later waves.
- Extending the walk to carry the schema so row spans can be judged. The design names it as the right end state and deliberately not this sub-project.
- Changing anything about how `gapFillExtractor` behaves.

## Notes for the reviewer

Two things most worth adversarial attention. First, whether the move genuinely preserves the walk's identity semantics — the gap-fill suite is the gate, so the question is whether that suite actually pins the property or merely happens to pass. Second, the guard's schema walk: whether unwrapping arrays and optional/nullable wrappers is sufficient for what `enveloped()` really produces, and whether a nested group at `"leaf"` granularity exists and would be wrongly rejected.
