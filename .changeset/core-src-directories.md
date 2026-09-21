---
"@azx/ribo-core": patch
---

Group the flat `src/` into directories by concern, and relocate `ScheduleTimer`.

`packages/ribo-core/src` was one flat pile covering nine concerns. Files now sit
in `provenance/`, `capture/`, `extraction/`, `phases/` (with the chat seam, per
ADR 0010), `transcription/`, `review/`, `write/`, `async/` and the existing
`storage/`. `recorder.ts` and `worklet.ts` stay at the `src/` root because the
recorder loads its worklet by URL relative to its own module.

`ScheduleTimer` moves out of `connectivity.ts` to `src/async/schedule-timer.ts` —
its consumers are the hedged transcription combinator and the timeout/hedged
extraction combinators, not connectivity. It is still exported from the barrel,
so no import from `@azx/ribo-core` changes.

No behaviour change, no renamed identifiers, no new exports: the barrel's export
list is identical, and the package's `exports`, `sideEffects` and tsdown entry
map are untouched.
