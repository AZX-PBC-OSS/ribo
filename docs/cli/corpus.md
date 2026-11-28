# The corpus format

A corpus is a directory. Its root holds a manifest and a schema; each case is one subdirectory.
There is no index file and no database: the directory listing is the corpus, so a corpus is
reviewed, diffed and version-controlled as ordinary files.

This page walks the worked example the package ships at
`node_modules/@azx/ribo-cli/examples/basic-corpus` (in the repository:
`packages/ribo-cli/examples/basic-corpus`). Every file shown below is that committed file, included
verbatim.

A corpus can also be drafted for you: `ribo schema init --corpus` scaffolds one around your own
samples, with the same shape this page documents (see
[Planning and authoring](/cli/planning)).

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
    `capturedAt`. For a case scaffolded by `ribo schema init`, it means when the file entered
    the corpus: the instant init ran, or the `--captured-at` value it was given — and neither
    scoring nor the run record's freshness fingerprint reads it. For a case you add later, hand
    write the block yourself: set `capturedAt` to the moment that meaning holds for your corpus
    and `pageCount` to the PDF's real page count — init measures and stamps bare PDFs at load
    time, but the loader never fabricates a block for an existing case folder.
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

### Proposals and review state

An entry may also record **who proposed it and whether anyone has reviewed it** (ADR
[0049](/adr/0049-expectations-may-be-proposed-and-are-scored-only-once-reviewed)). A
proposal-bearing entry carries two members **together** — `proposal` and `review`; either
without the other is refused, naming the leaf. An entry with neither is hand-written.

- `proposal` — what the model proposed, never edited after the fact: the proposing `backend`
  and `model`, the `proposedAt` instant, the proposed `status`, and — for an asserted proposal —
  the proposed `value` and its `evidence`. Evidence is one quote-plus-input for a scalar leaf,
  and an ordinal-keyed map of them for a collection leaf; the loader refuses evidence naming an
  input the case does not declare, and the wrong shape for the leaf. A proposed absence carries
  no value and no evidence — a claim of silence has none to show. A proposal never carries
  `alternatives`: an alternative on a proposal-bearing entry is an addition, and the reviewer's.
- `review` — `"pending"` or `"confirmed"`. A pending proposal is not an expectation: eval will
  not judge it, and it enters an expectation only by a reviewer's act. Reviewing means editing
  the entry's own `status`, `value` and `alternatives` and then confirming — a correction is an
  edit plus `"review": "confirmed"`. Code classifies a confirmed entry as **accepted-unchanged**
  (the entry equals the proposal: same status, same value under the scorer's own fold, no
  alternatives) or **corrected** (any added alternative, value change or status change).

Both members are part of the **corpus fingerprint** — see [scoring](/cli/scoring) — because
review state decides which cells are judged and provenance decides how the totals may be read.

**Scoped defaults** are the blanket statement — "everything under this scope was absent":

<<< @/../packages/ribo-cli/examples/basic-corpus/follow-up-letter/case.json

A `scope` is a path prefix matched at segment boundaries (`"upgrades"` covers
`upgrades.measure`, never `upgradesOld`); the special scope `"*"` covers every leaf; an array of
strings is a set of prefixes — each scope string once per case. A default's status is
`"declared-absent"` or `"unmentioned"`, with the same optional `sourceSpan`. Precedence is fixed:
an explicit entry in `expected` always wins; among covering defaults the longest scope wins; a
leaf covered by neither is unmentioned.

## Proposing expected answers: `ribo corpus propose`

Hand-writing every entry is one path. The other is a proposal pass:

```bash
ribo corpus propose ./corpora/workshop --backend openai-compatible --model gpt-4o
```

The command works on any existing corpus — a freshly scaffolded one, a hand-built one, or one
whose schema just changed. For every selected case, each schema leaf with **no explicit entry and
no covering default** gets a pending proposal: a value with evidence grounded in one of the
case's inputs, or a proposed absence. One model call is made per case that has such leaves —
none at all for a case whose every leaf is already answered, so a rerun after a complete pass is
free.

- **Case selection.** With no case ids, every case is proposed. With ids, each named case is
  selected once, in corpus order; an unknown id is refused naming the cases the corpus holds,
  before any transcription or spend.
- **The text path is the shared one.** The proposal prompt carries exactly the text `ribo eval`
  and `ribo corpus text` send — document inputs transcribed through the same pdf.js path, then
  joined by the same rule. The prompt's case text is byte-identical to what `ribo corpus text`
  prints for the case.
