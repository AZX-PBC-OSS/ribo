---
"@azx/ribo-transcriber-pdfjs": minor
---

Remove the pdf.js plumbing from the public barrel: the text-reading helpers `openDocument`, `readDocumentText` and `resetPdfjsCache`, the item predicate `isPdfTextItem`, the layout tuning constants `COLUMN_SEPARATOR`, `DEFAULT_COLUMN_GAP_PT`, `DEFAULT_ROW_TOLERANCE_PT` and `DEFAULT_WORD_GAP_PT`, and the `OpenDocumentHandle`, `OpenDocumentOptions` and `ReadDocumentTextOptions` types that only parameterise them. `PdfjsTranscriber`, `PAGE_MARKER`, `layoutPageText` and the options and event types their signatures name stay public.
