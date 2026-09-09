---
"@azx/ribo-transcriber-pdfjs": patch
---

Add pdf.js text extraction, page markers, and the no-text-layer guard.

Wires `transcribe()` to a memoized dynamic `import("pdfjs-dist")` that opens the PDF, reads each page's `getTextContent()`, and joins them with page markers (`\n===== PAGE n =====\n`, numbered from 1). Preserves the reference implementation's `item.hasEOL` handling for line structure. A document yielding fewer than `noTextLayerThreshold` (default 50, provisional, exported as a named constant and an option) non-whitespace characters throws `UnsupportedItemError` with reason `"no-text-layer"`. pdf.js's own `PasswordException` and `InvalidPDFException` are mapped to `UnsupportedItemError` (`encrypted` / `unsupported-format`); anything else rethrows unchanged.

Exports `openDocument` — an open-handle that yields `pageCount` immediately (free from `doc.numPages`) plus a separate `readText` call — so a host enqueuing a `DocumentCapture` gets `pageCount` without paying for a full text sweep. Also exports `readDocumentText`, `PAGE_MARKER`, and `resetPdfjsCache`.

Includes two committed fixture PDFs (hand-written raw bytes, no generator dependency) and seven `*.browser.test.ts` tests covering text extraction, page markers, the no-text-layer guard, memoization, and composition through `fallbackTranscriber`.
