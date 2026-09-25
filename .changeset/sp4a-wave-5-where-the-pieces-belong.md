---
"@azx/ribo-core": minor
"@azx/ribo-extractor-ondevice": minor
---

SP4a wave 5: the `ChatClient` seam and the three transport-agnostic phases
move into `@azx/ribo-core`.

**What a consumer gets:** a mis-wired phase list no longer fails silently. A phase whose
`plan` reads a note — the span phase reading presence's map, the fill phase reading the
inventory's roster — throws from that `plan`, naming the key and the fix, before any call
is made. Before, such a list planned nothing, the engine no-oped, and the run died at the
closing trust-boundary parse with a `SchemaParseError`. That error is _retryable_, so the
relay re-ran the whole phase list, re-spending every earlier phase's model calls on each
retry, until the session item went `dead`. (A list that runs and legitimately fills
nothing still fails at that parse — it is the correct backstop. The declaration vocabulary
itself is phase ids: see `sp4a-requires-are-phase-ids.md` and ADR 0008.)

There is deliberately no rule that _some_ phase must seed: `[inventory]` alone still
validates, because its merge writes `fields[key] = []` scaffolding for stated-none
collection groups, which is not clearly wrong.

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
`@azx/ribo-extractor-ondevice` keeps `threePhaseExtractor`, the genuinely
on-device preset, and its public surface is otherwise unchanged — a host
composes the phases from core. The package's dependency on
`@azx/ribo-extractor-openai` remains for `perGroupExtractor` in its
retry-integration test.