- **Evidence is verified, not claimed.** Every proposed value carries a quote, and code — not the
  model — matches that quote against each of the case's inputs under that input's own rule (exact
  for text and transcript inputs, the layout fold for documents). The earliest matching input in
  declared order is recorded as the evidence's input. A quote that matches no input is dropped,
  and the leaf is named in the report.
- **Nothing is silently skipped.** Every asked leaf ends the round either written (a pending
  value or a pending proposed absence) or named in the report's `unproposed` list with the reason
  it remains unanswered. One bad quote among a hundred values drops only its own leaf.
- **Writes are additive, in place and atomic.** Each case's `case.json` is edited as soon as its
  round validates, and only its `expected` map gains keys — every existing entry, covering
  default, input and member survives untouched, and publication is a temp file then a rename, so
  an interrupted write never leaves a half-written case. The corpus is your working tree: review,
  diff and commit the result as ordinary files.
- **A failed case keeps the paid work.** Cases are processed in order; one case's unparseable or
  failed round is a `failed` entry in the report and does not prevent the later cases from being
  proposed and written. A fault that stops the run itself (an unreadable corpus, a refused spend,
  a case file that cannot be written) exits 2 with empty stdout; cases already written stay
  written.
- **Spend.** The estimate is the sum of per-case upper bounds, each priced on that case's own
  measured prompt — see [spend](/cli/spend). `--max-spend` and `--yes` behave as on schema init;
  an over-ceiling run makes no request and writes nothing. A ceiling is per invocation: chunking
  the corpus spends up to the ceiling per chunk.
- **`--only <scope>`** (repeatable) narrows the leaves asked, matched at segment boundaries like
  a default's scope — the way through for a schema too large for one reply. A scope that covers
  no unanswered leaf is legal and proposes nothing. Rerunning with a new scope picks up exactly
  the leaves the new scopes cover that are still unanswered.

stdout is one versioned JSON report — one entry per selected case, in corpus order, each `proposed`
(a parsed round completed; `proposed` lists the keys this run wrote), `nothing-to-propose`, or
`failed` (with a reason and every asked leaf in `unproposed`). stderr carries the estimate and,
on completion, the handoff: **a pending proposal is not a reviewed expectation** — eval will not
judge it. Review it, correct it if the model was wrong, and confirm it (`review: "confirmed"`),
then run eval as usual. The exit code is 0 when the run completed (a failed case is a report
entry, not a failure of the command) and 2 when it could not run.

## Reviewing proposed answers: `ribo corpus review`

The other half of the proposal pass. One command shows every pending proposal with its evidence
and records the reviewer's decision — and with no action flag it is read-only, free, and makes no
model call:

```bash
ribo corpus review ./corpora/workshop            # every case's pending sheet
ribo corpus review ./corpora/workshop service-sheet
```

The sheet prints, per case, every pending proposal's **value, quote and input** — the quote
re-verified against the case's current inputs (`grounded`) and the value marked `literal` when
the value itself occurs in its quote. Collections render **row-major**: one row per instance
ordinal, each row carrying its leaves' cells, and a leaf that says nothing about a row shows the
cell as missing. Proposed absences sit in their own block, because a claim of silence has no
evidence to show. `--json` emits the same sheet as one versioned document.

A decision needs a **case id** and **exactly one action**. A decision on a leaf with no pending
proposal — already confirmed, or hand-written — is refused by name, stdout stays empty, and the
exit code is 2:

- **Confirm — `--confirm`, optionally narrowed by repeatable `--leaf <path>`.** A whole-case
  confirm deliberately confirms only entries whose every value is literal in a still-grounded
  quote: proposed absences and non-literal values stay pending, and the command prints what it
  left pending and why. The friction is the point — the trial's failure was exactly a false
  "absent", and silence is the one claim the sheet cannot show evidence for. Name those entries
  with `--leaf` once you have judged them yourself.
- **Correct, then confirm.** A correction is an edit to the entry's `value` in `case.json` — a
  JSON value on a command line is unwritable — followed by `--confirm --leaf <path>`. Code then
  classifies the entry as **corrected** rather than accepted-unchanged, and the run record says
  so.
- **Mark absent — `--mark-absent --leaf <path>`.** Sets the entry `declared-absent` and confirms
  it: the reviewer's own claim of silence, riding beside the untouched proposal.
- **Reject — `--reject --leaf <path>`.** Removes the pending explicit entry, so the leaf resolves
  exactly as the corpus otherwise would — through a covering default if one exists, else
  unmentioned. Reject never edits a default and never writes an explicit unmentioned entry.

