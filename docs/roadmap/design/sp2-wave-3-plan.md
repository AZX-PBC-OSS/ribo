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

**`maxTotalTokens` has no member to read, so define what it sums.** `ExtractionUsage` carries
`promptTokens`, `completionTokens`, `cachedPromptTokens` and `cacheCreationPromptTokens` — and no
total. The total is `promptTokens + completionTokens`, treating an absent member as zero, and is
checked only when **at least one** of the two was reported; if neither was, the vacuous rule below
applies to the total as well. Do not sum all four: the cache members describe where the prompt
tokens came from, so adding them double-counts the prompt.

**`BudgetExceededError` needs the `override readonly name: string` widening** its base declares for
exactly this reason — the pattern is adjacent in `validate-extractor.ts`.

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

**Stable means object keys sort; array elements do not.** Two structurally identical objects with
different key insertion order must produce the same key, or the cache misses at random and the bug
presents as a performance problem rather than a correctness one.

But **array order is meaningful and must be preserved**. `examples` is an array, and the message
builder iterates it in order — few-shot ordering is part of the prompt. A serialiser that "stabilises"
arrays too would make two targets differing only in example order collide, serving one's result for
the other: the precise silent-wrong-data failure this key exists to prevent, reintroduced by the
thing meant to prevent it. Sort object keys, recurse into array elements positionally.

**The digest is `crypto.subtle`, which is async, and core is browser-side.** The Node `crypto` used in the acceptance harness is not available here. `crypto.subtle.digest` returns a promise, so key computation is async and `extract` awaits it — that is fine, since `extract` is already async. Verify `crypto.subtle` is reachable in this repo's Vitest node environment before relying on it in a test; if it is not, say so rather than working around it silently.

**`keyFor` is injectable** so a host with a cheaper identity (a content hash it already has) is not forced through the digest. The default is the above.

**Failures are never cached**, and **neither a read nor a write may fail the extraction**. A read that
throws degrades to a miss. A write that throws — a quota, a structured-clone failure — is swallowed
after the result is already in hand: failing there would discard a result the inner extractor has
already been paid for, which is the same principle the read rule states and the case an earlier draft
of this plan left out. A cache that can take down extraction is worse than no cache.

**A hit reports `calls: 0`.** The stored result's usage describes the run that produced it, and this
run made no model calls — `ExtractionUsage.calls` is documented as calls made, so returning the
stored count books a spend that did not happen. It matters beyond tidiness: that usage is exactly
what `budgetExtractor` reads and what `toSessionExtractStep` forwards to the session, so an unrewritten
hit makes a ceiling fire on a free run and makes composition order (`budget(cached(x))` versus
`cached(budget(x))`) change what a host is told. `engine` and `strategy` survive the rewrite — they
describe what produced the fields, which is still true — and the token members are dropped with the
count.

**The default key carries a `v1:` prefix.** The in-memory default dies with the process, but the
injected store may be persistent, and a later change to the serialisation or the digest would then
serve keys computed under the old recipe. One line of insurance against a class of bug that is
invisible when it happens.

**The store is injected, in-memory `Map` by default.** `PluginStorage` looks like the obvious backing and is the wrong lifetime — its scope is documented as entries dying with the capture, so it cannot serve the re-run-the-same-transcript case a cache exists for. Note that in the doc comment so the next person does not reach for it.

- [ ] **Step 1: Write the failing tests**

  With `FakeExtractor` and an in-memory cache: a second identical call returns the cached result
  **without invoking the inner extractor** (assert the inner's call count stays 1); a changed
  transcript misses; **a changed `instructions` misses**; **a changed `examples` misses**; **two
  targets differing only in the ORDER of `examples` miss each other**, which is the array-order pin;
  a changed `extractionSchema` misses; a target differing only in `name` misses; a rejecting inner
  call is **not** cached, so the next call retries and the inner runs twice; a cache whose `get`
  throws degrades to a miss; **a cache whose `set` throws still returns the result**; a custom
  `keyFor` is used instead of the default; the caller's `signal` and `deadline` are forwarded.

  **A hit reports `calls: 0`** while keeping the stored `engine` and `strategy`, and carries no token
  members.

  **The key is derived from `transcript.text` and nothing else on the transcript.** Same text,
  different `annotations` — which carry per-capture ids and sequence numbers that vary between
  captures — must be a **hit**. Digesting the whole transcript object is the naive mistake and it
  silently kills the cache for re-dictated text, in a way no other test here would notice.

  And the one that catches a whole class of bug: **two structurally identical targets whose object
  keys were built in different order produce the same key** — a hit, not a miss. Nest the differing
  insertion order **inside** an example's envelope objects, not merely at the target's top level: a
  serialiser that sorts one level deep passes a flat version of this test while leaving the bug.

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

## Reviewed

Reviewed by OpenCode (`glm-5p3-flash`, run 698e) before implementation. All findings applied, and it
answered every question the plan asked it to resolve rather than deferring them.

Confirmed buildable as written: `crypto.subtle.digest` resolves in the `unit` vitest project's node
environment on this repo's Node floor — it ran it rather than reasoning about it; `z.toJSONSchema` is
callable from core, since zod is a runtime dependency there, and its output is deterministic for a
given schema; the terminal classification traces through `terminalFallsThrough` to the next rung
exactly as validation's does; and the key-order test genuinely bites, since an as-is `JSON.stringify`
digest makes the second call miss and the inner run twice.

It also ruled on the vacuous token ceiling in favour of the plan: throwing on absent token members
would break real runs, because single-shot omits them when an endpoint does not report usage and
`ExtractionUsage` documents absent as "not reported" rather than zero.

Four things the plan had wrong or missing. **The sorted-key serialiser must preserve array order** —
`examples` is an array and few-shot order is part of the prompt, so a serialiser that "stabilises"
arrays too would make two targets differing only in example order collide: the exact failure the key
exists to prevent, reintroduced by the fix. **A cache `set` that throws would have failed the
extraction** on a result the inner extractor had already been paid for — the plan stated that
principle for reads in the same sentence and then omitted writes. **A cache hit returned the stored
usage**, booking a spend that did not happen, which is what `budgetExtractor` reads and what reaches
the session — so a hit now reports `calls: 0`. And **`maxTotalTokens` had no member to sum**;
summing all four would double-count the prompt, since the cache members describe where prompt tokens
came from.

Two smaller ones: no test pinned that the key reads `transcript.text` and nothing else — digesting
the whole transcript object silently kills the cache for re-dictated text, because annotations carry
per-capture ids that vary — and the default key now carries a `v1:` prefix, since the injected store
may be persistent and a later recipe change would otherwise serve keys computed under the old one.
