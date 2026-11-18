# The corpus format

A corpus is a directory. Its root holds a manifest and a schema; each case is one subdirectory.
There is no index file and no database: the directory listing is the corpus, so a corpus is
reviewed, diffed and version-controlled as ordinary files.

This page walks the worked example the package ships at
`node_modules/@azx/ribo-cli/examples/basic-corpus` (in the repository:
`packages/ribo-cli/examples/basic-corpus`). Every file shown below is that committed file, included
verbatim.

## The manifest

`manifest.json` declares what the corpus is:

<<< @/../packages/ribo-cli/examples/basic-corpus/manifest.json

- `name` — names the corpus in reports and records.
- `schema` — a path, relative to the corpus root, to the JSON Schema document. It is the corpus's
  **only** schema source; there is no `--schema` flag, so two corpora over different schemas are
  different corpora. The document faces the same dialect rules and the same refusals as
  [`ribo schema inspect`](/cli/schema).
- `provenance` — the corpus's declaration about itself, and the only valid values are `"real"`
  and `"synthetic"`. A declaration, not a finding; a synthetic corpus is not a weaker one, and a
  reader comparing two runs must be able to see which they are. Any other value is a refusal that
  names the pair and the value the file carried.
- `prompt.instructions` — the system instructions, passed verbatim to the extraction target. The
  optional `prompt.examples` (few-shot turn pairs: a `transcript` and the flat dotted-path `fields`
  it yields), `prompt.fieldDescriptions` (`"schema"` or `"prompt"` — where the field guidance
  travels) and `prompt.groupInstructions` (a map from a group key to the instructions that
  **replace** the main ones for that group's calls; a key naming no group of the schema is
  refused) change the prompt, and therefore what the run measures.
- `combine` — optional, and the ONLY place the joining options live. One member today:
  `markCaptures` (a boolean, defaulting to `true`) — whether each input is prefixed with a
  `===== CAPTURE … =====` marker before the inputs are joined. The option changes what the model
  reads, so it is part of the corpus's identity, not a CLI flag; there is no command-line
  override.
- `description` — free text for a human reader. Nothing reads it.

## The schema

The example's schema — one group per subject, one collection, one enum, nullable leaves, every
leaf described:

<<< @/../packages/ribo-cli/examples/basic-corpus/schema.json

## A case directory

Each case is one subdirectory named with a stable id, holding **`case.json` plus its input
files**. The case file declares its inputs as a non-empty, ordered `inputs` list; each entry is:

- `file` — the input file's name, directly inside the case folder. A name carrying a path
  separator (`/` or `\\`), an absolute path, or `.`/`..` is refused — an input may not escape
  the case directory — and so is a name declared twice in one case or one that does not exist.
  Other files in the folder are simply ignored: the list is authoritative.
- `kind` — `"transcript"`, `"text"` or `"document"`. The kinds differ in how the input reaches
  the model, never in how the answer is judged.
- `capture` — a **`document` entry only** (required there, forbidden on the other kinds): the
  corpus declares what was captured; the loader never fabricates it, and a document entry
  missing the block is refused with both field names in the message. The two fields:

  - `capturedAt` — when the document was captured, as an ISO 8601 datetime string. It is
    provenance metadata: the loader assembles it into the capture record the transcriber
    receives, and **no part of scoring reads it** — no verdict or rate ever turns on
    `capturedAt`.
  - `pageCount` — how many pages the document has, as the corpus declares it. It completes the
    capture record the transcriber is handed.

A case may declare **one input or many**. Every declared input is read in list order — a
`transcript` or `text` entry as the file's exact UTF-8 text, a `document` entry transcribed
locally through pdf.js (once per run, shared by every arm; the PDF needs a **text layer**, and
a scan without one refuses the run, naming the case and the file, before any model call) — and
the texts are then joined into **one** combined text by the same joining rule the storage relay
uses: each part prefixed with `\n===== CAPTURE seq:N kind:K id:I =====\n` (`seq` is the 1-based
position in the `inputs` list, `kind` the entry's kind, `id` the entry's file name) and
concatenated, or — with `"combine": { "markCaptures": false }` — joined with a single space and
no markers. Markers are **on by default, for one input as well as many**; `ribo corpus text`
prints the combined text exactly as the model reads it, markers included.

