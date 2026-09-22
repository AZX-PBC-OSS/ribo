# 0018. `write` returns a receipt, core never parses it, and one call carries one group

Status: Accepted
Date: 2026-09-21

## Context

`ToolAdapter.write` resolved with `{ uuid: string }`. `uuid` is Snugg Pro's word — their
collection responses carry a property of exactly that name — sitting in the package whose stated
job is that no tool-specific knowledge lives in it. Core's own vocabulary was already different:
`receipts`, `recordReceipt`, `mergeReceipts`, and every persisted receipt typed a bare `string`.
The write contract was the only structural commitment to the vendor's spelling.

The name also made honest adapters lie. A Snugg Pro singleton endpoint returns no identifier at
all — the `basedata` and `health` response definitions carry no uuid or id — so the adapter has to
synthesise one, and returning `singleton:basedata:588613` through something typed `uuid` needed a
comment apologising for itself. When a type forces you to document that its values are not what it
is called, the type is wrong.

A second mismatch sat beside it. `write` receives the whole patch while a Snugg Pro patch can span
twenty endpoints, so `toInstanceWriteStep` batched every singleton group into one call. The
adapter then fanned that into a request per group and had to collapse N vendor receipts into the
one string the contract returns — which it did by synthesising `assessment:<id>`, a value
identifying none of them. That is a receipt in name only: a retry holding it cannot address any
record, so the duplicate it was meant to prevent happens anyway. The patch was being split twice,
in core and again in the adapter, and the two did not agree.

## Decision

`write` resolves with `{ receipt: string }`: whatever string lets a later attempt address the
record this write landed. Core stores it, hands it back as `WriteMetadata.linkTarget`, and **never
parses it**. Its shape is entirely the adapter's business.

`toInstanceWriteStep` sends **one group per call** — every singleton group on its own, every
collection instance on its own. Every receipt an adapter returns is then the real one for the
record it wrote, and both the adapter's fan-out and the synthetic marker are deleted. An adapter
that is handed a multi-record patch anyway refuses, naming `toInstanceWriteStep`, rather than
inventing a receipt for it.

No singleton receipt is recorded. Nothing read `receipts.singleton` — only `receipts.instances` is
consulted, to turn a retry into an update — and a singleton upsert addressed by the job cannot
duplicate. `toWriteStep`, which writes one patch in one call, still records one.

Deliberately NOT renamed: the vendor's own `uuid` response field, `ExistingRecord.uuid`, and a link
decision's `uuid`. Those are real vendor uuids read off real records. The rename was applied by
syntactic position and then by type error, never by the word — a blanket rename would have quietly
repointed the response parser at a field the vendor does not send, and the fakes would have been
renamed in lockstep so every test still passed.

## Consequences

`@azx/ribo-core` takes a major version. It is `0.0.0` and unpublished, so the cost today is a
changeset line and a migration note; the same change against a published package would be a
breaking change for every consumer, which is the argument for doing it now rather than when it is
noticed later.

An adapter whose patch spans several endpoints must be composed with `toInstanceWriteStep`.
`toWriteStep` remains correct for an adapter whose patch is one record at one endpoint, and its own
documentation now says which is which — it previously offered `toWriteStep(snuggProAdapter)` as the
worked example, which this decision makes wrong.

`receipt` is a weaker type than it looks: core cannot check that an adapter returns something
addressable, only that it returns a string. That is the price of the contract not knowing what a
host tool's identifiers are, and it is the right price — the alternative was a contract that named
one vendor's and forced the others to lie through it.
