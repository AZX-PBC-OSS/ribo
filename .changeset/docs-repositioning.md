---
"@azx/ribo-core": patch
"@azx/ribo-adapter-snuggpro": patch
"@azx/ribo-extractor-ondevice": patch
"@azx/ribo-transcriber-ondevice": patch
"@azx/ribo-transcriber-managed": patch
"@azx/ribo-transcriber-managed-docs": patch
"@azx/ribo-transcriber-pdfjs": patch
"@azx/ribo-ui-react": patch
---

Reposition the documentation around structured extraction, and correct what the prose had
outgrown.

No behaviour changes. Every package is patched because two things that ship in the published
artifact changed: each package's `README.md` (npm includes it regardless of the `files` field),
and doc comments across `src/`, which tsdown emits into `dist/*.d.ts` and TypeDoc republishes as
the API Reference.

**The framing.** "Reusable voice-capture SDK for field data collection" is retired. Ribo is a
browser-side, offline-first pipeline taking any capture — dictation, PDF, later a photo — through
extraction, verifiable provenance, human review and write-back into a system of record. Snugg Pro
is the reference adapter and a worked example, not the subject. Each package README now follows
one template: what it is, when to reach for it _and when not to_, one composition example, and
links onward.

**Corrections to published doc comments**, each verified against source rather than prose:

- Dead `{@link}` targets fixed — `toExtractStep` (the export is `toSessionExtractStep`) and
  `submitReview` (`Outbox.submitSessionReview`). TypeDoc warnings 55 → 45.
- `MAX_NULLABLE_UNIONS_PER_CALL` and its two sibling comments no longer describe the 16-union
  ceiling as a documented vendor limit. It is our own measurement on one managed route — 16
  accepted, 18 rejected, model-family-specific — and doc 21 says explicitly that whose limit it
  is "is not established here".
- `ProvenanceGranularity` no longer claims the 37 %-fabricated per-cell result and the
  14-of-14 verbatim row result came from the same document. They are separate reports, and only
  the per-cell run names a model.
- Comments describing capture-kind-agnostic paths in audio-only terms were generalised.
  Genuinely audio-specific wording was left alone.

**Corrections to repo docs** surfaced while writing the above and fixed at the source: the
pipeline is two state machines (recording, then session) rather than one; the leaf-package
dependency graph has a declared exception (`ribo-extractor-ondevice` → `ribo-extractor-openai`
for shared chat-client types); the headless ESLint boundary covers three packages, not two; and
several counts that had gone stale are now stated against a named source rather than restated.
