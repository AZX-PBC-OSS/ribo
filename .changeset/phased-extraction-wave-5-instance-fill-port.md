---
"@azx/ribo-extractor-openai": major
"@azx/ribo-core": minor
---

**`scopedInstanceExtractor` is now a `phasedExtractor` preset** — the new exported `inventoryPhase` (one house-wide roster pass, all roster interpretation in its merge) followed by the new exported `fillPhase` (one scoped fill per `(group, piece, instance)`, recombined with `mergeGroupPieces`) — rather than a hand-rolled orchestrator. A host can assemble the same phase list by hand and extend or reorder it with phases of its own.

`@azx/ribo-core`'s share is additive: `PhaseUnit` gains optional `instance`/`instances`/`part`/`parts`, and a phase's `describeItem` may report the same four, so a scoped-instance fill event can still render "HVAC system 2 of 3, part 1 of 2". Phases that do not report them emit events with the members absent, not `undefined`.

Host-visible changes to `scopedInstanceExtractor`:

- **The `onUnit` observer's unit type widens from `InventoryUnit | InstanceUnit` to `PhaseUnit`**, and it now receives the engine's phase events: `unit: "phase"` with the phase's identity in `phaseId` (`"inventory"`, `"fill"`) and its position in `pass`. The piece coordinates survive as the new optional `PhaseUnit` members, so an assertion on `instance`, `instances`, `part` or `parts` needs only its discriminator changed. `InventoryUnit` and `InstanceUnit` remain in the `ExtractionUnit` union until the last port lands.
- **`onRetryBudget` now fires per reduced phase, and its `batches` value drops by one.** Today's estimate padded the inventory call into the job count; the fill phase's batches are derived from the fill jobs alone. The inventory phase cannot fire the observer at all — it pins `maxRetries: 0`, and a budget of zero cannot be reduced.
- **Returned objects are no longer reference-equal to anything the run built internally** — the engine's closing trust-boundary parse rebuilds every object. Values are unchanged (deep equality holds).
- **`usage.calls` now counts successful items, not attempts.** Today every attempt incremented the tally before the call, so a fill that succeeded on its second attempt reported its retry; the engine sums usage from resolved outcomes only. A run whose fill succeeds on the second attempt reports one call fewer than before.
- **Retry classification tightens.** Today's inline loop retried everything except `TerminalQueueError` and abort, so a 404 or 401 burned the whole budget. The engine composes `retryAsync`, which stops on a 4xx with a status and on cancellation — fewer attempts, different event counts.
- **A failing inventory emits the same two events** (one start, one error for the inventory phase's single item — the pass stays one-shot at `maxRetries: 0`), but they are `PhaseUnit`s now, and `statedEmptyGroups` stays absent rather than `{}` when no group stated one. The instance cap is still enforced before any fill call, now from the inventory phase's merge.
