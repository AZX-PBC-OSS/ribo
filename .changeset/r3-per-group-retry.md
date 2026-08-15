---
"@azx/ribo-extractor-openai": patch
---

Add bounded per-group retry to `perGroupExtractor` (R3 Task 3).

A group that fails transiently is retried up to `maxRetries` times (default 2)
while successful groups are held, so one blip does not discard six good calls.
Terminal failures (`TerminalQueueError` — truncation, content filtering,
refusal, unsupported) are never retried. If a group still fails after its
retries, `extract()` throws and the relay's existing backoff, attempt count
and `dead` handling take over unchanged.

The retry budget is derived from the step-timeout relationship: the relay
wraps `extract()` in `withTimeout(stepTimeoutMs)`, and `maxRetries` is capped
so the worst case — every group exhausting its budget — fits within
`stepTimeoutMs` at a conservative per-call ceiling. New options: `maxRetries`
(default 2), `stepTimeoutMs` (default 900_000, matching the relay's
`DEFAULT_STEP_TIMEOUT_MS`).

`mapWithPool` now stops pulling new work after a failure and aborts in-flight
calls via `AbortController` — previously, workers kept pulling from the queue
after a sibling rejected, so a failing extraction still started every
remaining group's call and those calls outlived the rejected `extract()`.
The `ChatClient` seam's `AbortSignal` is now wired through `completeOrClassify`.

`usage.calls` reports the real number of calls made, including retries.
