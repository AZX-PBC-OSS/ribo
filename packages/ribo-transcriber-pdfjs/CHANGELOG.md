# @azx/ribo-transcriber-pdfjs

## 0.2.0

### Minor Changes

- e76e1db: Remove the pdf.js plumbing from the public barrel: the text-reading helpers `openDocument`, `readDocumentText` and `resetPdfjsCache`, the item predicate `isPdfTextItem`, the layout tuning constants `COLUMN_SEPARATOR`, `DEFAULT_COLUMN_GAP_PT`, `DEFAULT_ROW_TOLERANCE_PT` and `DEFAULT_WORD_GAP_PT`, and the `OpenDocumentHandle`, `OpenDocumentOptions` and `ReadDocumentTextOptions` types that only parameterise them. `PdfjsTranscriber`, `PAGE_MARKER`, `layoutPageText` and the options and event types their signatures name stay public.

### Patch Changes

- Updated dependencies [a39efc5]
- Updated dependencies [85e3505]
- Updated dependencies [e76e1db]
  - @azx/ribo-core@0.2.0

## 0.1.0

### Minor Changes

- 7fba323: First release.

### Patch Changes

- Updated dependencies [7fba323]
- Updated dependencies [48c0647]
- Updated dependencies [c6e52d8]
  - @azx/ribo-core@0.1.0
