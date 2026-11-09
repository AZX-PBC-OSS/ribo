---
"@azx/ribo-transcriber-managed-docs": minor
---

Remove the response-parsing internals from the public barrel: `flattenDocumentAnalysisResponse`, `isEncryptedError`, `stripMarkersAndWhitespace`, and the `DocumentAnalysisCell`, `DocumentAnalysisErrorBody`, `DocumentAnalysisPage`, `DocumentAnalysisResponse`, and `DocumentAnalysisTable` types. The managed-docs `Transcriber` class is the public surface.
