# 0006. The budget combinator detects overspend; it does not prevent it

Status: Accepted
Date: 2026-09-17

## Context

Nothing in this repo bounds a run's call count. `phasedExtractor` bounds wall clock through the step
timeout, and a phase's item count and `maxRetries` bound its own calls, but no **ceiling** exists —
a number a caller sets that the run is measured against. A twenty-group strategy with retries can
issue sixty calls and nothing says whether that was expected. This matters more once the call count
is chosen by a model rather than by a person.

The tempting design is a governor: something that stops the run when the ceiling is reached. A
wrapper over the `Extractor` seam **cannot** do that. It sees one thing — the result that comes
back — and by then the calls have been made and billed. Building it as a governor would require
reaching inside every strategy, which is the one thing these combinators are defined not to do.

## Decision

`budgetExtractor` reads the returned result's usage against the caller's ceilings and throws
`BudgetExceededError` when one is breached. It is a **detector**, and both the name in the docs and
the file header say so in the first paragraph.

`maxTotalTokens` is defined as `promptTokens + completionTokens`, treating an absent member as zero
and checked only when at least one was reported. The cache members are deliberately excluded — they
describe _where_ the prompt tokens came from, so adding them double-counts the prompt.

## Consequences

A host learns that a run overspent, and an arbitration ladder can act on it. That is worth having
even though it arrives late: the alternative on offer was nothing.

The cost is stated rather than hidden. **It cannot prevent the spend it reports.** It is honest
around one strategy, where the number it reads is the number that strategy spent; around a ladder it
reports only the rung that happened to return, so a ladder that burned three rungs before succeeding
is measured on the third alone.

A real governor needs a budget object threaded through the call sites that actually issue requests —
a different design at a different layer, and a much larger change. Recording this as a detector is
what keeps someone from mistaking the wrapper for that governor later.

See `docs/roadmap/design/sp2-judging-combinators-design.md` §4.3.
