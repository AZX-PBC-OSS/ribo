---
"@azx/ribo-cli": minor
---

`ribo eval` — the command surface over the eval runner (design §6). It parses the run's flags into
the settings object the runner takes, loads the corpus through the only loader that validates it,
drives the run against the openai-compatible backend and writes the run's report to stdout.

The flags are `--corpus <dir>`, `--backend <name>` (only `openai-compatible` today), the required
`--model <id>`, the repeatable `--strategy <ids>` and `--out <dir>`, plus the run-settings flags
`--consensus <n>`, `--consensus-arbiter <policy>`, `--max-retries <n>`, `--response-cap <n>` and the
split caps `--max-nullable-unions-per-group <n>` and `--max-serialized-chars-per-group <n>` — the
split caps reuse `ribo schema inspect`'s own flag spellings and its `parseCap` parser, so a bad
cap value is refused the same way in both commands. One `--strategy` occurrence is one arm; a
comma-separated value is that arm's ordered fallback ladder (`--strategy single-shot,per-group`).
An absent flag is not forwarded, so the strategies' own defaults stand and the bin copies no table
of defaults into the settings it builds. There is no `--schema` flag: the corpus manifest's schema
reference is the only schema source.

The command owns exactly two exit codes — 0 success, 2 could-not-run (a usage error, an unreadable
corpus, an invalid setting, a missing credential) — with the diagnostic on stderr naming which and
stdout empty on every exit-2 path. The endpoint and the credential come from the environment
(`OPENAI_BASE_URL`, `OPENAI_API_KEY`); no credential-bearing option exists, and none may. A case
whose extraction failed is report content, not an exit code. The report's shape is provisional
until the scored contract and the run records land.
