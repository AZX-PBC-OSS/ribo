---
"@azx/ribo-cli": minor
---

Two fixes from the first real Snugg baseline, whose ~300K-token prompts timed every call out —
and whose all-failed run still printed a high accuracy.

`ribo eval --timeout <seconds>` sets the per-call timeout of the CLI backends (`claude-cli`,
`codex-cli`), passed through `createCliBackendChat` to `cliChat`'s `timeoutMs`. The eval
command's CLI-backend default rises from 120 s to 600 s; `cliChat`'s own default and the
playground's `CLI_TIMEOUT_MS` are deliberately unchanged — they are the transport's and the dev
server's knobs, not the eval command's. A non-positive or non-numeric value is a usage refusal
(exit 2) naming the flag, and on `openai-compatible` the flag is refused up front — the HTTP
transport has no per-call timeout to set — the mirror of `--response-cap`'s refusal on the CLI
backends. The timeout error message names `--timeout` as the fix.

A failed case no longer earns credit for silence: its declared-absent leaves are judged `missed`
(they were `correct`), so every judged cell of a failed case stays in accuracy-over-all's
denominator and never in its numerator, and a run where every case failed scores
`accuracyOverAll` 0 instead of reading as accurate. Extracted cases score exactly as before. The
record schema's shape is unchanged and `contractVersion` stays 1: no field's name or meaning
changed — only the verdict a failed case's silent absence earns.
