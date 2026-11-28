---
"@azx/ribo-cli": minor
---

`ribo corpus review` records the review half of the proposal pass: with no action flag it prints
the pending sheet — every pending proposal's value, quote and input, re-verified (`grounded`) and
marked `literal` when the value itself occurs in its quote, collections row-major with proposed
absences in their own block — and `--json` emits it as a versioned document for an agent
reviewer. Decisions need a case id and exactly one action: `--confirm` (narrowable with
repeatable `--leaf`) confirms only entries whose every value is literal in a still-grounded
quote, printing what it left pending and why; a correction is an edit to `value` in `case.json`
then `--confirm --leaf`; `--mark-absent --leaf` sets the entry declared-absent and confirms it;
`--reject --leaf` removes the pending entry so the leaf resolves as the corpus otherwise would —
through a covering default if one exists, else unmentioned. The `proposal` block is never
modified, and every write goes through the guarded case writer, so only `expected` changes and
only atomically. Ships a worked example corpus with proposals in every review state and a new
"Reviewing proposed answers" section on the corpus page.
