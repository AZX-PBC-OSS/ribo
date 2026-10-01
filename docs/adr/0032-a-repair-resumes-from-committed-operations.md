# 0032. A repair resumes from committed operations instead of re-proposing the set

Status: Accepted
Date: 2026-10-01

## Context

The collapse the repair loop existed to prevent happened anyway, on a proposal far too large for its
turn to be wasted. Measured 2026-09-30 in spike 0012's probes (`gpt-5.6-luna`, the Snugg Pro schema
with descriptions stripped, the proposer told to hint every field): attempt 1 returned 448
operations, the applier refused 2 — a duplicate pair. The repair message asked for "the revised
set", the model returned only the one fixed operation, the loop accepted that valid one-operation
answer as success, and 446 surviving operations were discarded. The loop takes the last successful
answer, not the best one, and every retry re-sends the whole proposal as an echoed assistant turn.
ADR 0024 fixed the same loss at exhaustion; the successful-repair case was left open.

## Decision

**Operations that apply are committed and never re-sent; a repair turn is a resume.** After each
attempt that parses, a commit rule folds the attempt's operations into a committed set — every
operation that applies, except one a refusal names as its culprit; a new operation identical to a
committed one is ignored before validation. A turn that leaves refusals, or fails outright, is
answered with a **fresh resume request** — the system prompt, the field list as the committed
operations left it (tagged `[dropped]`, `[retyped → …]`, `[moved → …]` on the original paths), and
one line per refusal — with no echoed assistant turn. The model replies with a delta of NEW
operations only, and replying with just the fixes becomes the correct answer by construction.
Transport exhaustion returns the committed set — `[]` only when nothing has committed yet. Repair
only: resume turns happen exactly where retries happened before; continuation turns after a clean
attempt and per-group passes are out of scope.

## Consequences

**This amends ADR 0016 twice.** The repair turn no longer re-proposes the whole set — the
echoed-assistant-turn format and "the revised set" ask are gone — and transport exhaustion returns
the committed set rather than `[]`. The one-repair-budget economics and the closed-set contract are
unchanged. **It amends ADR 0024's exhaustion rule:** the result at exhaustion is the committed set,
which subsumes the final proposal's surviving subset — the committed set validated as a whole
derives with zero refusals on every exit path. **Continuation turns are out of scope:** a clean
attempt still ends the loop, and a host that wants "propose anything else" turns builds them on the
same resume format. The public API of `proposeShapeOperations` is unchanged.

Design: `docs/roadmap/design/proposer-resume-design.md`.
