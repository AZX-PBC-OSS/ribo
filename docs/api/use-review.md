# useReview

`useReview` is field-by-field review of one parked session as React state: it builds the
[`ReviewRequest`](/api/review) from the session's extraction and its recordings' joined
transcripts, hands back per-leaf decisions, and submits through storage. It takes the adapter's
**patch schema as an argument** — never a `ToolAdapter` — which is what keeps this hook layer
free of any tool-specific import.

## When to reach for it

Reach for it in a React host rendering the review card. Reach for the [Review](/api/review) page
for the contract underneath — completeness, per-leaf validation, link targets — and the
[React Hooks guide](/guide/react) for where the card sits in the wiring.

## Usage

Type-checked only — calling the hook needs React's renderer and browser globals, so this example
is compiled but never executed; its runtime behaviour is covered by the package's browser tests
and the e2e suite.

<<< @/api/examples/use-review.tsx#usage

## Options

`useReview(session, options)` takes `UseReviewOptions<T>`, where `T` is the adapter's patch
schema's zod type.

| Name               | Type                                                        | Default        | What it does                                                                                                                                                                                                               |
| ------------------ | ----------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `valuesSchema`     | `T` (a `z.ZodObject`)                                       | **required**   | The adapter's patch schema — what decides which leaves exist and what a legal value is. **Hold it still**: it is a `useMemo` dependency, and an inline `z.object` rebuilds every field every render, dropping input focus. |
| `requiredOnCreate` | `RequiredOnCreate<z.infer<T>>`                              | —              | Leaves the host tool refuses to create a record without; passed straight through to `buildReviewRequest`. Hosts pass `adapter.requiredOnCreate`.                                                                           |
| `existingRecords`  | `Readonly<Record<string, readonly ExistingRecord[]>>`       | —              | Records of each collection group, surfaced for a human to link against. They never enter extraction; absent groups mean no existing records.                                                                               |
| `provenance`       | `ProvenanceMap<T>`                                          | —              | The per-group provenance granularity the extraction schema was derived with — without it, a `"row"` group's cards come back empty.                                                                                         |
| `rankCandidates`   | `(group, instance, existing) => readonly RankedCandidate[]` | —              | Tool-specific ordering of existing records for one instance; contradicting candidates sort last. Display order only — the hook never links automatically.                                                                  |
| `reviewPlan`       | `ReviewPlan`                                                | —              | Optional shape plan to lay `tree` out by; a whole `DerivedExtractionShape` assigns.                                                                                                                                        |
| `storage`          | `Storage`                                                   | the provider's | Bypasses the provider — what tests inject.                                                                                                                                                                                 |

None of these defaults is an exported constant; they live in
`packages/ribo-ui-react/src/use-review.ts`, so no example asserts them.

Source: `packages/ribo-ui-react/src/use-review.ts`.

## Return value

A `UseReviewResult`. The head of it:

- `ready` — the session has both a joined transcript and an extraction, so review can proceed.
- `fields` — every leaf by dotted path, in schema-declaration order; the decision channel.
- `tree` — the leaves as the schema declared them (groups, instances, and section nodes under a
  plan); the rendering channel.
- `decisionOf` / `accept` / `edit` / `reject` — per-leaf decisions. Every leaf starts
  `{ status: "accepted" }`; `untouched` reports what nobody acted on. `edit` to `null` is a
  positive "nothing to record here"; `edit` to `undefined` throws.
- `errors` — one message per leaf the last submit was refused over.
- `linkDecisionOf` / `linkInstance` / `createInstance` / `rankedCandidatesOf` — instance identity:
  the safe default is always create.
- `addInstance` / `removeInstance` — add an all-empty instance to a collection group, or remove
  one and remap the remaining decisions to their new keys.
- `submit` / `discard` — resolve and persist the outcome. `submit` throws on a refused submission
  (with `errors` populated) and on a failed write; `submitting` and `error` are keyed by session,
  so a card showing a different session never inherits them.

## Errors

- **Stale or mistyped paths throw at the call** — `decisionOf`-style mutators (`edit`, `reject`,
  `linkInstance`, `removeInstance`) name the path in the error rather than silently vanishing a
  decision that would have resolved to a silent acceptance.
- **`edit(path, undefined)` throws** — it would be dropped on save and read back as "leave this
  field alone"; the message names `edit(path, null)` and `reject(path)` as the escapes.
- **A refused submission** — core's `ReviewValidationError` is rethrown after being written into
  `error` state; a caller that ignores it must not carry on as though the review went in.
- **A failed write** — the storage error is rethrown from `submit`, and surfaced on `error`.

Source: `packages/ribo-ui-react/src/use-review.ts`; the validation rules are core's (see the
[Review](/api/review) page).

## Full example

Type-checked only — never executed; see the note under Usage.

<<< @/api/examples/use-review.tsx

## Related APIs

- [Review](/api/review) — `buildReviewRequest` and `resolveReview`, the contract this hook drives.
- [`useCaptures`](/api/use-captures) — how the hook fetches the session's recordings to join.
- [`useSessions`](/api/use-sessions) — finding the parked sessions a review queue renders from.

## Guides that use it

- [React Hooks](/guide/react) — the review card in the wiring.
- [Review](/guide/review) — the contract `useReview` is built on.

## Reference

- [`useReview`](/reference/@azx/ribo-ui-react/functions/useReview.html)
- [`UseReviewOptions`](/reference/@azx/ribo-ui-react/interfaces/UseReviewOptions.html) ·
  [`UseReviewResult`](/reference/@azx/ribo-ui-react/interfaces/UseReviewResult.html)
- [`buildReviewRequest`](/reference/@azx/ribo-core/functions/buildReviewRequest.html) ·
  [`resolveReview`](/reference/@azx/ribo-core/functions/resolveReview.html)
