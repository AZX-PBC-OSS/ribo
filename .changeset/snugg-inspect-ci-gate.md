---
---

CI now gates the Snugg schema through the user-facing command: a new `snugg:inspect` stage in `./check.sh` runs the built `ribo schema inspect` bin against the adapter's generated `extraction.schema.json` with the route's caps pinned on the stage line, failing the build on a threshold breach, a dropped cap argument, a missing build artifact, or a drift in the command's `--json` report contract. `docs/guide/from-a-schema.md` gains a section on sizing a shipped file — resolving it through the package's export subpath and reading the command's exit codes for a consumer's own CI. No release: no publishable package's artifact changes.
