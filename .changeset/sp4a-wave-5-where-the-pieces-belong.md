---
"@azx/ribo-core": minor
"@azx/ribo-extractor-openai": minor
"@azx/ribo-extractor-ondevice": minor
---

SP4a wave 5: the draft-state axis is replaced by a marker note key, and the
`ChatClient` seam plus the three transport-agnostic phases move into
`@azx/ribo-core`.

**What a consumer gets:** a phase list that is mis-wired on the draft — `[gapfill]` with
nothing before it to populate the fields — is now refused at construction, naming the
phase and the fix. Before, such a list planned nothing, the engine no-oped, and the run
died at the closing trust-boundary parse with a `SchemaParseError`. That error is
_retryable_, so the relay re-ran the whole phase list, re-spending every earlier phase's
model calls on each retry, until the session item went `dead`. Rejecting at construction
is free.

There is deliberately no rule that _some_ phase must seed: `[inventory]` alone still
validates, because its merge writes `fields[key] = []` scaffolding for stated-none
collection groups, which is not clearly wrong.

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
