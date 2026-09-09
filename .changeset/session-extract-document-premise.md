---
"@azx/ribo-core": patch
---

Pin the premise the document-transcription work rests on: a document's transcript reaches session
extraction exactly as a dictation's does, a session mixing both joins them in capture order, and
pdf.js page markers survive into the extractor's input. `joinSessionTranscript` reads only
`status`, `seq` and `transcript.text`, so this holds by construction — these tests are what keep it
holding. Each was verified by mutation.
