# SP2 — Wave 3: `budgetExtractor` and `cachedExtractor`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The two small independent combinators. `budgetExtractor` detects a run that spent more than a ceiling; `cachedExtractor` memoises a result by transcript and target. Neither is coupled to the other.

**Architecture:** Two thin wrappers over the `Extractor` seam. Each carries one decision worth stating outright in its doc comment rather than leaving a host to discover it: `budget` reports a spend it cannot prevent and is only honest around a single strategy, and `cached`'s key must cover the whole prompt or it serves one target's result for another.

**Tech Stack:** TypeScript, Vitest. No new dependencies.

**Spec:** `docs/roadmap/design/sp2-judging-combinators-design.md` (§4.3, §4.4)

## Global Constraints

- **Neither emits a progress unit.** Wave 2 settled the rule: a wrapper that delegates and judges makes no model call of its own, so it has nothing to report — and reusing an existing unit type makes a consumer double-count. Neither options bag carries an observer, and a test pins that with `@ts-expect-error`.
- **Both rejections are terminal.** `ValidationRejectedError` is a `TerminalError` so `terminalFallsThrough` continues to the next rung; the same reasoning applies here. An overspend is a property of the strategy — retrying it overspends again — and falling through to a cheaper rung is the entire story. A transient classification would instead make the ladder give up and the relay re-run the expensive rung.
- **No cache write on failure, ever.** A cached rejection turns one bad minute into a permanent one.
- `ribo-core` must not import from any `ribo-extractor-*` package.
- Tests run from the repo root: `pnpm vitest run packages/<dir>/src/<file>.test.ts`.

---

### Task 1: `budgetExtractor`

**Files:**

- Create: `packages/ribo-core/src/budget-extractor.ts` and its test
- Modify: `packages/ribo-core/src/index.ts`, `packages/ribo-core/src/index.test.ts`

**Interfaces:**

- Produces: `BudgetExtractorOptions` — `maxCalls?`, `maxPromptTokens?`, `maxCompletionTokens?`, `maxTotalTokens?`. `BudgetExceededError extends TerminalError`, carrying the ceiling that was breached, the observed value and which member it was. `budgetExtractor<F>(extractor, options): Extractor<F>`.

**Two honesty requirements, both of which belong in the file header where a reader meets them first.**

**It detects; it cannot prevent.** A wrapper sees only what an `Extractor` returns, so by the time it reads `usage` the calls have been made and paid for. What it buys is the _next_ run: a ladder falls through to a cheaper strategy, and a host learns a strategy's cost profile moved. Real prevention needs a meter on `ExtractOptions` that every implementation honours — the design names it and declines to build it, because it is an advisory contract nothing enforces and its value is highest exactly where it is least verifiable. Say which of the two this is, plainly, so nobody ships a cost guarantee on top of a detector.

**It is honest around one strategy and misleading around a ladder.** An error outcome carries no usage and an arbitration engine returns only the accepted candidate's result — so wrapped around a `fallbackExtractor`, this sees the winning rung's usage and none of the rejected candidates' calls. The ceiling then under-counts precisely when strategies are being skipped for cost, which is when a host most wants it. The wrapper belongs _inside_ a ladder, around each rung, not around the ladder.

**`maxCalls` is the member that works everywhere.** `calls` is `ExtractionUsage`'s only required member. The on-device phases report no tokens, and several paths report `{ calls: 1 }` and nothing else — so a token ceiling on such a strategy is vacuous, not strict. Say that in the option's own doc comment rather than letting it be discovered.

**A ceiling of zero is a ceiling.** `maxCalls: 0` means no calls are permitted and any result breaches it. Do not treat a falsy ceiling as absent; use `!== undefined`.

- [ ] **Step 1: Write the failing tests**

  With `FakeExtractor` carrying a constructed `usage`: a result under every ceiling is returned **by identity**; a result exceeding `maxCalls` throws `BudgetExceededError` naming the member, the ceiling and the observed value; the same for each token ceiling; a result whose usage omits the token members does **not** throw under a token ceiling (the vacuous case — pin it so the behaviour is deliberate rather than incidental); `maxCalls: 0` throws for a result reporting one call; **the inner extractor ran** before the throw, which is the pin on detect-not-prevent; the caller's `signal` and `deadline` are forwarded; a rejecting inner error propagates by identity.

  And the ladder behaviour, since it is the point: a `fallbackExtractor` with `terminalFallsThrough` whose first rung is a budget-wrapped over-spender reaches its second rung.

  Type-level: passing `onUnit` is a compile error (`@ts-expect-error`).

- [ ] **Step 2: Run to verify they fail** — Expected: FAIL, the module does not exist.

- [ ] **Step 3: Implement** — [ ] **Step 4: Run, export, typecheck** — [ ] **Step 5: Commit**

