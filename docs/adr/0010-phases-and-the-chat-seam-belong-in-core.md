# 0010. The chat seam and the transport-agnostic phases belong in core

Status: Accepted
Date: 2026-09-19

## Context

`presencePhase`, `spanPhase` and `classifyPhase` lived in `@azx/ribo-extractor-ondevice`, and were
not exported from it. Their only imports were `noteKey`/`phaseBuilder` from core and the chat seam
(`CapableChatClient`, `ChatMessage`, `ChatError`, …) from `@azx/ribo-extractor-openai`. Nothing in
them is on-device: they ask a chat client which leaves are present, what spans support them, and
which are unsupported. They were there because `threePhaseExtractor` — the on-device *preset* — is
there, and they were carved out of it.

The consequence was that any composition story was managed-only, which for an offline-first library
is the wrong half. It also meant a host could not build an alternative arrangement of the phases
the library already ships.

The chat seam was similarly misplaced. `chat-client.ts` is the transport *interface*; `openAiChat`
and `helixChat` are implementations. It imported exactly one symbol — `CANCELLATION` from core.

## Decision

Both move into `@azx/ribo-core`.

The seam moves first, because the phases depend on it and core cannot import from a package that
depends on core. `@azx/ribo-extractor-openai` re-exports the whole seam so no consumer breaks.

The three phases follow, with `extractGroups` and its `Group`/`Leaf`/`JsonSchema` vocabulary —
exporting the phases without the walk that feeds them would export something a host can construct
and never run.

`threePhaseExtractor` stays in `@azx/ribo-extractor-ondevice` and composes from core. It is
genuinely device-specific: device-tuned per-call ceilings, zero retry delay.

## Consequences

A host can compose the shipped phases, and its own alongside them. Every note key,
`phaseBuilder`, `noteKey` and the phases themselves are public, and the phase factories take an
additive `requires` so a shipped phase can be made to wait for a caller's own. `produces` is
deliberately **not** caller-extensible: the engine verifies it against what a merge actually wrote,
so an added key would make the phase throw mid-run.

The cost is a permanently wider public surface — four factories, their options, their note keys and
the schema walk are now supported API and a compatibility commitment.

`@azx/ribo-extractor-ondevice` still depends on `@azx/ribo-extractor-openai`, but for a different
reason than before: a test imports `perGroupExtractor`, a strategy. Every chat-seam import now
comes from core.
