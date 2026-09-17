# SP2 — Wave 1: the leaf walk moves to core, and the granularity guard both judging combinators need

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The two pieces every later SP2 wave depends on: the runtime walk over enveloped data, moved out of `gapFillExtractor` into core where a core combinator can reach it; and the construction-time guard that refuses a target whose groups are not `"leaf"` granularity. No combinator is built in this wave.

**Architecture:** A move and a small pure module. The walk is lifted verbatim — it has one behaviour, structure-preserving identity, that a later merge depends on and that is easy to lose in a rewrite. The guard is new, and reuses the `isExtractedSchema` predicate core already exports rather than re-deriving what an envelope looks like.

**Tech Stack:** TypeScript, Vitest. No new dependencies.

**Spec:** `docs/roadmap/design/sp2-judging-combinators-design.md` (§4.5, §4.6)

## Global Constraints

- **The walk is moved, not rewritten.** Its identity-preservation — a subtree keeps its reference when nothing under it changed — is what lets `gapFillExtractor`'s merge leave untouched leaves reference-equal to the base. A rewrite that returns fresh objects everywhere passes a naive test and breaks the property.

  The gate is real, and it is narrower than it looks: the `toBe` assertions live in gap-fill's
  **pure-helper** tests, not its extractor-level ones, which assert `toEqual` because the engine's
  closing parse rebuilds every object anyway. So it is those helper tests the move must keep green,
  and Task 1's own new tests pin the same property on the walk directly. Either alone would be thin;
  together they are sufficient.

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

**How to detect it — and it must be a recursive predicate, not an unwrap-then-check.** Core already
exports `isExtractedSchema`, which answers "is this zod type the three-key envelope" — reuse it rather
than re-deriving what an envelope looks like. The predicate is:

- `isExtractedSchema` → **leaf**, short-circuit. This case must come first.
- a `z.ZodArray` → recurse into its element.
- an optional/nullable wrapper → recurse into its inner type.
- a `z.ZodObject` → recurse into every property; leaf only if all of them are.
- anything else (a bare nullable primitive) → **not** leaf granularity.

**A one-level "unwrap the array, then check the object's properties" version is wrong**, and wrong in
a way the reference adapter would never reveal. `enveloped()` derives `z.array(z.string())` to an
array of **envelopes**, not an array of objects — so after unwrapping the array the check is holding
an envelope, whose own properties (`value`, `confidence`, `sourceSpan`) are not envelopes, so a
legitimate `"leaf"` group is rejected. Worse, since that envelope carries a `sourceSpan` key, the
discrimination below would misreport it as `"row"`. The same failure hits an array nested inside a
group and a top-level bare leaf. None of these shapes occur in the Snugg Pro adapter, so a
one-level implementation passes the reference composition and fails for every other host — which is
precisely who a core export exists to serve.

**Nesting at `"leaf"` granularity does exist**, which settles the question an earlier draft deferred:
`enveloped()` recurses a nested `z.ZodObject` at the group's granularity, and its own rationale is
that a matrix of named tests must stay independently-reviewable envelopes. So the check recurses; it
does not reject a group whose properties are themselves groups.

**Distinguish the two failures in the message, because the fix differs.** A row unit carrying a
row-level `sourceSpan` key alongside plain leaves was derived at `"row"`; one with plain leaves and
no such key was derived at `"none"`. `ROW_SOURCE_SPAN_KEY` is exported from `enveloped.ts` — use it
rather than the literal.

**Run the discrimination on the row unit only** — the top-level group object, or the unwrapped
element of a collection group — never on a nested object the recursion reached. A nested object
inside a `"row"` group gets plain leaves and **no** `sourceSpan` key of its own, so a recursive
implementation that discriminates wherever it happens to fail would report that subtree as `"none"`
when the group is `"row"`. Granularity is a property of the group; the recursion only answers
whether a leaf envelope was found.

The message names the combinator, the group, which granularity it appears to be, and that the
combinator needs per-leaf envelopes. Follow the tone of the on-device presence phase's refusal, the
closest precedent.

- [ ] **Step 1: Write the failing tests**

  Build every fixture with `enveloped()` rather than by hand, so they are what the library really
  produces rather than what someone believes it produces.

  The passing cases, each of which a one-level implementation gets wrong — **name both array shapes
  separately, because they diverge exactly on the bug above**:

  - an all-`"leaf"` schema of flat groups;
  - a collection group derived from an array of **objects** (the `hvac` shape) — passes even a
    one-level implementation, so it is not sufficient on its own;
  - a group derived from an array of **primitives** (`z.array(z.string())`), which `enveloped()`
    turns into an array of envelopes — this is the fixture that fails a one-level implementation;
  - a group containing a **nested object** of envelopes, which pins that the check recurses rather
    than rejecting;
  - a **top-level bare leaf** (`{ notes: z.string().optional() }`).

  The failing cases: a `"row"` group throws naming the combinator and that group; a `"none"` group
  throws naming it; a schema mixing a `"leaf"` group with a `"row"` group throws naming **only** the
  offending one; and a `"row"` group containing a nested object is reported as `"row"`, **not** as
  `"none"` — the pin that discrimination runs on the row unit rather than wherever the recursion
  stopped.

  Assert on the message content, not just that it throws: a guard whose message does not identify the
  group is half a guard, and the host reading it has to find the group themselves.

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

## Reviewed

Reviewed by OpenCode (`glm-5p3-flash`, run 9b82) before implementation. All findings applied.

The guard's algorithm was wrong. "Unwrap the array, then check the object's properties" rejects
legitimate `"leaf"` schemas — `enveloped()` derives `z.array(z.string())` to an array of _envelopes_,
so the unwrap lands on an envelope whose own properties are not envelopes, and the group is judged
non-leaf and then misreported as `"row"` because the envelope carries a `sourceSpan` key. An array
nested in a group and a top-level bare leaf fail the same way. It is now a recursive predicate.

The reason that would have shipped is worth recording: **none of those shapes occur in the Snugg Pro
adapter**, so a one-level implementation passes the reference composition and fails for every other
host — which is exactly who a core export serves. The gap-fill suite proves the array-of-envelopes
shape is real.

The question this plan deferred has a definite answer: nesting at `"leaf"` granularity exists, so the
check recurses rather than rejects — and none of the originally-listed fixtures would have caught a
non-recursive implementation. The fixture list now names both array shapes separately, because they
diverge exactly on the bug, plus the nested-object and bare-leaf cases.

One hazard the recursion creates that the first draft could not have: a nested object inside a
`"row"` group has plain leaves and no `sourceSpan` key of its own, so a guard that discriminates
wherever the recursion failed would call that subtree `"none"` when the group is `"row"`.
Discrimination now runs on the row unit only, with a test pinning it.

The identity gate was verified genuine, with a precision the plan now carries: gap-fill's `toBe`
assertions are in its **pure-helper** tests, not its extractor-level ones, which use `toEqual`
because the engine's closing parse rebuilds everything. The gate rests on the helper tests, and
together with Task 1's own new tests the coverage is sufficient. The move itself is clean — the three
declarations have no callers outside `gap-fill.ts`.
