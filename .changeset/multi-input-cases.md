---
"@azx/ribo-cli": minor
"@azx/ribo-adapter-snuggpro": patch
---

A corpus case now declares its input files as a non-empty, ordered `inputs` list (each entry
`{ file, kind }`, with a `capture` block on a document entry), joined into one text by core's
transcript combiner and extracted once against the corpus's schema. **This is a breaking corpus
format migration**: the old case-level `kind` with its implied single `input.txt`/`input.pdf` is
refused, not auto-migrated, and every case must declare `inputs`. Capture markers
(`===== CAPTURE seq:N kind:K id:I =====`) are prefixed to every input by default — one-input
cases included — which changes the model-facing text and the corpus fingerprint of every
migrated corpus; set `"combine": { "markCaptures": false }` in `manifest.json` (the option lives
there, never on the CLI, because it changes what the model reads and so is corpus identity) to
join with a single space and no markers. The corpus fingerprint now covers every input's bytes
in list order plus the effective `markCaptures`, so reordering inputs or flipping the option
stales a record. `ribo corpus text --json` emits contract version 2 with `{ caseId, text }`
entries — a mixed-kind case has no singular kind — and the multi-case headers dropped the
parenthesized kind for the same reason. The Snugg acceptance corpus is migrated to the new
shape (its published adapter API is unchanged).
