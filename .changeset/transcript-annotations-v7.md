---
"@azx/ribo-core": patch
---

Add an optional `annotations` field to `Transcript` and bump the outbox schema from v6 to v7.

A `Transcriber` can now contribute structured data (page boundaries, table structure, a provider's own response) alongside the transcript text. The annotations are persisted inside the outbox document and merged into the `AnnotatedTranscript` annotations bag by `listSessionTranscriptParts`.

The relay's capture metadata (`seq`, `kind`, `id`) is now namespaced under a reserved `capture.` prefix (`capture.seq`, `capture.kind`, `capture.id`) so a transcriber's own annotations cannot collide with it. The per-capture marker format is unchanged.

The v6 → v7 migration strategy is identity — the field is optional and absent on existing documents, which is the correct state for them. No existing document is transformed.
