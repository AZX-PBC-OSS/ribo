# Review

Review is the human gate between extraction and write-back: `buildReviewRequest` turns an
extraction draft and its transcript into a `ReviewRequest` — every leaf, its provenance envelope,
its groundedness verdict and its own value schema — and `resolveReview` classifies what the human
did with it into a `ReviewOutcome`. [`useReview`](/api/use-review) is the React hook over the same
contract; nothing here renders anything.

## When to reach for it

Reach for this page when building a review UI **without** React, or when you need the contract's
exact rules — completeness, per-leaf validation, link targets. Reach for the
[Review guide](/guide/review) for the flow the review sits in, and for why review is a queue
status rather than a callback.

## Usage

The example drives the whole contract against a small patch schema — nested object group,
collection group, stated-empty claim — with no credentials and no network:

<<< @/api/examples/review.run.ts#usage

Review addresses **flat dotted leaf paths** (`"healthSafety.ambientCo"`, `"hvac[k1].fuel"`), never
top-level keys: the data determines how many instances exist, the schema determines every leaf
within each instance, and a leaf the model omitted is still presented with the sentinel envelope
rather than silently missing from the card.

## Options

`buildReviewRequest(extracted, transcript, valuesSchema, options?)` takes
`BuildReviewRequestOptions`. Every field is optional; all default to empty.

| Name                | Type                                                  | Default | What it does                                                                                                                                                                                                                                                                |
| ------------------- | ----------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `requiredOnCreate`  | `RequiredOnCreate<z.infer<T>>`                        | `{}`    | Leaf names grouped by the collection group that owns the create endpoint. Each named leaf gets `ReviewField.required: true`, so a card can refuse a submit that leaves it empty — turning a write that would fail at the host into a question answered while still on site. |
| `existingRecords`   | `Readonly<Record<string, readonly ExistingRecord[]>>` | `{}`    | Records the host tool already has, per collection group. They enter at review, never at extraction — surfaced for a human to link against, with create as the safe default.                                                                                                 |
| `statedEmptyGroups` | `Readonly<Record<string, string>>`                    | `{}`    | The extractor's roster spans, keyed by group: an empty-array group with a span here gets `state: "statedEmpty"` and carries the quote — "there are none" against "touch nothing".                                                                                           |
| `skippedItems`      | `readonly SkippedItem[]`                              | `[]`    | The extraction's skip report, so the tree can carry `skipped: true` on the nodes the failed items addressed. Omit it when the session carries no report — every node then reads `false`.                                                                                    |
| `provenance`        | `ProvenanceMap<T>`                                    | `{}`    | The per-group provenance granularity the extraction schema was derived with — the same map handed to `enveloped(schema, { provenance })`. Without it a `"row"` group reads as envelopes and every card comes back empty.                                                    |
| `reviewPlan`        | `ReviewPlan`                                          | —       | A shape plan to lay the tree out by. It changes `tree` and nothing else — paths, `resolveReview` and the write are identical with and without it. A whole `DerivedExtractionShape` assigns.                                                                                 |

None of these defaults is an exported constant; they live in
`packages/ribo-core/src/review/review.ts`, so no example asserts them.

## Return value

`buildReviewRequest` returns a `ReviewRequest`:

- `transcript` — the auditor's own words, for context.
- `fields` — every leaf by path, each a `ReviewField`: the full envelope, the two-tier
  groundedness verdict (`isGrounded`, `groundedness`), the leaf's own zod `schema` (wrappers and
  all, so `null` is a legal reviewed value), and `required`. Insertion order is schema-declaration
  order and is part of the contract.
- `tree` — the same leaves as a second view in the shape the schema walk saw them: `ReviewLeafNode`,
  `ReviewObjectNode`, `ReviewCollectionNode` (with `state` and `emptyQuote`), and — only when a
  `reviewPlan` laid it out — `ReviewSectionNode`, which has no path and no key. A switch over
  `ReviewNode` must learn the `section` case: the type widens for every host, plan or not.
