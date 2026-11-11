# ToolAdapter and write steps

A `ToolAdapter` is the one place tool-specific knowledge lives: how a host tool's fields are
shaped, how to describe them to an extractor, and how to write them back. `toWriteStep` and
`toInstanceWriteStep` collapse an adapter onto the relay's `SessionWriteStep`, parsing the
reviewed patch against the adapter's schema — the trust boundary the write path runs through.
`deriveInstanceIdempotencyKey` and `ReceiptedWriteError` support the per-instance composition.

## When to reach for it

Reach for this page when declaring an adapter or wiring one into the queue. Reach for the
[Write-back guide](/guide/write-back) for the flow — review, then parse, then write — and
[Snugg Pro adapter](/api/snuggpro-adapter) for the real instance. Adapters never build the
extraction schema by hand: [`enveloped(schema)`](/api/provenance) is the one supported way.

## Usage

<<< @/api/examples/tool-adapter.run.ts#usage

`toWriteStep` sends the WHOLE reviewed patch to `write` in one call — right for an adapter whose
patch is one record at one endpoint. An adapter whose patch spans several endpoints composes with
`toInstanceWriteStep` instead, which sends one group per call and checkpoints each receipt as it
is earned, so a retry UPDATEs rather than duplicates.

## Options

Neither composition takes defaults worth quoting: both parses are terminal and `write`'s
idempotency key comes from the queue. The one derived value on this page is the per-instance key
format, quoted from the example file rather than retyped — the same file's test run asserts it:

<<< @/api/examples/tool-adapter.run.ts#defaults

| Member              | On                    | Type                       | Default      | What it does                                                                                                                                                                             |
| ------------------- | --------------------- | -------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema`            | `ToolAdapter`         | `ValuesSchema<V>`          | **required** | The PATCH that gets written, in plain values — every leaf optional, nullable where a null is a meaningful written value. Source of truth for `V`, and the trust boundary's parse target. |
| `extractionSchema`  | `ToolAdapter`         | `ZodType<Enveloped<V, P>>` | **required** | What the model produces. Derived with `enveloped(schema)` — declaring both by hand is the schema drift this exists to prevent.                                                           |
| `ctxSchema`         | `ToolAdapter`         | `ZodType<C>`               | **required** | Parses `AudioCapture.ctx` — a persisted `unknown` crossing a trust boundary — into the destination `write` needs.                                                                        |
| `requiredOnCreate`  | `ToolAdapter`         | `RequiredOnCreate<V>`      | —            | Per-group leaves the host tool refuses to CREATE without, surfaced to review while the auditor is still on site. Pin it against `schema` in a test: a typo otherwise marks nothing.      |
| `identifyingFields` | `ToolAdapter`         | `IdentifyingFields<V>`     | —            | Per-group fields a sameness judgement may VETO on. Never merges on agreement: what makes two descriptions the same thing is host judgement.                                              |
| `instructions`      | `ToolAdapter`         | `string`                   | **required** | Natural-language guidance for the extractor.                                                                                                                                             |
| `examples`          | `ToolAdapter`         | `ToolAdapterExample[]`     | —            | Few-shot pairs, in the enveloped shape the model emits.                                                                                                                                  |
| `write`             | `ToolAdapter`         | function property          | **required** | Writes accepted fields; resolves with a **receipt** (whatever string lets a later attempt address the record). A function property, not a method — strict contravariance on `C`.         |
| `collectionGroups`  | `toInstanceWriteStep` | `readonly string[]`        | **required** | Top-level field names that are per-instance arrays; every other top-level field is written once as a singleton.                                                                          |

The measured note, stated rather than hedged: **Snugg Pro ignores `Idempotency-Key`** (measured
2026-09-21 against its staging API — a replayed create returned a new uuid). The key is still
sent, harmless and free; duplicate protection on a retry rests on the write receipt, never on the
header.

Defaults are read from `packages/ribo-core/src/write/adapter.ts`, `write/write-step.ts`,
`write/instance-write-step.ts` and `write/receipted-write-error.ts` — the same files the Errors
section is read from.

## Return value

`toWriteStep(adapter)` and `toInstanceWriteStep(options)` return a `SessionWriteStep` — the
function the [relay](/api/relay) calls per session. Both parse `ctx` and `reviewed` before any
write runs, and a failed parse throws `TerminalError`: the inputs are already persisted, so a
retry would fail identically, and the relay marks the session `dead` on the first failure.

The instance step resolves with `receipts.instances` keyed by the review outcome's real instance
keys, and checkpoints each receipt through `recordReceipt` as it is earned — a throw later in the
loop cannot discard one.

## Errors

- **Both parses are terminal** (`TerminalError`): a reviewed patch that fails `adapter.schema`, or
  a `ctx` that fails `adapter.ctxSchema`, dies on the first attempt — the session's review outcome
  is already persisted; re-park with `Storage.sessions.reopenForReview(id)` and review afresh.
- **`ReceiptedWriteError`** — an adapter throws it when its write created the record and then
  failed (a create whose follow-up request died), carrying `.receipt` and `.cause`. The instance
  step records the receipt, then rethrows `cause` unchanged, so the relay classifies the real
  failure. Throw it only when the receipt names a record that really exists.
- **`write`'s own rejection is passed through untouched** by both steps — a network failure is
  exactly what must be retried.

## Full example

Runs in CI. Every exported function below is executed by the Vitest `unit` project on every
`test` run, ending in assertions on exactly what this page claims.

<<< @/api/examples/tool-adapter.run.ts

## Related APIs

- [`enveloped`](/api/provenance) — the derivation `extractionSchema` is built with.
- [`createRelay`](/api/relay) — the queue that calls the write step, parks transient failures and
  marks terminal ones `dead`.
- [Snugg Pro adapter](/api/snuggpro-adapter) — the real adapter, wired with
  `toInstanceWriteStep`.

## Guides that use it

- [Write-back](/guide/write-back) — the two field shapes, the receipt, and what a host still owes.

## Reference

- [`ToolAdapter`](/reference/@azx/ribo-core/interfaces/ToolAdapter.html)
- [`ValuesSchema`](/reference/@azx/ribo-core/interfaces/ValuesSchema.html) ·
  [`WriteMetadata`](/reference/@azx/ribo-core/interfaces/WriteMetadata.html) ·
  [`RequiredOnCreate`](/reference/@azx/ribo-core/type-aliases/RequiredOnCreate.html) ·
  [`IdentifyingFields`](/reference/@azx/ribo-core/type-aliases/IdentifyingFields.html)
- [`toWriteStep`](/reference/@azx/ribo-core/functions/toWriteStep.html) ·
  [`toInstanceWriteStep`](/reference/@azx/ribo-core/functions/toInstanceWriteStep.html) ·
  [`deriveInstanceIdempotencyKey`](/reference/@azx/ribo-core/functions/deriveInstanceIdempotencyKey.html)
- [`ReceiptedWriteError`](/reference/@azx/ribo-core/classes/ReceiptedWriteError.html)
