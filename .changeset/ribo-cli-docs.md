---
"@azx/ribo-cli": patch
---

Ship a README in the `@azx/ribo-cli` tarball — self-sufficient for someone with only the installed package: what the CLI is for, install and invoke (with the warning that `npx ribo` resolves an unrelated npm package), every command with its exit codes, and a documents-to-scores walkthrough over the worked example corpus the package now also ships under `examples/basic-corpus/`. Every command's `--help` now ends with a pointer to the new CLI section of the docs site (`/cli/` — overview, schema dialect, corpus format, scoring, spend). No behaviour change to any command.
