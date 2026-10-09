---
"@azx/ribo-transcriber-pdfjs": minor
---

**pdfjs-dist 5.7.284 → 6.4.299**, for a high-severity advisory that affects `>= 5.6.83, < 6.2.108`
and has no 5.x fix. The worker you pass as `workerSrc` must come from the same pdfjs-dist version as
the library. Re-copy `pdf.worker.min.mjs` from 6.4.299 when you upgrade. Its path inside the package
is unchanged.
