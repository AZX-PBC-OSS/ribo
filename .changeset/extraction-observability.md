---
"@azx/ribo-core": major
"@azx/ribo-extractor-ondevice": major
"@azx/ribo-transcriber-pdfjs": major
---

Extraction observability: one progress hook, every strategy

A full Manual J extraction is 16 model calls and six to ten minutes, and nothing announced a
unit of work finishing — so "working" was indistinguishable from "hung". Every strategy already
divided the work into units; none of them said so.

`ExtractionObserver<U>` is one optional hook, `onUnit`, declared once in `@azx/ribo-core` and
inherited by every extraction strategy's options — the pattern `BackoffOptions` already
establishes. Each unit reports `start` then `done` or `error`, carrying a stable `id`, an
`attempt` (the only way a retry is observable), optional `usage`, and structured identifiers
rather than a display label.

## Which extractor declares which unit set

`U` is the set an extractor can actually emit, so an options type states its own vocabulary
instead of every consumer handling events that will never arrive. **Widening any of these later
is itself a major change.** That exposure is accepted: it is localised to the extractors that
gained an event rather than falling on every consumer that switches on the union.

| Options type                 | Declared set                    |
| ---------------------------- | ------------------------------- |
| `SingleShotOptions`          | `WholeUnit`                     |
| `PerGroupOptions`            | `GroupUnit`                     |
| `ScopedFillOptions`          | `InventoryUnit \| InstanceUnit` |
| `ThreePhaseExtractorOptions` | `PhaseUnit`                     |
| `GapFillOptions`             | `GapFillUnit`                   |
| `InstanceLadderOptions`      | the full `ExtractionUnit` union |

`onUnit` is a parameter position, so the narrowing costs a consumer nothing: one broadly-typed
handler is assignable to every site. A handler _narrower_ than the site it is passed to is
correctly rejected. Both directions are pinned by type-level tests.

`gapFillExtractor` and its `GapFillUnit` are a sixth strategy the original request did not
list, and `InstanceUnit` carries `part`/`parts` because tier 1 partitions too.

## Breaking changes

**`RelayOptions.onError` takes a tagged subject.** Its second parameter changes from
`OutboxItem | SessionItem` to the new `RelaySubject`:

```ts
onError?: (error: unknown, subject: RelaySubject) => void;

type RelaySubject =
  | { readonly kind: "recording"; readonly item: OutboxItem }
  | { readonly kind: "session"; readonly session: SessionItem };
```

An error handler could not previously tell a recording from a session without structurally
probing for a field like `audioReady`. The relay now builds the discriminant at the callback
boundary, where the two are already distinguishable. **No persisted schema changes** — no RxDB
version bump and no migration. Migrate by switching on `subject.kind` and reading
`subject.item` or `subject.session`.

**`ExtractionOutcome<F>` carries an `outcome` tag.** Both arms gain a required
`outcome: "result" | "error"` discriminant, so `ResultOutcome`/`ErrorOutcome` derive from the
tag rather than from hand-written `Extract<>` on a property name. The `result?: never` /
`error?: never` members stay as belt-and-braces. Code that builds outcomes through
`resultOutcome()` / `errorOutcome()` — the documented path — is unaffected; inline object
literals must add the tag. `ArbiterVerdict` is deliberately **not** tagged: its three arms
already carry distinct required key names and narrow correctly under `in`.

## Also in this release

- **`onRetryBudget` and `requireRetryBudget`** on `PerGroupOptions` and `ScopedFillOptions`.
  `deriveMaxRetries` silently floored the retry budget to zero when the worst case did not fit
  `stepTimeoutMs` — and at 16 calls with concurrency 2 the defaults genuinely derive to zero, so
  asking for `maxRetries: 5` and getting none was indistinguishable from needing none. The hook
  now fires whenever the budget is reduced. `requireRetryBudget` (default `false`, so no
  behaviour changes) turns a derived-to-zero budget into a throw: at construction for
  `perGroupExtractor`, and as a `TerminalQueueError` from `extract()` for
  `scopedInstanceExtractor`, which cannot derive until its roster is back.

- **The derivation is now one function in `@azx/ribo-core`** — `deriveRetryBudget`, returning a
  `RetryBudget` rather than a bare number, so the value governing the run and the value reported
  to a consumer cannot disagree. It previously existed as two byte-identical copies in
  `per-group.ts` and `instance-fill.ts`. Not previously exported from
  `@azx/ribo-extractor-openai`, so no published name changed.

- **`onPage` on `@azx/ribo-transcriber-pdfjs`.** `readText()`'s per-page sweep now reports
  `{ page, of, chars }`. `chars` excludes the library's own page marker, so a scanned insert in
  an otherwise text-layer PDF shows up as a run of zero-character pages — visible before the
  whole-document `no-text-layer` threshold decides. `@azx/ribo-transcriber-managed-docs` has no
  parallel hook: it is one call returning every page at once.

- **`threePhaseExtractor`'s internal call counter is retired.** `usage.calls` now derives from
  the observer rather than sitting beside it, and every swallowed phase failure — previously
  invisible, since the extractor fills nulls and continues — emits an `error` event without
  becoming fatal.

## Stage changes are still the queue's job

`onUnit` is progress _within_ a stage and deliberately does not persist. The stage itself is
`OutboxItem.status` / `SessionItem.status`, and there is no second mechanism — see
`docs/roadmap/design/extraction-observability-design.md`. A ten-minute extraction that dies on
a page refresh is a durability problem, which is exactly what an in-memory stage signal cannot
solve.