---

### Task 2: `cachedExtractor`

**Files:**

- Create: `packages/ribo-core/src/cached-extractor.ts` and its test
- Modify: `packages/ribo-core/src/index.ts`, `packages/ribo-core/src/index.test.ts`

**Interfaces:**

- Produces: `ExtractionCache` — `{ get(key: string): Promise<ExtractionResult<unknown> | undefined>; set(key: string, result: ExtractionResult<unknown>): Promise<void> }`. `cachedExtractor<F>(extractor, options): Extractor<F>` with `target`, an optional `cache` and an optional `keyFor`.

**The key covers the whole prompt, not just the schema.** `ExtractionTarget` is `{ name, extractionSchema, instructions, examples }`, and **instructions and examples _are_ the prompt** — two targets identical in name and schema but differing in examples produce different output. A key omitting them serves one's result for the other: the same silent-wrong-data failure the key exists to prevent, introduced by the key itself.

So the default key is a digest over: the transcript text, `target.name`, `target.instructions`, a stable serialisation of `target.examples`, and a stable serialisation of `z.toJSONSchema(target.extractionSchema, { target: "draft-2020-12" })` — the serialisation this repo already uses to send a schema to a model.

**Stable means key-sorted, not `JSON.stringify` as it comes.** Two structurally identical objects with different key insertion order must produce the same key, or the cache misses at random and the bug looks like a performance problem rather than a correctness one. Write the sorted-key serialiser, or state why the inputs are already order-stable.

**The digest is `crypto.subtle`, which is async, and core is browser-side.** The Node `crypto` used in the acceptance harness is not available here. `crypto.subtle.digest` returns a promise, so key computation is async and `extract` awaits it — that is fine, since `extract` is already async. Verify `crypto.subtle` is reachable in this repo's Vitest node environment before relying on it in a test; if it is not, say so rather than working around it silently.

**`keyFor` is injectable** so a host with a cheaper identity (a content hash it already has) is not forced through the digest. The default is the above.

**Failures are never cached**, and a cache read that throws must not fail the extraction — a broken cache degrades to a miss. A cache that can take down extraction is worse than no cache.

**The store is injected, in-memory `Map` by default.** `PluginStorage` looks like the obvious backing and is the wrong lifetime — its scope is documented as entries dying with the capture, so it cannot serve the re-run-the-same-transcript case a cache exists for. Note that in the doc comment so the next person does not reach for it.

- [ ] **Step 1: Write the failing tests**

  With `FakeExtractor` and an in-memory cache: a second identical call returns the cached result **without invoking the inner extractor** (assert the inner's call count stays 1); a changed transcript misses; **a changed `instructions` misses**; **a changed `examples` misses**; a changed `extractionSchema` misses; a target differing only in `name` misses; a rejecting inner call is **not** cached, so the next call retries and the inner runs twice; a cache whose `get` throws degrades to a miss rather than failing the extraction; a custom `keyFor` is used instead of the default; the caller's `signal` and `deadline` are forwarded.

  And the one that catches a whole class of bug: **two structurally identical targets whose object keys were built in different order produce the same key** — a hit, not a miss.

  Type-level: passing `onUnit` is a compile error.

- [ ] **Step 2: Run to verify they fail** — Expected: FAIL, the module does not exist.

- [ ] **Step 3: Implement** — [ ] **Step 4: Run, export, typecheck** — [ ] **Step 5: Commit**

---

### Task 3: Changeset and the full gate

- [ ] **Step 1: Add a changeset, committed before running status**

  `@azx/ribo-core` **minor**. `changeset status` computes changed changesets through `git diff` and cannot see an uncommitted file.

  The summary says what a consumer gains, and what each does not do: a spend ceiling that reports rather than prevents, and belongs around one strategy rather than a ladder; and a memoisation whose key covers the whole prompt so a changed example is a miss.

- [ ] **Step 2: Run the full gate** — `./check.sh`, `pnpm docs:build`, `pnpm changeset status --since=origin/main`.

- [ ] **Step 3: Commit**

---

## Out of scope

- `consensusExtractor` — the next wave.
- A meter on `ExtractOptions`. The design names it as the real governor and declines to build it without a caller.
- Any cache persistence beyond the injected interface. No `PluginStorage` backing, no IndexedDB.
- Guide updates — the last SP2 wave.

## Notes for the reviewer

Two things most worth adversarial attention. First, whether the cache key's default really is stable — `z.toJSONSchema`'s output ordering, and whether `examples` can contain anything a sorted-key serialiser mishandles. Second, `budget`'s vacuous-token-ceiling case: whether returning a result rather than throwing is the right call when a host set a token ceiling the strategy cannot report against, or whether that silence is itself the trap.
