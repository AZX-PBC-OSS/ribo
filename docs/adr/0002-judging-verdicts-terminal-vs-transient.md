# 0002. A judging verdict's error class follows who failed, not how badly

Status: Accepted
Date: 2026-09-17

## Context

The judging combinators express a verdict by throwing. That puts them inside the existing
arbitration vocabulary, where `terminalFallsThrough` — the conservative default arbiter —
**continues on a terminal error and gives up on a transient one**. The reasoning is that a
transient failure means the transport is down and the next rung shares it.

This inverts the intuition. "Terminal" reads like "stop", and an author reaching for the obvious
class gets the opposite of the intended behaviour. The cost of getting it wrong is not a wrong
answer but a **full-price retry loop**: a transient rejection makes the ladder give up, the relay
classify the step failure retryable, and the entire extraction re-run — hallucinating rung included
— on backoff until the item is `dead`.

Two judging errors, and the naive reading puts them in the same class.

## Decision

Classify by **who failed**, not by how serious the failure looks.

- `ValidationRejectedError` **extends `TerminalError`**. The _model_ hallucinated. That is a
  property of one strategy's output, which the next rung may not share — so the ladder should
  continue, and terminal is what makes it continue.
- `ConsensusFailedError` **extends plain `Error`**, so `isTransientFailure` classifies it transient
  by the default-true rule. The _candidates_ failed, which usually means the transport is down and
  the next rung shares it — so the ladder should give up and let the relay retry the whole
  extraction later, on backoff.

Both class comments carry both halves of the contrast, because each looks like a mistake to a
reader who knows only the other.

## Consequences

A ladder now falls through on quality, which is the capability this whole layer exists to add, and
it stops burning rungs against a transport that is already down.

The cost is that two errors in one sub-project have opposite classifications, which will read as an
inconsistency to anyone who does not know the rule. That is why the rule is stated as "who failed"
rather than as two independent choices — and why an end-to-end ladder test pins each direction, so
reversing either fails a test rather than quietly changing retry behaviour in production.

See `docs/roadmap/design/sp2-judging-combinators-design.md` §4.2 and §4.1.
