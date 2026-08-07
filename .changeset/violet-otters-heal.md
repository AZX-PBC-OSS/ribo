---
"@azx/ribo-core": minor
---

Add `Outbox.reopenForReview(id)`, the supported way back into `awaiting-review` from `dead`.

Until now there was no supported way to move an item back to `awaiting-review` for a second look.
`toWriteStep` (`write-step.ts`) and the relay's own `#write` (`relay.ts`) both die a `dead` item on a
terminal write failure — a reviewed patch the adapter's schema rejects, or an empty field set — and
both told the reader to "re-park the item" with a raw `Outbox.patch(id, { status: "awaiting-review" })`.
That is exactly the shape `relay.browser.test.ts` uses to simulate a state-machine bug jumping the
review gate by hand, so the only documented recovery path was the one the tests warn people never to
take.

`reopenForReview` only accepts `dead` as a source status, and only when the item has `extracted` data
to show a reviewer — a `dead` item that died before reaching extraction has nothing to review and is
refused with its own message. It clears the stale `reviewOutcome` (so the next `submitReview` cannot
merge a human's old decision into a review that has not happened) and resets `attempts` to `0`, the
same as every other entry into `awaiting-review`. It is applied through `incrementalModify`, the same
mechanism `submitReview` uses, so the status check and the mutation cannot be split by a second tab
reopening — or resubmitting — the same item. Both throw sites now name `Outbox.reopenForReview(id)`
instead of the raw patch.
