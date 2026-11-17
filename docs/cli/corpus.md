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
- `provenance` — the corpus's declaration about itself: `"real"` or `"synthetic"`. A declaration,
  not a finding; a synthetic corpus is not a weaker one, and a reader comparing two runs must be
  able to see which they are.
- `prompt.instructions` — the system instructions, passed verbatim to the extraction target. The
  optional `prompt.examples` (few-shot turn pairs: a `transcript` and the flat dotted-path `fields`
  it yields), `prompt.fieldDescriptions` (`"schema"` or `"prompt"` — where the field guidance
  travels) and `prompt.groupInstructions` (a map from a group key to the instructions that
  **replace** the main ones for that group's calls; a key naming no group of the schema is
  refused) change the prompt, and therefore what the run measures.
- `description` — free text for a human reader. Nothing reads it.

## The schema

The example's schema — one group per subject, one collection, one enum, nullable leaves, every
leaf described:

<<< @/../packages/ribo-cli/examples/basic-corpus/schema.json

## A case directory

Each case is one subdirectory named with a stable id, holding **`case.json` plus exactly one input
file**. The file's name follows from the kind, stated once in the case file: `input.txt` for the
`transcript` and `text` kinds, `input.pdf` for a `document` case. A case holding both is refused,
and so is a case holding neither — a case has exactly one input file today.

A `document` case's PDF needs a **text layer**: the document is transcribed locally through pdf.js
before the run starts, and a scan without a text layer refuses the run, naming the case, before
any model call. A document case also declares a `capture` block (`capturedAt`, `pageCount`) — the
corpus declares what was captured; the loader never fabricates it.

The `case.json` fields:

- `id` — must equal the directory's name. A mismatch is a refusal, not a silent correction.
- `kind` — `"transcript"`, `"text"` or `"document"`. The kinds differ in how the input reaches the
  model, never in how the answer is judged.
- `expected` — the expected answer, a **sparse map** from dotted leaf path to an expectation
  entry. The keys are the flat leaf paths the schema declares (`heating.fuel`; a collection's leaf
  is addressed once, element-relative: `upgrades.measure`).
- `defaults` — optional scoped defaults (below).
- `capture` — a `document` case only; forbidden for the other kinds.

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

Read any case's text the way the model will receive it — `ribo corpus text <corpus-dir>
[case-id]` — before writing its expectations. Transcript and text cases print verbatim; document
cases print transcribed, through the same path `ribo eval` uses, with no model call and no
credential.
