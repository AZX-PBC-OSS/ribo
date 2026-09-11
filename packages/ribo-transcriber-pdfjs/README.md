# @azx/ribo-transcriber-pdfjs

A document transcription plasmid for Ribo: PDF text extraction via
[pdf.js](https://mozilla.github.io/pdf.js/), implementing `@azx/ribo-core`'s
`Transcriber<DocumentCapture>` seam with engine id `"pdfjs"`. A PDF enqueued as a `DocumentCapture`
flows through the same `transcribe → extract → review` pipeline as a dictation, with pdf.js
producing the text instead of Whisper.

## When to reach for it

Reach for it when a PDF already has a text layer — a digitally authored report, an exported form.
It reads the existing text; it does not OCR, so it refuses a document with no text layer
(`no-text-layer`) rather than guessing.

Skip it, or put it behind [`@azx/ribo-transcriber-managed-docs`](../ribo-transcriber-managed-docs/README.md)
in a `fallbackTranscriber` ladder, for scans and photographed pages with no text layer at all.

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
