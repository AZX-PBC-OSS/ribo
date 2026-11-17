---
"@azx/ribo-cli": minor
---

`ribo eval` runs document cases. Each case's `input.pdf` is transcribed under Node once per run — through the real `PdfjsTranscriber` over pdf.js's legacy build, resolved from the installed `pdfjs-dist` — before the spend estimate and any model call; every arm shares the text, and the estimate prices it like a transcript. A PDF with no text layer, or one pdf.js cannot open, refuses the whole run (exit 2) naming the case. New exports: `transcribeDocumentCases`, `DocumentTexts`, `DocumentTranscriptionOptions` and `RunEvalOptions`.
