---
"@azx/ribo-cli": minor
---

The package grows the comparison: `compareEvalRunRecords` lines two run records up and reports
which of the four identity fields — backend, model, settings, run fingerprint — they differ on
(the axes, never refused and never silently equated), the leaf intersection with each side's
exclusion counts, and every differing cell pair with both sides' persisted cells. It is the one
comparison behind the new `ribo compare a.json b.json` command and behind a multi-arm `ribo eval`
run's cross-arm summary, which the first arm's record is compared against each later arm's in.

`ribo compare` reads exactly the two record files it is named, renders the terminal table by
default and the versioned `--json` contract (its own `EVAL_COMPARE_CONTRACT_VERSION`, independent
of the run record's) under `--json`, and owns the same two exit codes the other commands own — 0
success, where a difference is a finding; 2 could-not-run, for a usage error, an unreadable or
malformed record, differing corpus fingerprints without `--allow-corpus-mismatch`, or an empty
leaf (and, under the override, an empty case) intersection. The comparison reads no corpus, no
schema and no extraction internals: records only.
