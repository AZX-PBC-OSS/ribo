---
"@azx/ribo-transcriber-managed": minor
---

Add the `vocabulary` option to `ManagedTranscriber` — domain terms sent to the
Fast Transcription endpoint as `definition.phraseList.phrases` (Task 5 of the
managed transcription plan).

This is load-bearing, not a refinement: measured on 2026-08-17 the same audio
returned "our 19" with no phrase list and "R-19" with one (design §6). R-values
are exactly the class of term the downstream extractor reads. The parameter
exists only from api-version `2025-10-15` onward, which the endpoint already
targets; a plausible-looking wrong key (`phrase_list`, `phraseHints`, a bare
array) is silently ignored by the service, so the exact nesting is asserted in
tests.

**The vocabulary belongs to the host.** The option mirrors the shape of
`TranscribeHints.vocabulary` in `ribo-transcriber-ondevice/src/config.ts`
(`readonly string[]`) so a single host-held list can feed both engines by two
mechanisms — a jargon prefix on-device, a phrase list here. The type is
re-declared in this package rather than imported: `TranscribeHints` stays in the
on-device package and is not moved to `ribo-core`. Task 7 passes the vocabulary
through this option.

The `definition` builder (`src/definition.ts`) keeps `locales` alongside a
supplied phrase list, and omits `phraseList` entirely when no terms are supplied
— an empty phrase list is no phrase list, and a builder that replaced the
definition instead of extending it would silently break language selection.

No new runtime dependencies. No change to `Transcriber`, `TranscriberCapability`,
`firstCapable`, or the outbox schema.
