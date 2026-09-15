---
"@azx/ribo-core": minor
---

The relay's transcribe step now has the same cancellation channel the session
extract step has had since Task 19: `#transcribe` passes a per-attempt
`AbortSignal` to `transcriber.transcribe` and `withTimeout`'s `onTimeout` hook
aborts it when the step timeout fires, so a transcription that exceeds
`stepTimeoutMs` has its in-flight work (a fetch request, a worker's chunk loop,
a pdf.js loading task) cancelled instead of running to completion behind the
rejection.

The transports built in the previous four tasks already honour that signal, so
a timed-out attempt now actually stops: fetch-based engines tear down their
HTTP request and throw `TerminalQueueError` (a cancellation does not burn the
retry budget), the on-device engine stops between chunks without terminating
its primed worker, and pdf.js destroys its loading task.
