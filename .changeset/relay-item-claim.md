---
"@azx/ribo-core": minor
---

The relay now claims an outbox item before working it, so two tabs cannot run the same step.

`nextPending()` selects on status alone, and `ACTIVE_OUTBOX_STATUSES` deliberately includes the
in-flight statuses (`transcribing`, `extracting`, `writing`) so a step interrupted by a dead tab
resumes rather than stranding. Without a claim that is not a narrow race: a second tab selects work
the first is actively performing, in the steady state, and both run it — two transcriptions, two
extractions, and past the review gate two writes into the same audit.

The claim is a per-item Web Lock rather than a lease field, because a lock is released by the browser
when its holding context dies. "The tab that owned this is gone" and "the lock is free" become the
same event, with no expiry to tune — and a wrong expiry either strands work or permits exactly the
double-run this prevents.

`RelayOptions` gains an optional `locks` (a `LockManager`, defaulting to `navigator.locks`) so tests
can drive contention deterministically.
