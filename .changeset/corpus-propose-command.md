---
"@azx/ribo-cli": minor
---

Adds `ribo corpus propose <corpus-dir> [case-id...]`: for every selected case, each schema leaf
with no explicit entry and no covering default gets a pending expected-answer proposal — a value
with evidence verified by code against the case's inputs, or a proposed absence — written into
`case.json` in place, additively and atomically (only `expected` gains keys, every existing entry
and default untouched, publication temp-file-then-rename). One model call per case that needs
one; repeatable `--only <scope>` narrows the leaves asked; an upper-bound estimate summed over
each case's own measured prompt goes to stderr before any backend is prepared, and `--max-spend`
and `--yes` behave as on schema init — an over-ceiling run makes no request and writes nothing,
with cheaper-fix advice selected by the backend (the CLI backends are never pointed at
`--response-cap`). stdout is a versioned JSON report naming every selected case's outcome
(proposed, nothing-to-propose, or failed with its unanswered leaves and reasons); stderr ends
with the `ribo corpus review` handoff. Completed runs exit 0 even when cases fail; faults that
stop the run exit 2 with stdout empty.
