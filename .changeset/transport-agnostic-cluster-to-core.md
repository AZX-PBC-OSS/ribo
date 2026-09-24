---
"@azx/ribo-core": minor
"@azx/ribo-extractor-openai": minor
---

Move the transport-agnostic extraction cluster into `@azx/ribo-core`.

`ribo-extractor-openai` is misnamed twice over: it holds two chat transports, one of
which (`helixChat`) is not OpenAI, and every strategy above them depends only on the
injected `ChatClient`. ADR 0010 already moved the seam and the transport-agnostic
phases on exactly that reasoning — "nothing in them is on-device: they ask a chat
client" — and ADR 0020 recorded that a further split was owed. This is that split's
non-breaking half: the code moves now, the package rename is a separate breaking
change that does not ride along.

`projectTarget`, the `extraction-common` prompt/trust-boundary helpers,
`singleShotExtractor`, and `presenceFillPhase` now live in and are exported from
`@azx/ribo-core`. Nothing in them names OpenAI — they speak the `ChatClient` seam — so
a host driving core's phases with `helixChat` no longer reaches a vendor-named package
for the strategy layer above it.

`@azx/ribo-extractor-openai` re-exports everything it previously exported, so no
consumer breaks and its public surface does not shrink — the same compatibility move
ADR 0010 made for the chat seam. `presenceNarrowedExtractor` deliberately does NOT
move: it is a preset, and ADR 0010 left `threePhaseExtractor` — also a preset — out of
core for the same reason. It stays in the extractor package, composing
`presenceFillPhase` from core.
