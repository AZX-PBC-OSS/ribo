# 0019. A probe's finding and its code have different homes

Status: Accepted
Date: 2026-09-21

## Context

Throwaway code that answers a question keeps arriving, and there was no rule for it. Three homes had
grown up and nothing said which to reach for:

- `spikes/<name>/` — committed, Prettier-formatted, and deliberately outside every other gate (the
  ESLint config excludes them by name: "spikes in no tsconfig"). Six of them, in three different
  shapes: two with no README, one that is _only_ a README.
- `packages/*/acceptance/*.manual.ts` — committed, typechecked, run through an opt-in Vitest config
  with its own env contract. Consistent, and nothing said it was the pattern.
- The session scratchpad — evaporates.

So the same question — "do we keep this?" — got argued each time and answered differently, and the
Snugg Pro write-back work made the cost concrete. Its probes produced the two findings the whole
design rests on (the vendor ignores `Idempotency-Key`; writes merge), and those probes were sitting
in a scratchpad about to be deleted while an ADR asserted their conclusions with no way to re-check
them.

The argument recurs because one question is being asked about three things that have nothing in
common except having been written at the same moment.

## Decision

Route by shelf life, not by origin. A probe produces up to three things:

1. **The finding.** Permanent. It goes in a doc, or an ADR if it drove a decision. Code adds
   nothing to it.
2. **The reproduction** — the ability to check the finding still holds. Worth keeping **only when
   something outside our control can change it**, which in practice means a live dependency. That
   is a `packages/*/acceptance/*.manual.ts`: opt-in, skips cleanly without its env, never in CI,
   and reversible by construction if it writes.
3. **The scaffolding.** Deleted.

`spikes/` remains, for the case none of those cover: a multi-file investigation with a corpus and
results worth keeping. It gains the structure it never had — `NNNN-kebab-name/`, numbered in date
order like the ADRs, each with a README that opens with Status and Date and states the answer
before the method. `spikes/index.md` is the record.

The three can overlap, and the README says which parts went where rather than duplicating a probe.
Spike 0007 is the worked example: it is a dated record, two of its assertions were promoted to a
manual gate because the vendor can change them, and its scaffolding was dropped.

Spikes stay outside every gate but Prettier. That is not neglect — it is why rule 2 puts the answer
in the README. The prose has to outlive the script, because the script will rot and nothing will
tell us.

## Consequences

Existing spikes `0001`–`0006` keep their unnumbered directory names for now. Their numbers are
assigned by first-commit date in the index and are real; the directories catch up in a migration of
its own, because `extraction-snuggpro` alone is referenced from 40 places including `check.sh`,
`.gitignore` and `.prettierignore` — where a missed path pattern silently starts committing results
directories — and 63 path edits do not belong inside a feature branch. The record was the missing
part and it exists now; the filesystem is behind it, visibly, in a table that says so.

There is no test enforcing the README. A spike is by definition the thing you write when you do not
yet know the shape of the problem, and a gate on it is a tax on exactly the moment you can least
afford one. The index is the check: a spike absent from it is invisible, which is enough.

The cost of getting rule 2 wrong is asymmetric, and it is worth naming. Keeping a reproduction that
nothing can change is clutter someone eventually deletes. NOT keeping one that a vendor can change
leaves a documented "measured" claim quietly becoming false, with the code that would have caught
it thrown away — which is the failure this decision exists to prevent, and it nearly happened here.
