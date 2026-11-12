---
"@azx/ribo-cli": minor
---

The `ribo schema inspect` command grows its command surface (design §1/§4/§5/§8): a human
rendering is the default and `--json` opts into the versioned JSON contract (byte-stable
regardless of TTY or `NO_COLOR`); `--max-depth <n>` and `--max-piece-chars <n>` drive the
report's threshold rows; a breached threshold is a new ran-and-failed-threshold exit code 1
with the full report still on stdout and a one-line breach diagnostic on stderr; usage errors
(unknown flag, surplus argument, non-integer threshold value) remap from commander's exit 1 to
exit 2, keeping the could-not-run class distinct; no path with a TTY stdin is refused with
guidance instead of a blocking read; every could-not-run message names the fault and its remedy
— the unconvertible-document message now names `z.fromJSONSchema` as the limit and points at
`docs/guide/from-a-schema.md` — and `--help` teaches the flags, examples and exit-code meanings.
