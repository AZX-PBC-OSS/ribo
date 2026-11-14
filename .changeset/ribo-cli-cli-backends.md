---
"@azx/ribo-cli": patch
---

The CLI-backed chat transport is now part of this package's public API. `cliChat` — with its `CliChatOptions`, `CliBackendName` and `CliShapeResult` types — moves here from the Snugg adapter's unpublished acceptance tree, where it was unreachable to a consumer; it shells the operator's own installed `claude` or `codex` binary, under the operator's own login, with no credential. `ajv` becomes a runtime dependency of this package, bundled into the single-file bin.

`ribo eval --backend` now accepts `claude-cli` and `codex-cli` beside `openai-compatible`, and an unrecognised value is a usage error naming the three accepted ones. The two CLI backends need no credential: `OPENAI_API_KEY` is required by `openai-compatible` only. Before a CLI run starts, the command preflights the binary with `<binary> --version` and refuses up front — exit 2, a diagnostic naming the binary and the fix — when it is missing or does not answer, so a missing binary is never reported as a corpus fault or as a run in which every case failed. The run's report and every case's usage now name the backend that produced them.
