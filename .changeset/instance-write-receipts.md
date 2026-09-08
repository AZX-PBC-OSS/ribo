---
"@azx/ribo-core": major
---

`ToolAdapter.write` returns the vendor's created-record id, and the write step keeps it.

`write` returned `void`. That was sound and vacuous at once — vendor egress is gated, so nothing has ever reached a host tool — but it left no way for a future "amend" pass to update an already-written record rather than duplicate it, because nothing kept the identifier the vendor assigned. `write` now resolves `{ uuid: string }`.

**Breaking:** every `ToolAdapter<V, C>` implementation's `write` must return `{ uuid }` instead of nothing.

Getting a _real_ per-instance identifier to the write step required `resolveReview` to stop discarding the instance keys (`k1`, `k2`, …) it already computes internally. `ReviewOutcome`'s `accepted`/`edited` branches gain `instanceKeys`, built from the same `positions` map that already orders `fields[group]`'s array, so the two stay in lockstep by construction. It's optional in the base shape — a link decision's optionality precedent, not a blanket requirement — but `reviewOutcomeSchema` enforces it wherever `fields` actually has collection-group data, via a schema-level length-parity check rather than a type requirement every hand-built outcome would otherwise have to satisfy unconditionally.

`toWriteStep`/`toInstanceWriteStep` now resolve a `SessionWriteResult` (`{ fields?, receipts? }`) instead of a bare field map, reusing the return channel `relay.ts` already had to persist `writeResult` — unused until now, since both real compositions previously resolved `void`. `receipts` is a new, durable session field: `{ singleton?: string; instances?: Record<group, Record<instanceKey, uuid>> }`, keyed by the instance's own key rather than its array position — the exact positional-identity bug class `writtenInstances` was deleted for, one layer up. Merged additively across write passes, and — unlike `reviewOutcome` — not cleared on reopen, since its whole purpose is to survive across reviews for a future amend pass to read.

The sessions collection moves to schema `version: 2`. An identity migration backfills `instanceKeys` for any existing `reviewOutcome` missing it (sequential `k1..kN` per group, exact for any session actually in flight, since its array order already is first-mention order until something re-reviews it).

**What this does not do:** the write step does not yet _read_ `session.receipts` back to decide "update, don't create." That's separate, future work, still gated on vendor egress actually landing — there's nothing to test an update-vs-create decision against until then.
