---
"@azx/ribo-transcriber-pdfjs": patch
---

Rebuild each page's visual reading order from pdf.js item geometry instead of concatenating in
content-stream order.

`getTextContent()` returns items in the order the PDF's drawing operators run, which is not visual
order. Measured on a real two-page contractor invoice, the previous concatenation emitted the whole
label column and then the whole value column, so `Subtotal` and `$70,903.33` were nowhere near each
other and no extractor could pair them. The geometry needed to fix this (`transform`, `width`) was
already on every item and was simply discarded.

`layoutPageText` clusters items into rows by baseline, orders each row left to right, and marks wide
horizontal gaps with a `COLUMN_SEPARATOR`. Line items now come out as
`LHBP115 | Litetronics … | EA | 223 | 130.77 | 29,161.71`.

The separator is not cosmetic: rebuilding rows also glues together content that merely shares a
baseline — on the sample invoice a legal disclaimer sits on the same line as the totals box — so the
separator is what keeps "these were far apart on the page" recoverable rather than inventing an
adjacency the document does not have.

Thresholds (`rowTolerancePt`, `columnGapPt`, `wordGapPt`) are exported constants and options, with
provisional defaults documented alongside what would refine them. `item.hasEOL` is no longer read;
geometry supersedes it.
