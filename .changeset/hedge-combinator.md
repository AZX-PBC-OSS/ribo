---
"@azx/ribo-core": minor
---

Add the `hedged` combinator — race a preferred engine against a fallback on a latency budget.

A sibling of `firstCapable`, not a flag inside it. `firstCapable` stays strictly
sequential and its rule 5 (ordinary errors propagate untouched) stays untouched.
Start the primary; if it has not finished within a delay, start the hedge too and
take whichever finishes first. This is the "hedged request" pattern from Dean &
Barroso's _The Tail at Scale_.

New exports:

- `hedged(primary, hedge, options)` — returns a `CompositeTranscriber`, so it is
  drop-in interchangeable with `firstCapable` and `capabilities()` / `invalidate()`
  keep working. The primary may itself be a `firstCapable` composite.
- `hedgeDelay(options)` — the delay helper. Its clamp is the substantive part:
  `delayMs = clamp(predictedMs × factor, floorMs, budgetMs)`. The naive formula
  (fire after the primary's own predicted duration) is wrong because it scales the
  deadline by the device's slowness — a slower device would wait longer for help.
  `budgetMs` expresses what the auditor will tolerate; the prediction only pulls the
  hedge earlier on fast devices. When no prediction is available (`undefined`),
  the delay is `budgetMs`.
- `HedgedOptions`, `HedgeDelayOptions`, `HedgeDelayPolicy`, `PredictedDurationMs`,
  `TranscriberHedgeEvent` — the option and event types.
- `DEFAULT_HEDGE_FACTOR` (1.5), `DEFAULT_HEDGE_FLOOR_MS` (2 000),
  `DEFAULT_HEDGE_BUDGET_MS` (30 000) — provisional defaults, documented as such.

`ribo-core` does not learn what a real-time factor is: the delay policy receives a
`PredictedDurationMs` function returning milliseconds, supplied by the host from
whatever it measured. Knowledge of RTF stays in the on-device package that measured
it. The timer is injected via the existing `ScheduleTimer` from `connectivity.ts`,
so tests drive time through a double — no test sleeps.

The `onHedge` callback fires when the hedge wins the race, reporting `recordingId`,
both engine ids, and the `winner`. It mirrors `onFallback` from `firstCapable`:
quiet on the happy path (primary wins, no audio leaves the device), loud on exactly
the routing decision that is otherwise invisible.

Every discarded promise has a rejection handler attached, so a losing failure never
surfaces as an unhandled rejection.

No change to `Transcriber`, `TranscriberCapability`, `firstCapable`, or the outbox
schema. No new runtime dependencies.
