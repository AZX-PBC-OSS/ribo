# @azx/ribo-transcriber-pdfjs

PDF text extraction for Ribo, via [pdf.js](https://mozilla.github.io/pdf.js/). It implements
`@azx/ribo-core`'s `Transcriber<DocumentCapture>` contract with engine id `"pdfjs"`. A PDF enqueued
as a `DocumentCapture` flows through the same `transcribe → extract → review` pipeline as a
dictation, with pdf.js producing the text instead of Whisper.

## When to use it

Use it when a PDF already has a text layer — a digitally authored report, an exported form. It
reads the existing text; it does not OCR, so it refuses a document with no text layer
(`no-text-layer`).

Skip it, or put it behind [`@azx/ribo-transcriber-managed-docs`](../ribo-transcriber-managed-docs/README.md)
in a `fallbackTranscriber` ladder, for scans and photographed pages.

## Composing it

```ts
import { fallbackTranscriber, unsupportedFallsThrough } from "@azx/ribo-core";
import { ManagedDocsTranscriber } from "@azx/ribo-transcriber-managed-docs";
import { PdfjsTranscriber } from "@azx/ribo-transcriber-pdfjs";

const pdfjs = new PdfjsTranscriber({ workerSrc: "/assets/pdf.worker.min.mjs" });
const managedDocs = new ManagedDocsTranscriber({ endpoint: docAnalysisEndpoint });

// pdf.js first — free, no network — falling through to the hosted document API
// when there's no text layer to read.
const documentTranscriber = fallbackTranscriber([pdfjs, managedDocs], unsupportedFallsThrough);
```

## Learn more

- Guide: [Captures & Sources](../../docs/guide/captures-and-sources.md)
- [Repo root](../../README.md)
