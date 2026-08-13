---
"@azx/ribo-core": minor
"@azx/ribo-transcriber-ondevice": minor
---

Revision 7 Task 4: the `LiveSession` seam carries tail vs commit to hosts.

`LiveSession.segments$` now emits `LiveSegment` (`{ kind: "tail" | "commit"; text: string }`)
instead of bare `string`. A host reading `segment.kind` can route tails to
`Outbox.writePreviewTail` (provisional, replaced wholesale) and commits to
`Outbox.commitPreview` (permanent, appended) — the distinction Task 2 introduced
at the worker protocol level, now exposed through the seam.

**Shape: one observable of a discriminated value**, not two. A host that ignores
the distinction subscribes to one stream, reads `.text`, and gets all text in
order; two observables would lose half the text for the same host. The
flush-after-close property stays on one stream, and Task 5's routing is one
exhaustiveness-checked `switch (segment.kind)` in one subscriber.

Two behaviours survive unchanged: `errors$` stays a separate channel (erroring
the segment `Subject` would kill it permanently), and segments arriving after
`close()` still reach the subscriber (the worker's final drain posts the last
region's text after `close()` — the listener is not removed and the `Subject`
is not completed on close). The stale `close()` doc that claimed late replies
were discarded is corrected.
