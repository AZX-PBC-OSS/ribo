/**
 * The type-checked example behind docs/api/pdfjs-transcriber.html.
 *
 * `transcribe()` lazy-loads pdf.js, which constructs its own worker — so this
 * file is never executed. It is type-checked by the examples tsconfig (see
 * docs/api/index.md), so the shapes shown on the page are real. Runtime
 * behaviour is covered by the package's own unit tests.
 */

import { type DocumentCapture, type Transcriber } from "@azx/ribo-core";
import { type PageRead, PdfjsTranscriber } from "@azx/ribo-transcriber-pdfjs";

// #region usage
// The worker URL is injected by the host — the library never constructs or
// discovers it. Without one, capability() reports not-configured.
const engine: Transcriber<DocumentCapture> = new PdfjsTranscriber({
  workerSrc: "/pdf.worker.min.mjs",
  onPage: (event: PageRead) => {
    console.log(`page ${event.page} of ${event.of}: ${event.chars} chars`);
  },
});
// #endregion usage

function document(id: string): DocumentCapture {
  return {
    id,
    capturedAt: new Date().toISOString(),
    kind: "document",
    pageCount: 2,
    mimeType: "application/pdf",
    ctx: {},
  };
}

const capability = await engine.capability();
console.log(capability.status, engine.engine);

// Below the threshold, transcribe throws UnsupportedItemError("no-text-layer")
// — a scanned PDF often yields a few stray characters, so zero is the wrong bar.
const transcript = await engine.transcribe(document("cap-doc"), new Blob(["%PDF-1.7 …"]));
console.log(transcript.text);
