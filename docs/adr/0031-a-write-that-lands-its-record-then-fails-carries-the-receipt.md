# 0031. A write that lands its record and then fails carries the receipt

Status: Accepted
Date: 2026-09-30

## Context

Duplicate protection for a collection write is the receipt, not an idempotency header
(ADR 0017). `toInstanceWriteStep` records an instance's receipt only after `adapter.write`
returns, and a retry hands that receipt back as `meta.linkTarget` so the write becomes an update.

That holds while one `write` is one request. Measured against Snugg Pro staging on 2026-09-30
(job 588613), `createHvac` returns 200 but discards `hvacHeatingSystemEfficiencyRatingUnit` and
`hvacCoolingSystemEfficiencyRatingUnit` and derives both from the equipment type, while
`updateHvac` stores them as sent. Keeping an auditor's stated unit on a new record takes a create
followed by an update, so one `write` is now two requests. If the update throws after the create
succeeded, `write` rejects, no receipt is recorded, and the relay's retry creates a second hvac
record on a real customer job.

## Decision

**`ToolAdapter.write` may reject with `ReceiptedWriteError(receipt, cause)` when its record
landed and the rest of the write did not. `toInstanceWriteStep` records the receipt, then
rethrows `cause` unchanged.**

- **Why core, not the adapter.** Only the step holds `recordReceipt`. An adapter that swallowed
  the failure to return a receipt would hide it from the relay; one that threw without it would
  lose the receipt. Carrying the receipt on the error needs neither.
- **The cause is rethrown, not the wrapper.** The relay classifies a failure by its `status` or
  by `TerminalError`. Rethrowing the cause keeps that classification exactly as it was for every
  adapter written before this existed.
- **`toWriteStep` unwraps too.** It records no per-instance receipt, so it has nothing to
  checkpoint, but it rethrows the cause so a terminal follow-up is not retried as transient.
- **The retry is enough.** With the receipt recorded, the retry is an update carrying the whole
  group patch, and an update stores the units. No separate recovery path exists.
- **A terminal follow-up** (a 4xx after a successful create) rethrows a `TerminalError` that
  names the record, says it exists without the unit the auditor stated, and says how to fix it.
  The item goes dead, loudly, rather than retrying a refusal that cannot change; the receipt is
  recorded, so re-parking it for review and retrying updates that same record.
- **Scope of the writer's compensation.** A small named table of the two rating-unit leaves on
  `hvac`, not a framework. A create follows up only for a non-null stated value; an explicit
  `null` on a new record has nothing to clear, and the vendor's derived unit beats an empty one.

## Consequences

- A multi-request `write` has a documented way to keep the receipt invariant. The contract is
  stated on `ToolAdapter.write`; the type cannot enforce it, as with `linkTarget`.
- The vendor fact is gated: `write-real.manual.ts` fails if `createHvac` ever honours the sent
  unit, at which point the follow-up is redundant and can be deleted (ADR 0019).
