---
"@azx/ribo-core": patch
---

Export the presence-phase helpers from the package barrel. `nullEnvelope`,
`wrapGroupEntry`, `writableGroupEntry` and the `PresenceMaps` type were already
public from `phases/presence-phase.ts` — this makes them reachable from
`@azx/ribo-core` itself. A presence phase implemented outside core must
reproduce that module's seeding of every group with a full null envelope
exactly: without the seed, a group whose presence map is all-false is missing
from the result fields, and the closing trust-boundary parse rejects the whole
result. Such a phase needs these same helpers rather than a second copy of
them. Purely additive — no behaviour change.
