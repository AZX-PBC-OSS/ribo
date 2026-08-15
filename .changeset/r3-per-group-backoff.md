---
"@azx/ribo-extractor-openai": patch
---

Add backoff between per-group retry attempts in `perGroupExtractor`.

A transient group failure was re-sent immediately — a 429 got hammered three
times in rapid succession, burning the retry budget in under a second. The
retry loop now backs off using `fullJitterDelay` from `@azx/ribo-core` (the
same exponential full-jitter function the relay uses), so a reader meets one
backoff policy in this codebase, not two. The delay is injectable (`delay`
option, defaults to `setTimeout`) so tests do not sleep.

The retry budget derivation is updated to account for accumulated backoff:
the worst case is now call time **plus** backoff delays, and the relationship
`ceil(G / concurrency) * ((maxRetries + 1) * PER_CALL_CEILING_MS + maxAccumulatedBackoff) <= stepTimeoutMs`
replaces the previous call-time-only bound.

429s are treated alike (all retried with backoff): "burst spend budget
exhausted" and "too many requests this second" cannot be reliably
distinguished from the status alone, and parsing the body for a
distinguishing signal is vendor-specific and fragile. A burst-spend 429
simply keeps failing through the per-group budget and throws to the relay.
