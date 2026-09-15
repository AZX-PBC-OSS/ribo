---
"@azx/ribo-transcriber-ondevice": minor
---

The on-device transcriber now honours `TranscribeOptions.signal`, and the
mechanism is a **between-chunks check over the worker protocol** — not
`worker.terminate()`. The worker channel is shared with live transcription
(batch replies match by `requestId`, live replies by `sessionId`), so a
terminate on a batch abort would also kill a user's in-flight dictation
preview and throw away the primed model `prime()` paid for. The main thread
instead posts a new `cancelTranscribe { requestId }` message when its signal
fires; the worker's batch loop checks the flag before starting work and
between chunks.

What this buys: a cancelled batch stops at the next chunk boundary (latency
bounded by one ≤30 s inference pass), a request that was still queued behind
the serialized inference chain when the cancel arrived skips its inference
entirely, and **a live session is untouched** — the cancel is keyed by
`requestId` and cannot crosstalk; the worker stays warm, and the freed chain
serves the live session's next turn sooner. `dispose()` remains the only
worker terminate.

A cancellation rejects with `TerminalQueueError` (matching the fetch
transports), so the queue does not burn its retry budget re-running withdrawn
work.
