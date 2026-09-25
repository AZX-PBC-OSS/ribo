---
"@azx/ribo-core": minor
---

Finish moving the transport-agnostic extraction code into `@azx/ribo-core`.

ADR 0010's criterion is genuine specificity, not "is it a preset": it moved the chat
seam and the phases because "nothing in them is on-device — they ask a chat client",
kept `threePhaseExtractor` behind because it is genuinely device-specific, and its
follow-up moved the single-shot cluster on the same test. What remained in
`ribo-extractor-openai` was the rest of a package that no longer matched its name: of
its source files only `openai-chat.ts` and `helix-chat.ts` are vendor-bound, and those
stay. Everything else speaks the injected `ChatClient`.

So the schema split and its dry run (`extraction/schema/`), the per-group strategy and
the presets above it (`extraction/strategies/`), the shape derivation
(`extraction/shape/`), the gap-fill and scoped-instance presets (`extraction/gap-fill/`,
`extraction/scoped-instance/`), and the three phase factories `gapFillPhase`,
`inventoryPhase` and `fillPhase` (`phases/`, beside the phases they follow) now live in
and are exported from core.

`presenceNarrowedExtractor` moves with them, which reverses the line the previous
changeset drew for it: a preset composed of core's `phasedExtractor` and
`presenceFillPhase` plus a caller-supplied presence phase has no vendor specificity to
keep it in a vendor-named package. `threePhaseExtractor` stays out of core as before —
device-tuned per-call ceilings and zero retry delay are ADR 0010's actual test, and it
still fails it.

`@azx/ribo-extractor-openai` re-exports everything it previously exported from the new
locations, so no consumer breaks and its public surface does not shrink — ADR 0010's
own compatibility approach.
