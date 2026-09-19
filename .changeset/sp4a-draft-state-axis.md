---
"@azx/ribo-core": minor
"@azx/ribo-extractor-openai": patch
"@azx/ribo-extractor-ondevice": patch
---

A phase list can no longer be mis-wired on the draft axis: `validatePhases` rejects a
phase declaring `requiresDraft` when no earlier phase declares `seedsDraft`.

`PhaseMeta` gains two optional booleans — `seedsDraft` ("this phase can populate an
empty draft's `fields`") and `requiresDraft` ("this phase only does useful work over a
draft another phase populated"). `requires`/`produces` modelled the notes channel;
nothing modelled the fields channel, which is why a list like `[gapfill]` alone — the
follow-up phase re-asking about leaves a base phase left abstained — passed every
check. The four phases with a fields dependency now declare it: `fill`, `presence` and
the lifted `extractorPhase` declare `seedsDraft`; `gapfill` declares `requiresDraft`.

Before this change, such a list did not fail loudly at construction. It planned
nothing, the engine no-oped, and the run died at the closing trust-boundary parse with
a `SchemaParseError` — which is retryable — so the relay re-ran the whole phase list,
re-spending every earlier phase's model calls on each retry, until the session item
went `dead`. The rejection now happens at construction, naming the offending phase and
the fix, for free.

There is deliberately no list-level rule that some phase must seed: `[inventory]` alone
still validates, because its merge writes `fields[key] = []` scaffolding for stated-none
collection groups, which is not clearly wrong.
