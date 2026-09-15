---
"@azx/ribo-core": major
"@azx/ribo-transcriber-ondevice": minor
"@azx/ribo-transcriber-managed": minor
"@azx/ribo-transcriber-managed-docs": minor
"@azx/ribo-transcriber-pdfjs": minor
---

`Transcriber.transcribe` takes an options parameter — `transcribe(item, bytes, options?)` — with
`TranscribeOptions` carrying an optional `AbortSignal`. The shape, parameter position and
optionality mirror `ExtractOptions` on `Extractor.extract`, so the two run-context contracts
share one convention and do not drift. The bag exists for run context (cancellation now; a
`PluginStorage` handle next), never for configuration.

`FakeTranscriber` records the options of every call, positionally matching `calls`, as
`callOptions` — the recorder pattern `FakeExtractor.callOptions` established, because a
combinator that accepts options and forwards none typechecks all the same.

The four combinators thread the options through whole:

- `firstCapable` — whichever engine is selected receives the caller's options; candidates
  skipped on capability receive nothing, because they are never called.
- `fallbackTranscriber` — every candidate that runs receives them, including the ones that
  failed and fell through.
- `hedged` — **both** racing candidates receive the caller's signal verbatim, with no synthesis
  in between. The hedge timer is a latency policy, not a cancellation: cancelling the _loser_
  is a different concern from the caller cancelling the _race_, and reaping a loser would need
  a linked per-branch controller that changes what candidates observe — its own design decision,
  not a side effect of threading. So both see "this transcription is cancelled", never "one of
  you lost".
- `restrictToKind` — the wrapped engine receives them; a lift that dropped them would make the
  wrapped engine the one place the caller's signal dies.

No transport forwards the signal yet — each transport's mechanism (fetch init, worker protocol,
`loadingTask.destroy()`) is its own follow-up with its own failure classification to decide.
Until a transport honours it, its doc comment says so plainly: a signal that is accepted and
not forwarded looks like cancellation and is not.
