# @azx/ribo-transcriber-pdfjs

A document transcription plasmid for Ribo: PDF text extraction via
[pdf.js](https://mozilla.github.io/pdf.js/), implementing `@azx/ribo-core`'s
`Transcriber<DocumentCapture>` seam with engine id `"pdfjs"`. A PDF enqueued as
a `DocumentCapture` flows through the same `transcribe → extract → review`
pipeline as a voice recording, with pdf.js producing the text instead of Whisper.

## The worker URL is injected by the consumer

The library never constructs a `Worker` or reaches for a bundler-specific import
(AGENTS.md §5.2). The consumer serves the pdf.js worker (`pdf.worker.min.mjs`)
as a static asset from their own origin and passes its URL as `workerSrc`.

**CSP note:** `worker-src 'self' blob:` admits neither a CDN URL nor the
`data:` URI a bundler will inline. Ship the worker as a static asset and let the
consuming app serve it.

## Capability

Answers only from the environment — no pdf.js load:

- No `Worker` global → `unsupported-platform` (permanent).
- No configured `workerSrc` → `not-configured` (not permanent — a host may
  supply one later).
- Otherwise `ready`.

## Installation

```bash
pnpm add @azx/ribo-transcriber-pdfjs @azx/ribo-core
```

> Not yet published to a public registry — in this workspace it is consumed as a `workspace:` dependency.

## Public API at a glance

- **`PdfjsTranscriber`** — the class implementing `Transcriber<DocumentCapture>`.
  Constructed with `PdfjsTranscriberOptions`.
- **`PdfjsTranscriberOptions`** — `workerSrc` (the pdf.js worker URL, injected by
  the host), `noTextLayerThreshold` (minimum non-whitespace characters for the
  `no-text-layer` guard).
- **`PDFJS_ENGINE`** — the stable engine id string `"pdfjs"`.
- **`DEFAULT_NO_TEXT_LAYER_THRESHOLD`** — the provisional default threshold (50).
- **`openDocument`** — opens a PDF over the memoized pdf.js import, yielding
  `pageCount` immediately plus a handle to read the marked-up text later. A host
  enqueuing a document uses this to get `pageCount` without paying for a full
  text sweep.
- **`PAGE_MARKER`** — the page-marker prefix constant (`\n===== PAGE `).

## Minimal example

```ts
import { PdfjsTranscriber } from "@azx/ribo-transcriber-pdfjs";

// The host serves the worker from their own origin and supplies the URL.
const transcriber = new PdfjsTranscriber({
  workerSrc: "/assets/pdf.worker.min.mjs",
});
```

## Headless

This package is **headless** (AGENTS §4): no React, no DOM rendering. `Worker`
is checked by type (never constructed in library code), and `fetch` is not used.
`@azx/ribo-core` is a `dependencies` entry: the class implements `Transcriber`
and returns `TranscriberCapability`, both of which leak into this package's own
public API, so a consumer's type-check needs `@azx/ribo-core` resolvable too.

See the [API Reference](../../docs/reference/) (generated) for the full surface.
