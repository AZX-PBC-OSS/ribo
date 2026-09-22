# 0016. Duplicate protection is the write receipt, not the idempotency key

Status: Accepted
Date: 2026-09-21

## Context

The write path carried an `Idempotency-Key` on every request, and the codebase reasoned from it.
`WriteMetadata.idempotencyKey` was documented as "stable across every retry of this queue item, so
a retry after an ambiguous success (the request landed, the response did not) is recognised by the
host tool as the same write rather than a second one." `deriveInstanceIdempotencyKey` existed only
to produce one per instance, and its comment said determinism "is the whole point … so a vendor
that honours `Idempotency-Key` recognises a retry rather than creating a duplicate record."

Measured 2026-09-21 against Snugg Pro's staging API: **the vendor ignores the header.** A create,
then a byte-identical replay with the same key, returned `200` with a _different_ uuid — two
records where one was intended. Their OpenAPI document declares no header parameters on any
endpoint and never mentions idempotency.

So the protection did not exist, and the comments asserting it were the most dangerous part: they
are what a later reader consults before deciding a retry is safe. Every ambiguous retry created a
duplicate HVAC system on a customer's home-energy audit.

A receipt — the vendor's own identifier for the record a previous attempt created — is the only
available replacement, because it lets the retry UPDATE that record instead of creating another.
But `toInstanceWriteStep` accumulated receipts in a closure and returned them only once its
instance loop finished, and the relay persisted them only after the step resolved. A throw at
instance 3 of 5 discarded the receipts for 1 and 2, so the retry re-created them. The mechanism
that was supposed to replace the header was itself unusable for the failure it had to survive.

## Decision

Duplicate protection is the receipt, checkpointed as it is earned, and nothing rests on the key.

`SessionWriteInput` carries a **required** `recordReceipt(group, instanceKey, receipt)` that the
relay supplies and `toInstanceWriteStep` calls immediately after each successful instance write,
patching the session's receipts additively. Required rather than optional: `recordReceipt?.(…)`
short-circuits in silence, so an optional member reads as a convenience and behaves as an opt-out,
and a caller who omitted it would reinstate the exact defect with nothing raised to notice. Adding
a member to what the relay _passes in_ breaks no host — only a caller constructing the input, the
relay and tests, must supply one.

`toInstanceWriteStep` resolves each instance's write target as: the human's link decision from
review if there is one, otherwise the receipt an earlier attempt recorded, otherwise create. The
human's decision wins because it says what the record _is_, while the receipt only says what we
wrote. The adapter receives one resolved target and never re-implements that precedence.

The key is still sent. It is harmless, and free if a vendor ever honours it. Every comment that
reasoned from it now says what was measured and names the date.

## Consequences

One window remains and cannot be closed: between the vendor committing a create and
`recordReceipt` completing, no local state proves the write happened, so a crash there still
duplicates on the next attempt. No idempotency key can close it either, because the vendor has
none. It shrinks from "the whole collection loop" to "one callback", and the review-time candidate
read (`readExistingRecords` feeding `rankCandidates`) is what surfaces the duplicate to a human
when it does occur. That is stated at the mechanism rather than left to be discovered.

Singleton receipts are deliberately not checkpointed. A singleton endpoint is an upsert addressed
by the job, so re-sending rewrites the same record and cannot duplicate — there is nothing for one
to protect.

This is a vendor-specific measurement shaping a tool-agnostic contract, which is uncomfortable but
correct: the contract previously encoded an assumption that no vendor we have met satisfies, and a
core that promises protection it cannot deliver is worse than one that names the mechanism its
adapters must actually use.
