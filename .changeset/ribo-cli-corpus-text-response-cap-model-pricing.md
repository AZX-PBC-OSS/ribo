---
"@azx/ribo-cli": minor
---

Three fixes from dogfooding the CLI against a folder of PDFs.

`ribo corpus text <corpus-dir> [case-id]` is a new command that prints the text each case's
prompt carries — transcript and text cases verbatim, document cases transcribed through the same
`transcribeDocumentCases` path `ribo eval` uses (one implementation, never a second pdf.js
route). With a case id it prints that case alone; without one it prints every case under a
per-case header; `--json` emits a versioned document of `{caseId, kind, text}` entries. It makes
no model call and needs no credential, and it owns the same two exit codes (0 success, 2
could-not-run). It is a `corpus` command group rather than an `eval` flag because it reads a
corpus without running anything — the same reason `schema` is a group beside `eval`.

`ribo eval --response-cap` with a CLI backend (`claude-cli`, `codex-cli`) is now refused up
front — exit 2, naming the flag and the backend and saying to drop the flag, before the
preflight, the corpus load and any model call. A CLI cannot cap generated tokens, and the
capability is read from the transport's own descriptor, the same source `cliChat`'s own refusal
reads, never a second hard-coded list. Behaviour without `--response-cap`, and with it on
`openai-compatible`, is unchanged.

The spend estimate now prices the run's `--model`. The price table gains dated per-model rows
keyed by backend and model id for the models the help and docs mention, each with a source and a
`pricedOn` date; a model with no row falls back to the backend's reference row, and the printed
estimate says it fell back and names the reference it used — a model is never silently priced.
The estimate remains an upper bound.
