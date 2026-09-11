# @azx/ribo-transcriber-managed-docs

Managed document transcription for Ribo — a hosted document-understanding API, proxied through the
host's transport. It implements `@azx/ribo-core`'s `Transcriber<DocumentCapture>` contract with
engine id `"managed-docs"`, and composes with [`@azx/ribo-transcriber-pdfjs`](../ribo-transcriber-pdfjs/README.md)
in a `fallbackTranscriber` ladder.

## When to use it

Use it as the fallback behind `@azx/ribo-transcriber-pdfjs`, for a scan or a photographed page with
no existing text layer for pdf.js to read. **The package never holds a credential:** it takes an
endpoint and an injected `fetch`, and the host's transport handles authentication however it
chooses — directly, or through a gateway that injects a stored secret.

Skip it if every document you handle already has a usable text layer — pdf.js alone is cheaper and
needs no network.

## Composing it

```ts
import { fallbackTranscriber, unsupportedFallsThrough } from "@azx/ribo-core";
import { ManagedDocsTranscriber } from "@azx/ribo-transcriber-managed-docs";
import { PdfjsTranscriber } from "@azx/ribo-transcriber-pdfjs";

const pdfjs = new PdfjsTranscriber({ workerSrc: "/assets/pdf.worker.min.mjs" });

// The host supplies the endpoint and the transport; the transport attaches
// whatever credential the host holds — this package never sees it.
const managedDocs = new ManagedDocsTranscriber({
  endpoint: "https://docs.example-host.internal/analyze",
  isOnline: () => navigator.onLine,
});

// pdf.js first — free, no network — falling through to the hosted API when
// there's no text layer to read.
const documentTranscriber = fallbackTranscriber([pdfjs, managedDocs], unsupportedFallsThrough);
```

## Learn more

- Guide: [Captures & Sources](../../docs/guide/captures-and-sources.md)
- [Repo root](../../README.md)
