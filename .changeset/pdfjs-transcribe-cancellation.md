---
"@azx/ribo-transcriber-pdfjs": minor
---

The pdf.js transcriber now honours `TranscribeOptions.signal`, wired to pdf.js's
own cancellation lever: the local `PdfjsModule` shim simply did not expose
`loadingTask.destroy()` — the real module has always had it — so the shim grows
a `PdfLoadingTask` type with `destroy`, and an abort destroys the loading task.
pdf.js terminates its worker and rejects the pending open and any in-flight
page read.

The sweep additionally checks the signal at the top of every page, so work
already loaded stops at the next page boundary rather than requesting the next
one. Destroy runs on cancellation only — a successful sweep (including a
handle whose `readText` is called twice) keeps the document open exactly as
before.

A cancellation rejects with `TerminalQueueError`, not a raw pdf.js exception
(which `isTransientFailure` would read as retryable), matching the fetch
transports and the on-device transcriber: the queue does not burn its retry
budget re-running work the caller withdrew.
