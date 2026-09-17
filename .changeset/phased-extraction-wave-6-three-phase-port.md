---
"@azx/ribo-extractor-ondevice": major
"@azx/ribo-core": major
---

**`threePhaseExtractor` is now a `phasedExtractor` preset of four phases** — `presencePhase` (one call per group asking which leaves are discussed, whose merge seeds every group with a full null envelope), `spanPhase` (one verbatim-quote call per group with present leaves, grounded unconditionally), `classifyPhase` (one call per grounded leaf against its bare value schema) and `classifyWrappedPhase` (one call per leaf the transport reported `unsupported` for, against a wrapped schema) — rather than a hand-rolled orchestrator. The phases are exported from `@azx/ribo-extractor-ondevice`'s new `phases/` modules; a host can assemble the same list by hand.

`@azx/ribo-core`'s share is the retirement: **`GapFillUnit`, `InventoryUnit` and `InstanceUnit` leave the `ExtractionUnit` union.** The three strategies they described all emit `PhaseUnit` now, and nothing constructs them. `WholeUnit`, `GroupUnit` and `PhaseUnit` remain.

Host-visible changes to `threePhaseExtractor` (its signature is unchanged except the observer's unit type, which was already `PhaseUnit`):

- **The run is phase-major, not group-major**: every group's presence call happens before any span call, and `pass: 3` is now reachable (the wrapped phase). `phaseId` names the phase — `"presence"`, `"span"`, `"classify"`, `"classify-wrapped"`.
- **The wrapped-schema fallback is its own phase with its own unit id at `pass: 3`**, not an error-driven request rewrite continuing the classify unit's id and attempt numbers. Each item's attempt numbering starts at 1.
- **`usage.calls` counts successful items, not attempts** — a call that succeeded on its second attempt reports one call, not two.
- **The rejection type on caller-abort paths is no longer always `ChatError` kind `"aborted"`** (and is timing-dependent): an already-aborted signal rejects with core's `CancellationError` from `retryAsync`'s pre-attempt check, and an abort arriving between attempts after a real failure rethrows that failure. Assert through core's `isCancellation` rather than naming a concrete class.
- **An unsupported classify attempt's event moves from `error` to `done`** — the call succeeded; the unsupported fact now travels only in the phases' notes, invisible to the event stream.
- **A response that fails the closing parse throws a `SchemaParseError` with a context prefix**, not a raw `ZodError`.
- **The preset is tuned for the device**: `perCallCeilingMs` is the transport's own 15 s bound (`DEFAULT_DEVICE_PROMPT_DEADLINE_MS`), and retries take no backoff delay.

And the fix worth naming as a fix: **a cancellation during classification now rejects the run instead of resolving with silently nulled leaves.** The old classify path had no cancellation check at all — a transport abort arriving before the caller's signal flipped became a null leaf with its `sourceSpan` retained, indistinguishable from a document that said nothing.
