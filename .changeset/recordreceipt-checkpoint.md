---
"@azx/ribo-core": minor
---

Write steps can now checkpoint each instance's vendor receipt the moment it is earned: `SessionWriteInput` carries a `recordReceipt(group, instanceKey, uuid)` callback, which the relay implements as an additive patch to the session's receipts. A write that throws mid-collection no longer discards the receipts the instances before it already earned, so the retry UPDATEs those records instead of creating duplicates — which matters because no vendor here honours `Idempotency-Key` (measured against Snugg Pro's staging API 2026-09-21). `SessionWriteResult.receipts` is unchanged and still supported.
