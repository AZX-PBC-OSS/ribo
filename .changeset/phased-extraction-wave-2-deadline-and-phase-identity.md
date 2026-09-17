---
"@azx/ribo-core": major
"@azx/ribo-extractor-ondevice": major
---

Extraction now carries a deadline down a composition, and progress events name
their phase.

`ExtractOptions` gains an optional `deadline` — absolute epoch milliseconds,
never a duration, because a duration cannot survive being passed down a
composition without each layer knowing how long the layers above it had already
spent. A delegating combinator forwards the options bag whole (the forwarding
discipline `signal` already had; `groupedExtractor` rebuilt the bag and dropped
every other member, and now spreads it). A combinator that holds its own budget
narrows rather than widens: `timeoutExtractor`'s effective deadline is
`Math.min` of its own and any it inherited, it passes that effective deadline
down, and it rejects immediately — without calling the inner extractor — when
the inherited deadline is already past. The relay mints the initial deadline
from `Date.now()` beside the step timeout it already owns, so the advisory
deadline sits on the same time base as the abort timer that actually fires.

What a consumer gains: a combinator nested inside another sizes its work
against the time actually remaining instead of assuming it has all of it.

What breaks: `PhaseUnit` gains a required `phaseId` (`"presence"`, `"span"`,
`"classify"` — what a progress consumer renders) and widens `pass` from
`0 | 1 | 2` to `number` (position in the phase list). Any code constructing a
`PhaseUnit` needs updating; the only constructor in this repo is the on-device
three-phase emitter.