One case is still one extraction and one score: the combined text is extracted against the
corpus's one schema, and the result is judged once against the case's `expected`. No per-input
schema, answer or result exists.

The `case.json` fields:

- `id` — must equal the directory's name. A mismatch is a refusal, not a silent correction.
- `inputs` — the non-empty, ordered list of entries described above. The old single-input shape
  (a case-level `kind` with one implied `input.txt`/`input.pdf`) is retired: a case still using
  it is refused with a message naming `inputs`, not silently migrated.
- `expected` — the expected answer, a **sparse map** from dotted leaf path to an expectation
  entry. The keys are the flat leaf paths the schema declares (`heating.fuel`; a collection's
  leaf is addressed once, element-relative: `upgrades.measure`).
- `defaults` — optional scoped defaults (below).

## The expected answers

An expectation entry is discriminated on its `status`:

- **`asserted`** — the leaf is expected to carry `value`: a string, a number, a boolean, or an
  object for a collection leaf. `alternatives` lists other acceptable values; a run producing any
  one is correct. `sourceSpan` quotes the verbatim span that supports the expectation — optional,
  never scored, carried into the record for a reader.
- **`declared-absent`** — the input says nothing for this leaf, so the run should produce no value
  (an explicit `value` here is refused). On a **nullable** leaf this is the pairing that matters:
  `nullable` says the schema can hold "no value"; `declared-absent` says this case expects exactly
  that. A run that fills the leaf anyway is `hallucinated`, not "wrong".

A leaf with no entry and no covering default is **unmentioned**: not judged, in no denominator,
neither right nor wrong. The sparse map is the point — a case states what it knows about and stays
silent about the rest.

A **collection** leaf's value is an ordinal-keyed object: `{ "0": ..., "1": ... }` — one key per
expected instance, in order. A run that produces extra instances is wrong, not almost right.

**Scoped defaults** are the blanket statement — "everything under this scope was absent":

<<< @/../packages/ribo-cli/examples/basic-corpus/follow-up-letter/case.json

A `scope` is a path prefix matched at segment boundaries (`"upgrades"` covers
`upgrades.measure`, never `upgradesOld`); the special scope `"*"` covers every leaf; an array of
strings is a set of prefixes — each scope string once per case. A default's status is
`"declared-absent"` or `"unmentioned"`, with the same optional `sourceSpan`. Precedence is fixed:
an explicit entry in `expected` always wins; among covering defaults the longest scope wins; a
leaf covered by neither is unmentioned.

## The example's cases, end to end

`morning-visit` — a transcript case asserting every leaf of one group, declaring one leaf absent
with its span, and answering the collection by ordinal:

<<< @/../packages/ribo-cli/examples/basic-corpus/morning-visit/input.txt

<<< @/../packages/ribo-cli/examples/basic-corpus/morning-visit/case.json

`voicemail` — the sparse map's point: two leaves asserted, silence about everything else, and
nothing scored that the case did not claim:

<<< @/../packages/ribo-cli/examples/basic-corpus/voicemail/case.json

`service-sheet` — a **two-input** case: a one-page worksheet PDF with a text layer, then a text
note. The sheet says nothing the schema asks about, so the case declares every leaf absent
through one `"*"` default, with `heating.servicedAt` also named explicitly — and its first input
carries the `capture` block every document entry declares. With markers on (the default), the
case's combined text is the PDF's transcription under its `seq:1 kind:document id:input.pdf`
marker followed by the note under its `seq:2 kind:text id:site-note.txt` marker:

<<< @/../packages/ribo-cli/examples/basic-corpus/service-sheet/case.json

The second input's note:

<<< @/../packages/ribo-cli/examples/basic-corpus/service-sheet/site-note.txt

Read any case's text the way the model will receive it — `ribo corpus text <corpus-dir>
[case-id]` — before writing its expectations. Every case prints its combined text — inputs in
list order, capture markers included when they are on; document inputs transcribed, through the
same path `ribo eval` uses, with no model call and no credential.
