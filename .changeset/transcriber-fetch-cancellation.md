---
"@azx/ribo-transcriber-managed": minor
"@azx/ribo-transcriber-managed-docs": minor
---

The two fetch-based transcribers now honour `TranscribeOptions.signal` rather than
merely accepting it. The signal is forwarded into the fetch request init, so an
abort tears down the in-flight HTTP request, and an already-aborted signal
cancels before the request is sent at all.

A cancellation is classified as **terminal**, not transient: the rejection is a
`TerminalQueueError`, the queue's existing terminal vocabulary. Previously an
`AbortError` carried no `status`, so `isTransientFailure` read it as retryable
and a cancelled transcription was re-sent — burning the retry budget to re-run
work the caller had explicitly withdrawn. A genuine network failure
(`TypeError` from a dropped uplink) is still transient and still retried; the
cancellation path must not swallow it.
