---
"@azx/ribo-cli": minor
---

`ribo schema init` now loads a case folder with any number of declared inputs as one sample, in
the case's declared order — the multi-input corpus format ADR 0042 made standard, which init
previously refused. A sample's text is the same marked join eval's `caseTextOf` produces, from
one shared join function in `eval/case-text.ts`, so init drafts from exactly the text eval runs.
**This breaks the `SchemaInitSample` shape**: the singular `source` (with its `file`, `bytes` and
`capture`) and sample-level `kind` are replaced by an ordered `inputs` list, each entry carrying
`file`, `kind`, `text`, `bytes` and an optional `capture`; `SchemaInitSampleSource` is removed and
`SchemaInitSampleInput` is exported in its place. Evidence is matched per input under that
input's own rule — exact for text and transcript inputs, the layout fold for documents — so a
quote is accepted when any one input matches it, never against the joined text, never across
inputs, and never on a capture marker line. A duplicate declared input file is refused before
transcription, the same way the corpus loader refuses one. The scaffold writes every input in
order, each document with its own capture block, and publication stays one all-or-nothing rename.