- `existingRecords` — what was supplied.

`resolveReview(request, submission)` returns a `ReviewOutcome`: `accepted` (the extraction's hit
rate under a real auditor), `edited` (with `editedFields` / `rejectedFields` in schema-declaration
order), or `discarded`. `fields` is the reassembled **nested** object — the shape the adapter's
patch schema describes and `write` sends. With instance links submitted, the outcome carries
`linkTargets` (uuid or null per resolved instance, positionally aligned) and `instanceKeys`.

`contradictionMatcher(fields?)` returns an `InstanceMatcher`: `"different"` on a contradicting
identifying field, and **never `"same"`** — agreement is not identity, so it returns `"unknown"`
and leaves the judgement to the host:

<<< @/api/examples/review.run.ts#contradiction

## Errors

- **`ReviewValidationError`** — `resolveReview` throws it (never returns it as a fourth outcome
  branch, so a malformed submission cannot be persisted) for: a submission whose leaf set is not
  the request's (missing or unexpected paths), a value that fails its leaf's schema, an `edited`
  decision carrying `undefined`, an unrecognised decision status, and an instance link naming an
  unknown instance path. `.issues` carries every problem at once, addressed to the leaf each is
  wrong at.
- **`contradictionMatcher` throws `TypeError`** when a leaf arrived as a provenance envelope
  instead of a flattened value — a wrapper that would silently veto every pair.

Source: `packages/ribo-core/src/review/review.ts` and
`packages/ribo-core/src/review/instance-identity.ts`.

## Full example

Runs in CI. Every exported function below is executed by the Vitest `unit` project on every
`test` run, ending in assertions on exactly what this page claims.

<<< @/api/examples/review.run.ts

## Related APIs

- [`useReview`](/api/use-review) — the React hook over this contract; it takes the schema as an
  argument and never touches the adapter.
- [Provenance](/api/provenance) — the envelope `ReviewField` presents and the groundedness tiers.
- [`ToolAdapter`](/api/tool-adapter) — where `requiredOnCreate` is declared, and the write the
  accepted outcome feeds.

## Guides that use it

- [Review](/guide/review) — the queue flow the gate sits in, and the session statuses around it.
- [React Hooks](/guide/react) — the hook a React host consumes this contract through.

## Reference

- [`buildReviewRequest`](/reference/@azx/ribo-core/functions/buildReviewRequest.html) ·
  [`resolveReview`](/reference/@azx/ribo-core/functions/resolveReview.html)
- [`ReviewRequest`](/reference/@azx/ribo-core/interfaces/ReviewRequest.html) ·
  [`ReviewField`](/reference/@azx/ribo-core/interfaces/ReviewField.html) ·
  [`BuildReviewRequestOptions`](/reference/@azx/ribo-core/interfaces/BuildReviewRequestOptions.html)
- [`ReviewNode`](/reference/@azx/ribo-core/type-aliases/ReviewNode.html) ·
  [`ReviewSectionNode`](/reference/@azx/ribo-core/interfaces/ReviewSectionNode.html) ·
  [`ReviewPlan`](/reference/@azx/ribo-core/type-aliases/ReviewPlan.html)
- [`ReviewOutcome`](/reference/@azx/ribo-core/type-aliases/ReviewOutcome.html) ·
  [`ReviewSubmission`](/reference/@azx/ribo-core/type-aliases/ReviewSubmission.html) ·
  [`reviewOutcomeSchema`](/reference/@azx/ribo-core/variables/reviewOutcomeSchema.html)
- [`ReviewValidationError`](/reference/@azx/ribo-core/classes/ReviewValidationError.html)
- [`contradictionMatcher`](/reference/@azx/ribo-core/functions/contradictionMatcher.html) ·
  [`InstanceMatcher`](/reference/@azx/ribo-core/type-aliases/InstanceMatcher.html)