The `proposal` block is never modified by any decision — it is the record of what the model
proposed, which is what lets a reader of a run record tell accepted-unchanged from corrected.
Removing it by hand defeats the record's honesty; the honest path is cheaper than the dishonest
one.

Every write goes through the same guarded writer propose uses: only the case's `expected` map
changes, every other member and key order survives, and publication is a temp file then a rename,
so an interrupted write never leaves a half-written case.

**An agent can be the reviewer.** The `--json` sheet is the input an agent reads; the docs tell
it to check each proposed absence against `ribo corpus text <corpus-dir> <case-id>` — the
combined text is what a claim of silence must be true about — and then to drive the same flags a
human would. The backstop is the run record's accepted-unchanged count: an entry proposed and
confirmed by the same model is counted, and stderr says so on every eval run over it.

The package ships a worked example holding proposals in every state — pending, confirmed
unchanged, confirmed corrected, and a pending absence — at
`node_modules/@azx/ribo-cli/examples/proposed-corpus` (in the repository:
`packages/ribo-cli/examples/proposed-corpus`). It is a reading example for this section, not an
eval target. Its case file:

<<< @/../packages/ribo-cli/examples/proposed-corpus/attic-report/case.json

and the input every quote grounds in:

<<< @/../packages/ribo-cli/examples/proposed-corpus/attic-report/input.txt

## When a case's inputs disagree

A multi-input case can hold inputs that disagree — two transcripts giving different floor areas, a
note and a worksheet naming different dates. An `asserted` entry still names exactly one value, so
a disagreement needs an authoring decision. Three, each using a feature this page already
documents:

- **`alternatives`.** List each input's answer on the one expectation: a run producing any one is
  `correct`. Use this when the case genuinely accepts either answer.
- **Name the authoritative input.** When one input should win, say so where the model reads it —
  an instruction (the manifest's `prompt.instructions`, or a group's entry in
  `prompt.groupInstructions`) or the leaf's schema `description` — naming the authoritative input
  by its **marker id** (the `id:I` in its `===== CAPTURE … =====` marker, the file name the case
  declares), stating the asserted value there, and quoting it in the expectation's `sourceSpan`
  for the human reader.
- **Two leaves.** When the disagreement is itself the answer, give each input's claim its own leaf
  in the schema and assert both.

Whichever you choose, do not leave the leaf silently unmentioned: an unmentioned leaf is judged in
no denominator, so a disagreement papered over with silence never scores — and `compare` can
never see it either.

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

## What `ribo schema init` scaffolds

`ribo schema init --corpus <dir>` accepts three kinds of sample: a direct text file (the transcript
or text the draft will be evidence for), a plain folder of input files, or an existing corpus case
folder with any number of
declared inputs. A plain folder without `case.json` loads as one case named after the directory —
its `.pdf`, `.txt` and `.md` files in byte-wise file-name order, the order init prints to stderr
and writes into the scaffolded `case.json`'s `inputs` list, where you can change it. The scaffold it
publishes is an ordinary corpus of the shape this page walks — a
`manifest.json` carrying the `--corpus-name` and `--corpus-provenance` you passed, the drafted
`schema.json` byte-identical to what stdout carried, and one case directory per sample with every
declared input's exact bytes, in the case's declared order (a document input keeps its declared
`capture` block).

Two things the scaffold deliberately does not contain: `expected` maps and instructions. Both stay
**empty** — a draft never invents expected answers or prompt wording, because expectations are the
author's judgement, not the model's. Publication is all-or-nothing and the output is never
overwritten: the scaffold is staged and renamed into a path that did not exist, a fault midway
removes every partial survivor, and an existing destination is refused with nothing touched.

Read any case's text the way the model will receive it — `ribo corpus text <corpus-dir>
[case-id]` — before writing its expectations. Every case prints its combined text — inputs in
list order, capture markers included when they are on; document inputs transcribed, through the
same path `ribo eval` uses, with no model call and no credential. That is the handoff in order:
scaffold, then corpus text, then expectations — the text is what an expectation is checked against,
so it is read before anything is asserted. The expectations themselves can be hand-written, or
drafted by `ribo corpus propose` and reviewed with `ribo corpus review` — see
[the proposal pass](#proposing-expected-answers-ribo-corpus-propose) and
[reviewing proposed answers](#reviewing-proposed-answers-ribo-corpus-review) above.
