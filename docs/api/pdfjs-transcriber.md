# PdfjsTranscriber

PDF document transcription via pdf.js, with engine id `"pdfjs"`. Implements the
[`Transcriber`](/api/transcriber) seam as `Transcriber<DocumentCapture>`, so a scanned-in or
uploaded PDF flows through the same `transcribe → extract → review` pipeline as a voice
recording — pdf.js producing the text instead of Whisper.

## When to reach for it

Reach for it when documents are captured on the device and must transcribe offline. Reach for
the [Captures & Sources guide](/guide/captures-and-sources) for how it pairs with
[`ManagedDocsTranscriber`](/api/managed-docs-transcriber) in a fallback ladder, and for what the
page markers in its output mean downstream.

## Usage

Type-checked only — `transcribe()` lazy-loads pdf.js, which constructs its own worker, so this
example is compiled but never executed; its runtime behaviour is covered by the package's own
tests.

<<< @/api/examples/pdfjs-transcriber.ts#usage

`capability()` answers only from the environment and never loads pdf.js — the contract says it is
called often and expected to be cheap. No `Worker` constructor → `unsupported-platform`
(permanent); no configured `workerSrc` → `not-configured` (a host may supply one later).

## Options

`new PdfjsTranscriber(options?)` takes `PdfjsTranscriberOptions` — every member is optional.

The defaults the page states are quoted from the example file rather than retyped, and the same
file's test run asserts every one of them against the exported constants — so a source change
that moves one fails the `test` stage:

<<< @/api/examples/pdfjs-defaults.run.ts#defaults

| Name                   | Type                         | Default                                   | What it does                                                                                                                                                                                                                       |
| ---------------------- | ---------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workerSrc`            | `string`                     | —                                         | URL of the pdf.js worker script (`pdf.worker.min.mjs`). Injected by the host — the library never constructs or discovers it, and a bundler-inlined `data:` URI trips strict CSPs. Absent, `capability()` reports `not-configured`. |
| `noTextLayerThreshold` | `number`                     | `DEFAULT_NO_TEXT_LAYER_THRESHOLD` (above) | Minimum non-whitespace characters a document must yield before `transcribe()` throws `UnsupportedItemError("no-text-layer")`. A scanned PDF often yields stray characters from a header stamp, so zero is the wrong bar.           |
| `onPage`               | `(event: PageRead) => void`  | —                                         | Progress hook, called after each page with the page number, the total, and that page's non-whitespace character count — a run of zero-character pages is a scanned insert worth surfacing before the whole-document guard decides. |
| `loadPdfjs`            | `() => Promise<PdfjsModule>` | a memoized `import("pdfjs-dist")`         | The lazy-load seam, exposed so tests can assert that `capability()` never calls it. Not part of the stable public API.                                                                                                             |

Options are read from `packages/ribo-transcriber-pdfjs/src/config.ts`.

## Return value

`transcribe(item, bytes, options?)` opens the document, reads each page's text content, and joins
them with page markers (`\n===== PAGE n =====\n`, numbered from 1). Pages are laid out by
geometry — pdf.js emits items in content-stream order, which is not visual order — so rows are
rebuilt from the text items' placements and cells in a row are joined with `" | "`, the same
conventions `ManagedDocsTranscriber`'s flattener uses, so a downstream prompt cannot tell which
engine produced the text.

`capability()` resolves to a `TranscriberCapability`; `engine` is always `"pdfjs"`.

## Errors

- **Item unsuitability** — `UnsupportedItemError`: `no-text-layer` (below the threshold — often a
  scanned PDF, and the fallback ladder's cue to try the managed engine), `encrypted` (pdf.js's
  own password exception), `unsupported-format` (an invalid PDF).
- **Attempt failure** — anything else rethrows unchanged; the queue owns retry.
- **Cancellation** — the caller's `signal` is wired to pdf.js's own cancellation lever
  (`loadingTask.destroy()`), with the sweep additionally checking the signal at every page
  boundary. A cancellation rejects with `TerminalError`, not a raw pdf.js exception.

## Full example

Type-checked only — never executed; see the note under Usage. The page's runnable defaults
example (under Options) is the part that runs in CI.

<<< @/api/examples/pdfjs-transcriber.ts

## Related APIs

- [`Transcriber`](/api/transcriber) — the seam this class implements, and the generic that makes
  a document engine `Transcriber<DocumentCapture>`.
- [`ManagedDocsTranscriber`](/api/managed-docs-transcriber) — the managed document engine it
  falls back to, with matching output conventions.
- [`restrictToKind`](/api/composing-transcribers) — the lift that lets an audio-only roster and a
  document ladder share one relay.

## Guides that use it

- [Captures & Sources](/guide/captures-and-sources) — the document roster and the
  `no-text-layer` guard's place in it.

## Reference

- [`PdfjsTranscriber`](/reference/@azx/ribo-transcriber-pdfjs/classes/PdfjsTranscriber.html)
- [`PdfjsTranscriberOptions`](/reference/@azx/ribo-transcriber-pdfjs/interfaces/PdfjsTranscriberOptions.html)
- [`PageRead`](/reference/@azx/ribo-transcriber-pdfjs/interfaces/PageRead.html)
- [`DEFAULT_NO_TEXT_LAYER_THRESHOLD`](/reference/@azx/ribo-transcriber-pdfjs/variables/DEFAULT_NO_TEXT_LAYER_THRESHOLD.html)
