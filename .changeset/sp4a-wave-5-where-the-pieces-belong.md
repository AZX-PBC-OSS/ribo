---
"@azx/ribo-core": minor
"@azx/ribo-extractor-openai": minor
"@azx/ribo-extractor-ondevice": minor
---

SP4a wave 5: the draft-state axis is replaced by a marker note key, and the
`ChatClient` seam plus the three transport-agnostic phases move into
`@azx/ribo-core`.

**The axis was added and removed in the same unreleased line.** `seedsDraft`
and `requiresDraft` on `PhaseMeta`, and the `validatePhases` rule that paired
them, are gone. The same dependency — a phase whose shape-of-`draft.fields`
need no other key could express — is now `draftSeededNoteKey`
(`noteKey("draft-seeded")`, exported from core): a seeding phase produces it
and writes it into the draft's notes in its merge, which the engine's
per-phase-boundary `produces` check verifies, and a phase that reads the draft
requires it, so the ordinary order-sensitive check does all the work. The five
behaviours the axis's tests pinned are preserved: `[gapfill]` alone rejected,
`[inventory, gapfill]` rejected, `[fill, gapfill]` passes, order matters, and a
phase cannot satisfy itself. ADR 0008 is superseded by ADR 0010, which records
that the axis's justification (a list-level seeding rule) was dropped under
review while the API built for it was not.

**The chat transport seam lives in core now.** `ChatClient`, `CapableChatClient`,
`ChatMessage`, `ChatRequest`, `ChatCompletion`, `ChatCallOptions`, `ChatCapability`,
`ChatUsage`, `ChatError` and the smaller types beside them moved from
`@azx/ribo-extractor-openai` to `@azx/ribo-core`; the openai package re-exports
the whole seam, so existing imports keep working. `openAiChat` and `helixChat`
are implementations and stay where they are.

**The presence/span/classify phases live in core now.** `presencePhase`,
`spanPhase`, `classifyPhase`, `classifyWrappedPhase`, their note keys
(`presenceNoteKey`, `spansNoteKey`, `unsupportedNoteKey`), their options types
and the `extractGroups`/`Group`/`Leaf`/`JsonSchema` schema walk moved from
`@azx/ribo-extractor-ondevice` to `@azx/ribo-core` — nothing in them is
on-device — and are exported from core's barrel beside `extractorPhase`.
`@azx/ribo-extractor-ondevice` no longer exports them (the wave-3 exports are
removed; there is no compatibility re-export here, because a host composes
these from core) and keeps `threePhaseExtractor`, the genuinely on-device
preset. The package's dependency on `@azx/ribo-extractor-openai` remains for
`perGroupExtractor` in its retry-integration test.
