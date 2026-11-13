# Design: `ribo eval` — a corpus-driven extraction-accuracy harness

Status: Draft — the Tier 2 build tickets (T7b, T8, T9a, T9b, T10, T12, T13a, T13b, T14a, T14b and
T16) implement this document; ADR 0041 ratifies the run-record format and its freshness identity.

Extraction quality is measurable only today through one Snugg-hardwired gate:
`packages/ribo-adapter-snuggpro/acceptance/gate.manual.ts`. That gate is real and it works, but it
answers one question about one schema against one backend family: its corpus is a directory of
Snugg transcripts, its scorer is a spike script written against Snugg's vocabulary, its schema is
the adapter's own fixture, and its record format carries Snugg's verdicts. A second host tool, a
second corpus, or a second schema cannot be measured through it without copying it.

This design replaces that gate with a generic harness and keeps the gate as one consumer of it. The
pieces are: a **corpus** — a directory of cases with a manifest, in any vocabulary; a **scorer** that
judges a run's per-leaf answers against a case's expected answer and reduces them to a taxonomy of
correct / wrong / missed / hallucinated; a **spend guard** that refuses a run whose worst case costs
more than the operator allows; a **run record** — a versioned JSON document written per run, whose
freshness is decided by an identity of four fields; and a **compare** command that lines two records
up and reports the differences as axes. The command surface is `ribo eval` and `ribo compare`, both
in `@azx/ribo-cli`.

Three rules hold everywhere in this document, and each of them is a decision rather than a
preference.

**Every number is read off a symbol the real extraction path also uses.** Call counts come from
inspect's `describeCalls`; leaf counts come from `walkFieldInventory`; the canonical JSON the
fingerprint is computed over is the one inspect's own fingerprint uses. The eval harness restates
none of them, because a restatement is a second implementation that drifts.

**The harness never spends in a test.** Every test stubs core's `ChatClient` seam; the run records
it writes are produced by stubbed clients in the suite, and a paid run is an operator action
outside acceptance (§12).

**The vocabulary belongs to the corpus, not to the scorer.** The scorer knows dotted leaf paths and
schema-declared kinds; it knows nothing about Snugg's groups, its health matrix or its enums. What
the spike scorer did with Snugg's vocabulary is either reproduced generically or retired with a
stated translation (§3) — never smuggled into the generic scorer as a special case.

## 1. The corpus directory format

A corpus is a directory. Its root holds a manifest; each case is one subdirectory. There is no
index file, no ordering file and no database: the directory listing is the corpus, so a corpus can
be reviewed, diffed and version-controlled as ordinary files.

### The manifest

`manifest.json` at the corpus root is a JSON object with these fields.

- `name` (string, required) — the corpus's name. It names the corpus in reports and records; it
  carries no meaning for scoring.
- `schema` (string, required) — a path, relative to the corpus root, to a JSON Schema document in
  the OpenAPI 3.0 form.
- `provenance` (string, required) — the corpus's declared provenance: `"real"` or `"synthetic"`. It
  is a declaration, not a finding: the harness records what the corpus says about itself and never
  guesses. A synthetic corpus is not a weaker corpus — it is a corpus whose cases were written
  rather than collected, and a reader comparing two runs must be able to see which they are.
- `prompt` (object, required) — the run's prompt inputs (below).
- `description` (string, optional) — free text for a human reader. Nothing reads it.

**The prompt inputs** are the objects core's `buildMessages`
(`packages/ribo-core/src/extraction/extraction-common.ts:113`) assembles the prompt from, and
nothing else:

- `instructions` (string, required) — the system instructions, passed verbatim to the extraction
  target.
- `examples` (array, optional) — the few-shot examples, each an object with a `transcript` (string)
  and `fields` (object). Each example becomes one user/assistant turn pair in the prompt.
- `fieldDescriptions` (string, optional) — the field-descriptions mode, core's own option
  (`fieldDescriptions` in `packages/ribo-core/src/extraction/field-guidance.ts:62`): `"schema"` (the
  default) or `"prompt"`. Under `"prompt"` the schema's field guidance joins the system prompt;
  under `"schema"` the instructions pass through unchanged. It is part of the prompt inputs because
  it changes the prompt, and therefore changes what the run measures.

**The manifest's schema reference is the only schema source.** There is no `--schema` flag, and no
later ticket may add one: a run's schema is a property of its corpus, and a flag that overrides it
would let two runs over the same corpus claim different schemas while sharing a corpus fingerprint
(§7). A corpus whose schema reference is missing, unreadable or not a JSON Schema document is
refused (§6).

The schema document is loaded through the loader `ribo schema inspect` uses — `convertDocument` in
`packages/ribo-cli/src/inspect/convert.ts` — so a corpus's schema faces the same rules and the
same loud refusal of the draft-2020-12 `anyOf`-with-null form (`refuseDraft2020Nullability` in the
same file, per ADR 0038). A corpus whose schema speaks draft-2020-12 nullability is refused, never
silently converted: nullability is the one rendering that shifts between schema dialects, and a
corpus that measured the wrong one would report numbers nobody can compare.

### Case directories

Each case is one subdirectory of the corpus root, named with a stable id — a short slug, unique
within the corpus. The id is the case's row identity: the run record's grid is keyed by it, and the
corpus fingerprint (§7) covers the cases. Renaming an id is a different corpus, not a rename of a
row.

Inside a case directory:

- `case.json` — the case's expected answer and metadata.
- the input file — `input.txt` for the `transcript` and `text` input kinds, `input.pdf` for the
  `document` input kind. Exactly one input file per case; the file's name follows from the kind, so
  the kind is stated once, in the case file.

### The case file

`case.json` is a JSON object with these fields.

- `id` (string, required) — must equal the directory's name. A mismatch is a usage error, not a
  silent correction.
- `kind` (string, required) — the input kind: `"transcript"`, `"text"` or `"document"`. A
  `transcript` is a spoken capture as plain text; a `text` input is any other written text; a
  `document` input is a document file. The three kinds differ in how the input reaches the model,
  not in how the answer is judged — see §9 for the document kind's framing.
- `expected` (object, required) — the expected answer, as a **sparse map** from dotted leaf path to
  that leaf's expectation. The map's keys are the flat dotted leaf paths the review contract
  addresses, one per schema field — the same paths `walkFieldInventory`
  (`packages/ribo-cli/src/inspect/field-inventory.ts:64`) produces.
- `defaults` (array, optional) — generic scoped defaults (below).

**An expectation entry** — the value at one dotted path inside `expected` — is an object with:

- `status` (string, required) — `"asserted"` or `"declared-absent"`.
- `value` — present when the status is `asserted`: the value the leaf is expected to carry. It is a
  string, a number, a boolean, or an object for a collection leaf. It is absent when the status is
  `declared-absent`, because a declared-absent leaf has no value to assert.
- `alternatives` (array, optional) — acceptable alternative values for this leaf. A run that
  produces any one of them is correct on this leaf; they are the corpus's way of saying "this leaf
  has more than one right answer", which a single expected value cannot express.
- `sourceSpan` (string, optional) — a verbatim span from the input that supports the expectation.
  It is optional and never scored: a case may assert a value the input supports without quoting
  the support, and the harness does not require an annotator to do bookkeeping twice. When it is
  present it is carried into the record for a reader.

**Anything not mentioned resolves to unmentioned.** A leaf with no entry in `expected`, and no
default covering it, is unmentioned: it is not judged, it contributes to no denominator, and a run
that says nothing about it is neither right nor wrong about it. This is the sparse map's whole
point — a case states what it knows about, and stays silent about the rest.

**Generic scoped defaults** are the corpus's way of saying "everything under this scope was
declared absent, and here is the blanket statement that says so". Each default is an object with:

- `scope` (string or array of strings, required) — the leaf paths it covers. A string scope is a
  path prefix; the special scope `"*"` covers every leaf. An array of strings is a set of prefixes.
- `status` (string, required) — `"declared-absent"` or `"unmentioned"`.
- `sourceSpan` (string, optional) — the verbatim span that carries the blanket statement, when the
  annotator chose to record it.

Precedence is fixed: an explicit entry in `expected` always wins over any default; among the
defaults that cover a leaf, the one with the longest matching scope wins; a leaf covered by no
default is unmentioned. The scope is a **path prefix**, never a named set baked into the scorer:
this is the mechanism that replaces the spike scorer's disclaimer policy (§3) without carrying
Snugg's vocabulary into the generic harness.

### A case, end to end

A reader can author a case from this section alone. A case directory `attic-depth/` holds
`input.txt` and a `case.json` whose `id` is `attic-depth`, whose `kind` is `transcript`, whose
`expected` maps `attic.atticInsulationDepth` to a status of `asserted` with the value `10-12` and a
`sourceSpan` of the words the inspector said, and whose `expected` leaves `attic.atticInsulation`
absent unless a default covering the `attic.` scope declares it absent. That case asserts one
leaf, declares one scope absent and says nothing about the rest of the schema.

**The corpus format carries no hazard declarations.** The four hazard checks of §3 are driven by
declarations that the caller of a check supplies — in this series, the gate wrapper of §13 — and
not by the corpus: a hazard is a fact about one tool's schema, not about a case's expected answer,
so a corpus author is never asked to declare one. §3 says where those declarations come from and
what each check does with them.

## 2. Scoring

The scorer judges one run against one case and reduces the result to a taxonomy. The taxonomy is
five verdicts — `correct`, `wrong`, `missed`, `hallucinated` and `unscorable` — and the harness
reports three rates built from them.

### What is judged

A leaf is judged when the case expects something of it: an `asserted` entry or a `declared-absent`
entry, or a default that declares it absent. A leaf the case says nothing about is unmentioned and
is not judged at all.

The verdicts follow from the expectation and what the run produced:

- **asserted** and the run produced the expected value (or one of the leaf's acceptable
  alternatives) — `correct`.
- **asserted** and the run produced a different value — `wrong`.
- **asserted** and the run produced no value — `missed`.
- **declared-absent** and the run produced no value — `correct`.
- **declared-absent** and the run produced a value — `hallucinated`.
- **not judgeable** — `unscorable`. An unmentioned leaf's cell is `unscorable`, with the reason
  `unmentioned`; so is a leaf whose expectation cannot be compared to what the schema allows (an
  enum expectation naming no member the schema declares), and a case whose input could not be read
  or whose extraction produced nothing parseable. An unscorable cell is counted in no denominator,
  and the record says why.

A run that produced a value where the case declared absence is not a "wrong" answer that happens to
be a different kind of wrong: the case said nothing happened, and the run said something did. That
distinction is the whole reason hallucination is a verdict of its own.

### The normalisation bridge

Two values are the same answer when they are the same after a fixed, declared set of folds. The
bridge is deliberately small, and every fold it applies is one the corpus can predict:

- **Case, whitespace and punctuation folding.** Two strings that differ only in letter case, in
  surrounding or repeated whitespace, or in trailing punctuation are the same string. Nothing else
  is folded: no stemming, no synonym expansion, no numeric reformatting beyond the numeric fold
  below.
- **Numeric fold.** Two numbers are the same when they are numerically equal; a spoken number and
  its digits are the same when they parse to the same number.
- **Enum members are matched against the schema's own members.** An enum leaf's answer is matched
  against the members the schema declares for that leaf, not against a hand-kept list: a case may
  expect a member, and the run's member is the same answer when the schema declares it, or when the
  schema declares a member the case lists as an acceptable alternative for that leaf. A value that
  is not a member of the schema's enum is never "close enough" — it is a wrong answer, reported as
  such, and the hazard checks of §3 see it.
- **Acceptable alternatives are honoured.** A leaf's `alternatives` are folded into the comparison
  for that leaf only, and an alternative that matches is a `correct`.

### The three rates

Every report states the answer rate **beside** the two accuracies, never one without the others,
because the three answer different questions and any two of them can be read as a contradiction
when the third is missing:

- **Answer rate** — of the judged cells, the fraction where the run produced a value at all. It
  measures coverage.
- **Accuracy over answered** — of the cells where the run produced a value, the fraction that were
  correct. It measures quality of what was said, and it is the number that ignores the misses.
- **Accuracy over all** — of the judged cells, the fraction that were correct. It measures quality
  of the whole case.

A run that answers almost nothing scores a perfect accuracy-over-answered and a poor
accuracy-over-all; a run that answers everything with the wrong value scores the reverse. The
answer rate is what tells the two apart.

## 3. The scorer boundary against the spike scorer

The spike scorer (`docs/spikes/0001-extraction-snuggpro/score.mjs`) is the measurement the current
gate reports. The generic scorer replaces it, so every behaviour of the spike scorer is either
**reproduced** generically or **retired** with a stated translation. Nothing is dropped silently,
and nothing Snugg-shaped survives in the generic scorer as a special case.

### Reproduced, generically

- **Value comparison with a normalisation fold** — the spike's own comparison folded case,
  whitespace and punctuation and compared numbers numerically; the generic bridge of §2 does the
  same and adds nothing else.
- **Enum resolution against the schema's members** — the spike resolved enum answers against the
  schema's own members (`schema-leaves.mjs`), never against a hand-kept list; the generic scorer
  does the same.
- **Acceptable alternatives honoured** — the spike's "sanctioned" soft alternatives were counted as
  a correct match; the generic scorer honours the corpus's per-leaf alternatives.
- **A missing or unparseable result scored as an empty object** — the spike's deliberate rule, so a
  run that returned nothing could not score better than a run that tried. The generic scorer holds
  it: an unreadable extraction produces real misses, never a quiet zero denominator.
- **Verbatim source spans checked against the input** — the spike classified a span as verbatim,
  near-miss or fabricated against the transcript; the generic scorer keeps the verbatim check and
  retires the finer classification.
- **The vocabulary mix of enum answers** — the spike reported how many true-correct enum matches
  came in each spelling the schema permits; the generic scorer keeps the distinction as a hazard
  finding, not as a verdict.

### Retired

- **The `health-*` verdict vocabulary.** The spike's run record carries five verdicts whose names
  are Snugg's — `health-hallucinated-pass`, `health-hallucinated-problem`, `health-clean-dropped`,
  `health-miss` and `health-wrong`, all members of the record's `CELL_VERDICTS`
  (`packages/ribo-adapter-snuggpro/acceptance/run-record.ts:28`). Their distinctions were Snugg's: a
  health test that was passed when the transcript said it was not, a problem reported where none
  was, a silently dropped clean test. The generic taxonomy does not carry them; the translation
  table below maps each of them once.
- **The disclaimer policy** (`docs/spikes/0001-extraction-snuggpro/disclaimer-policy.mjs`) — the
  closed scope vocabulary and the named leaf-sets (`healthTests`, `blowerDoor`, `shell`). The
  policy is retired; the generic mechanism that replaces it is the corpus's scoped defaults (§1),
  whose scopes are path prefixes and which live in the corpus rather than in the scorer.
- **The sanctioned / excused distinctions as verdicts** — `sanctioned` and `miss-excused` are
  Snugg's names for "an alternative was right" and "this miss was excused". The generic taxonomy
  expresses the first as a correct answer (the alternatives are honoured) and the second as a leaf
  that is not judged at all (a scoped default declared it absent).
- **The soft/hard hallucination split** — the spike distinguished a hard hallucination from a soft
  one. The generic taxonomy has one hallucination class; severity is a hazard finding (§ below),
  not a verdict.
- **The span classification vocabulary** — the spike's `verbatim` / `near-miss` / `fabricated`
  span classes. The verbatim check is kept; the two finer classes are not, because they grade how
  close a paraphrase was, which is a judgement the generic harness does not make. A span that is not
  verbatim is a span that is not supported, and the corpus's own `sourceSpan` (optional, never
  scored) is what a reader compares against.
- **The band and axis hand-kept tables** — the spike kept two small tables by hand
  (`BAND_LEAVES`, `AXIS_PAIRS`), because "this enum's members form an ordered band" and "these two
  leaves are one thing's two axes" are not visible in a schema's shape. The generic harness
  derives what it can from the schema and takes the rest from the caller's declarations; it never
  carries Snugg's tables.

### The translation table

Each retired verdict maps into the generic taxonomy exactly once.

| Spike verdict                 | Generic verdict | Note                                                                                                                                           |
| ----------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `correct`                     | `correct`       | reproduced                                                                                                                                     |
| `correct-null`                | `correct`       | a null answer to a null expectation is a correct null; the distinction the Snugg grid kept is retired                                          |
| `wrong`                       | `wrong`         | reproduced                                                                                                                                     |
| `miss`                        | `missed`        | reproduced                                                                                                                                     |
| `miss-excused`                | `unscorable`    | the excuse itself is retired with the disclaimer policy; a leaf a scoped default declares absent is not judged, so it counts in no denominator |
| `hallucination`               | `hallucinated`  | reproduced                                                                                                                                     |
| `hallucination-soft`          | `hallucinated`  | the soft/hard split is retired; severity is a hazard finding                                                                                   |
| `sanctioned`                  | `correct`       | an acceptable alternative is a correct answer                                                                                                  |
| `unscorable`                  | `unscorable`    | reproduced                                                                                                                                     |
| `health-hallucinated-pass`    | `hallucinated`  | retired; the health vocabulary is Snugg's                                                                                                      |
| `health-hallucinated-problem` | `hallucinated`  | retired; the health vocabulary is Snugg's                                                                                                      |
| `health-clean-dropped`        | `missed`        | retired; the health vocabulary is Snugg's                                                                                                      |
| `health-miss`                 | `missed`        | retired; the health vocabulary is Snugg's                                                                                                      |
| `health-wrong`                | `wrong`         | retired; the health vocabulary is Snugg's                                                                                                      |

### The four Snugg hazards, computed generically

The Snugg adapter's schema names four hazards it exists to get right (the header of
`packages/ribo-adapter-snuggpro/src/schema.ts:59`): fuel is a separate axis from equipment;
attic insulation is a depth band and also an R-value; the health and safety state is a fixed-state
matrix; and equipment efficiency is looked up rather than dictated. The generic harness computes
each of them as a **deterministic check over the per-cell results and the raw extraction output** —
no model call, no judgement, the same answer every time from the same record.

The checks share one rule: **what they read is the schema's own kinds plus the declarations the
caller supplies**, never a vocabulary baked into the scorer. The declarations name the leaves each
hazard concerns — the axis pair, the band and its quantity, the fixed-state matrix, the looked-up
leaf and its exceptions — and they are **not corpus fields** (§1): a hazard is a fact about one
tool's schema rather than about a case's expected answer, so a corpus author is never asked to
declare one. In this series the caller is the gate wrapper (§13), which supplies the declarations;
the harness applies the generic rule to whatever it is handed.

- **Axis fusion.** Two leaves the declarations name as one thing's separate axes must not carry one
  another's content. The check compares the two leaves' asserted values in the raw extraction
  output: if one leaf's asserted value contains the other leaf's asserted value as a token, the
  axes were fused and the check fires.
- **Band and value conflation.** Two leaves the declarations name as one thing's band and its
  quantity must not be converted into one another. The check reads the schema's own kinds for the
  pair: the band leaf's declared members and the quantity leaf's declared type, and compares the
  quantity the run produced against the numbers the band names. A quantity equal to a number the
  band names is a conversion and the check fires.
- **Fixed-state matrix.** Where the declarations name a set of leaves as one fixed-state matrix,
  every leaf in it must carry either a member of its own schema or nothing at all. The check is over
  the per-cell results: a cell in that set whose verdict is `hallucinated` is a matrix violation, and
  so is a cell whose value is not a member of the leaf's schema.
- **Looked-up value dictated.** Where the declarations name a leaf as one the operator looks up
  rather than captures, a run must not supply a value for it — with the declarations naming the
  exceptions. The check is over the raw extraction output and the per-cell results: a declared
  looked-up leaf with a `correct` or `wrong` verdict fires the check, and a captured leaf whose
  asserted value has no verbatim support in the input fires it too.

Each check reports a count and the cells it fired on, and the four counts travel with the record as
the optional hazard extension (§4) — present when the run's caller supplied the declarations the
checks need, and absent when it did not. The section (13) gate wrapper consumes them.

## 4. The versioned run-record JSON

A run writes one record: a versioned JSON document describing what was run, what it produced and
under which conditions. The record is a persisted artefact crossing a trust boundary — a
hand-edited file, a half-written line, an artefact from an older format — so it is **zod-parsed on
read, never cast**.

### The skeleton's fields

- `contractVersion` — the record format's own version, owned by the CLI and bumped when a field's
  name or meaning changes.
- `capturedAt` — the ISO datetime the run was captured.
- `fingerprint` — the run fingerprint (§ below).
- `backend` — the backend identity the run used, in the form the backend reports it (an API
  backend's identity carries its model, a CLI backend's is its own name).
- `model` — the model id, **as its own field**. It is not folded into the backend's name and not
  implied by it: the record must say which model produced the numbers without the reader having to
  parse a composite identity string.
- `totals` — the run's counters: the per-verdict counts, the three rates of §2, and the case count.
- `leafPaths` — the leaf paths the grid is keyed on.
- `grid` — the dense per-cell grid: one entry per leaf path per case, so a case that said nothing
  about a leaf still has a cell (unscorable), and a reader can see the whole matrix without
  reconstructing it.
- `history` — the appended history: the earlier records' identity and totals, so a record file
  carries its own lineage.
- `settings` — the run's full settings, as **one object** (below).
- `hazards` — an optional, self-describing extension carrying the four hazard counts of §3, present
  when the run's caller supplied the hazard declarations those checks need (§3). It names itself
  (its own kind and version) so a reader that does not know the extension can skip it, and a reader
  that does can tell which extension it is looking at.

### The settings object

`settings` is one object, never a flat set of top-level fields, because the settings are part of
the record's identity and are compared as a unit:

- `strategies` — the ordered list of strategy ids the run drove (§8). The whole ladder is recorded,
  not only the rung that won, because the ladder is part of what was measured.
- `consensusCandidates` — the consensus candidate count, when consensus is in the ladder.
- `maxRetries` — the retry budget.
- `responseCap` — the per-response token cap, when the run carried one.
- `splitCaps` — the two split caps, `maxNullableUnionsPerGroup` and `maxSerializedCharsPerGroup`,
  each present or absent as the run carried them.

### The run fingerprint

The fingerprint is a SHA-256 over the canonical serialisation of **the JSON Schema document
together with the run's prompt inputs** — and of nothing else. The schema document is the corpus's
schema, as loaded; the prompt inputs are the manifest's instructions, examples and field-descriptions
mode (§1).

The canonicalisation is **the rule inspect already uses**, not a second canonicaliser:
`canonicalJson` in `packages/ribo-cli/src/inspect/fingerprint.ts` — object keys recursively sorted
in code-unit order, `JSON.stringify` with no whitespace, `undefined` folded to `null` — and the
same `node:crypto` SHA-256 that `schemaFingerprint` in the same file computes, producing 64
lowercase hex characters with no prefix.

**The function computing the fingerprint, and the function computing the record's identity, are
exported from `@azx/ribo-cli`'s public entry** (`packages/ribo-cli/src/index.ts`). This document
fixes their names: `runFingerprint` takes the schema document and the prompt inputs and returns the
digest; `recordIdentity` takes a record's four identity fields and returns the key they form. The
export exists so that a consumer outside the CLI — the accuracy-page generator, in particular —
judges staleness by the same code the eval run used, instead of reimplementing the hash and
drifting from it.

### "Cosmetic", exactly

A change to the fingerprint's inputs is **cosmetic** when it changes only **JSON key order and
formatting**. Reordering the keys of the schema document at any depth, or reformatting the
whitespace of the schema document or of the prompt inputs' JSON, leaves the fingerprint unchanged.

Nothing else is cosmetic. **Prompt text is hashed exactly and is never normalised**: the
instructions, the examples' transcripts and the examples' field values go into the digest byte for
byte, with no case folding, no whitespace folding, no punctuation folding. The normalisation bridge
of §2 is a scoring rule; it is not a hashing rule. So a prompt-only change — even a whitespace-only
edit to the instructions or to an example — changes the fingerprint and stales the baselines.

### The freshness identity

A record's identity is **backend + model + settings + run fingerprint**. A baseline is current only
when **all four match**. This is a deliberate decision, and the two rejected alternatives are worth
naming because both look attractive:

- **A fingerprint-only key** would let a stale baseline pass as fresh: changing the strategy, the
  model or an option leaves the fingerprint alone (the fingerprint covers the schema and the prompt,
  not the settings), so a baseline measured under one configuration would be presented as current
  under another.
- **A strategy-only key** would call two different measurements the same: consensus with three
  candidates and consensus with five candidates are different measurements under the same strategy
  name, and a strategy-only key would treat them as one.

The four-field key is therefore the identity, and the currency predicate — "is this record current?"
— is one function over it. The ticket that owns that function is **T13b**, which defines and
exports it; the accuracy-page generator (T14b) and the later T16 consume it. This document
describes the predicate; it does not claim the code exists.

The generator reads **two required arguments** — the records directory and the corpus directory —
and judges staleness against the corpus the second argument names. The argument pair, and what the
generator does with it, are T14b's to specify; naming it here keeps the identity story in this
document and the page's own staleness rule saying the same thing.

### Where records live

Records live under `./ribo-eval-runs/` **in the current working directory**, by default. An
`--out <dir>` flag overrides that directory. Compare and every freshness read use the same
directory — the one the run wrote to, or the one `--out` names.

The default is cwd-relative and never a fixed repository path, because eval runs against arbitrary
schemas and corpora in arbitrary folders: a run's records belong beside the work that produced
them, not inside the tool's own tree. A run from a different directory therefore writes a different
records directory, and a repository that evaluates corpora keeps its records where its own scripts
can find them.

### The must-fail tests these definitions owe

The definitions above are only worth what their tests pin. The later scoring and records tickets
build these, and each one must fail without the change it names:

- Two runs over the same corpus and the same schema document, differing only in their instructions
  (or only in their examples), produce records with **different fingerprints**.
- A **whitespace-only** prompt edit does the same: the earlier record's fingerprint differs from
  the later one's.
- A freshness consumer treats the earlier record as **stale** after such a prompt-only change.
- A **cosmetic** JSON edit — reordered keys, or reformatted whitespace in the documents — leaves the
  fingerprint **unchanged**.
- Two records differing only in **consensus candidate count** are **not current** for each other.
- Two records differing only in **strategy** (or only in **model id**), with identical fingerprints,
  are reported **stale** by a freshness consumer — they are not the same measurement.

## 5. The spend guard's estimate model

The spend guard refuses a run whose worst case costs more than the operator allows. It refuses
_before_ any model call is made, so its estimate must never undercount: **an estimate that
undercounts refuses too late**, and the money is already spent. Overcounting is the safe direction —
it refuses early, and the operator raises the ceiling.

### The call model is read, never restated

The worst-case number of calls per case is obtained by **calling inspect's own `describeCalls`**
(`packages/ribo-cli/src/inspect/calls.ts:123`) with the run's own split caps, and reading the
fields of the report it returns. The guard never restates the formula, never re-counts groups and
never re-splits a schema: `describeCalls` is the one place the call model is computed, and the
guard's job is to read it.

### The presence-narrowed bound, and its absence

`describeCalls` returns a `CallsReport` whose `presenceNarrowedAtMost` is `number | null`
(`packages/ribo-cli/src/inspect/calls.ts:44`). The field is an **upper bound**, documented as one
at its declaration and in the merged ADR 0040: the presence phase contributes one call per group,
and the fill phase contributes one call per piece of the split's grouped pieces (the unwrapped `""`
pieces excluded, because the fill only walks groups). The common case is cheaper — groups presence
found empty cost nothing in the fill, and narrowing runs before the split — and the bound exists
because the guard cannot know presence's answer without making the calls it exists to predict.

`presenceNarrowedAtMost` is `null` for a flat schema, and `null` when construction over the same
schema and caps refuses. **The estimate never coerces a null to zero and never substitutes another
strategy's count.** A null bound means the guard has no upper bound for this run, and the only safe
reading of "no bound" is a refusal: the run is refused, the stderr names that the estimate could
not be derived, and the operator is told which schema and caps produced it. Substituting a count
from a different strategy would price a run the guard has not measured.

### The rest of the estimate

- **Retries.** The attempts are `1 + maxRetries`, the semantics `retry-async.ts`
  (`packages/ribo-core/src/async/retry-async.ts:22`) documents: a run's worst case multiplies its
  call count by the attempt count.
- **Tokens.** The per-call token bound comes from the **real pieces' measured prompt sizes** — the
  prompt each piece actually carries — plus the response cap, so the estimate is priced on what the
  run will send, not on a schema-sized guess.
- **Price.** The tokens are priced from a **dated per-backend table in the CLI package**: each
  backend's price per thousand prompt tokens and per thousand completion tokens, and the date the
  table was last priced. For the **subscription CLI backends** — the ones whose own use the vendor
  does not meter per token — the table states the **token-equivalent assumption** the estimate uses
  to put them on the same scale as the metered backends. The assumption is stated, not hidden,
  because it is an assumption: a reader who disagrees with it can see what it is.

### The estimate reads the run's own settings

The estimate reads the run's settings **as the command's run-settings flags carried them**, and
calls `describeCalls` **with the run's own split caps**. The bound it reads is therefore the bound
for the caps the run will use. This is the whole point: a tight byte cap set through the flag
changes how the schema splits, and the estimate computed under the default caps would undercount the
metered actual and refuse too late.

### The must-fail tests the spend-guard ticket builds

- A **presence-narrowed fixture whose groups split into multiple pieces under the byte caps**: an
  estimate that counted one fill call per group undercounts the metered actual and refuses too
  late. The estimate must count the pieces.
- A **custom-caps fixture** whose tight byte cap is set through the flag: an estimate computed
  under the default caps undercounts and refuses too late. The estimate must use the run's caps.
- A **null-bound fixture**: an estimate that coerces the null to zero, or substitutes another
  strategy's count, refuses too late the same way. The estimate must refuse.

## 6. The `--json` shapes and the exit codes

Both commands emit a versioned JSON document under `--json`, and both use the discipline inspect's
contract already established: a `contractVersion` field carrying a literal integer the CLI owns,
bumped only when a field's name or meaning changes (`CONTRACT_VERSION` and
`contractVersion: z.literal(3)` in `packages/ribo-cli/src/inspect/report-schema.ts` is the model).
Each command's contract carries its own version; a change to one does not bump the other.

### `ribo eval --json`

The document carries: `contractVersion`; the corpus's `name` and `fingerprint` (§7); the run's
`backend`, `model` and `settings` (§4); the run's `fingerprint` (§4); the `totals` (§2, §4); the
`leafPaths` and the dense `grid` (§4); the optional `hazards` extension (§3); and the `record`
field, naming the path the record was written to.

### `ribo compare --json`

The document carries: `contractVersion`; the corpus's `name` and `fingerprint`; the two records'
identities, each as its four fields; the `axes` — the identity fields that differ (§7); the
`leafPaths` of the intersection (§7); the per-side `excluded` counts of the leaves the intersection
dropped; the per-side `totals`; and the `differences` — per leaf path, per case, the two sides'
verdicts side by side.

### The exit codes

There are **exactly two** exit codes, and no third:

| Exit code | Class         | When                                                                                                                                                                                                                           |
| --------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `0`       | Success       | The run produced a record, or the comparison produced its report. A difference is a finding, not a failure.                                                                                                                    |
| `2`       | Could not run | Nothing ran: a usage error, an unreadable corpus, a missing or non-answering CLI binary (the backend preflight), or a refused spend. The diagnostic goes to stderr and names **which** of the four it was; stdout stays empty. |

Exit 2 already means could-not-run and usage error in `packages/ribo-cli/src/bin.ts` — `fail()`
at line 38 writes the diagnostic to stderr and exits 2, and commander's `.exitOverride` at line 156
remaps every usage error to 2. The eval and compare commands join that discipline rather than
inventing a parallel one.

**There is no regression-detected code.** `ribo compare` reports its differences and exits 0. A
regression gate and an accuracy threshold are out of scope for this series, so there is no
threshold-failure code either: a caller who wants to fail on a difference reads the report and
decides for itself. Adding a third code later would be a new decision with its own ADR, not a
detail of this one.

### The ordering

**The preflight runs before planning and before the spend guard.** The preflight is the check that
the backend's binary is installed and answers — the CLI backends spawn the user's installed
binaries (§11), and a missing binary is discovered by running it. Planning (which corpus cases
exist, how the schema loads, how the run is composed) and the spend guard (which prices the run)
both come after, so a missing binary is reported as a missing binary rather than as a spend
refusal or a corpus fault. The order is fixed in the command's own flow and is not a matter of
implementation taste: a refused spend must never be reported when the real fault was that the
operator's CLI is not installed.

### Who wires what

- **T9b** wires `ribo eval` into `packages/ribo-cli/src/bin.ts`: the `--corpus`, `--backend`, the
  repeatable `--strategy` and `--out` parsing, the run-settings flags that form the freshness key
  (the consensus candidate count, the max-retries budget, the response cap and the split caps —
  the split-cap pair reusing inspect's existing flag spellings, `--max-nullable-unions-per-group`
  and `--max-serialized-chars-per-group`, and their `parseCap` parser at
  `packages/ribo-cli/src/bin.ts:66`), and the exit codes above.
- **T14a** wires `ribo compare`.
- **Every later ticket adds only its own flags to a command that already exists.** No later ticket
  re-wires the command surface, and no later ticket adds a flag that changes the freshness key
  without saying so in the settings object (§4).

## 7. The compare alignment rule

`ribo compare` lines two run records up and reports the differences between them. Two questions
have to be answered before anything is lined up: _are these two records about the same thing?_ and
_which leaves do they have in common?_

### The corpus fingerprint

The corpus fingerprint is a SHA-256 over the canonical serialisation of **the corpus's cases
only** — each case's input and its expected answer, including the asserted entries, the
declared-absent entries and the acceptable-alternative entries. It covers **never** the schema, the
prompt inputs or any other manifest field.

It is therefore **distinct from the run fingerprint** (§4), which covers the schema and the prompt
inputs. The two answer different questions: the corpus fingerprint says "these are the same
questions"; the run fingerprint says "these were asked the same way". So two corpora with the same
prompt but different cases are **refused** — they are different measurements — and a prompt-only
difference over the same cases is an **axis**, not a refusal: the same questions, asked differently.

**The corpus fingerprint is required.** A comparison without it is refused unless the caller passes
an explicit override, and the override is recorded in the output. A comparison that silently lined
up two corpora it could not prove were the same would report differences that mean nothing.

### The records' keys

Each record is keyed on its **four-field identity** — backend + model + settings + run fingerprint
(§4). A difference in any of the four is **reported as an axis, not refused**: the two runs are
comparable measurements whose conditions differ, and the axis is the reader's first question. The
settings are compared as one object, so a difference in any option inside them is one axis.

### The leaf alignment

Leaf paths are aligned on the **intersection** of the two records' leaf sets. Each side's leaves
that the intersection excludes are counted and reported, so a reader sees how much of each side the
comparison did not cover rather than a silently smaller matrix.

**An empty intersection exits could-not-run** (2): two records that share no leaf have nothing to
compare, and reporting an empty comparison as a successful one would dress up a mistake as a
result.

The leaf sets are computed through `packages/ribo-cli/src/inspect/field-inventory.ts` —
`walkFieldInventory` — **never a fresh walk**. The inventory is the one field-counting walk in the
CLI, and a second walk over the schema would be a second answer to a question the codebase already
answers once.

## 8. Strategy selection

A run is driven by an ordered ladder of strategies. The `--strategy` flag is **repeatable**, and the
order of the flags is the order of the ladder.

The strategy names are the core presets the harness can drive — `single-shot`, `per-group`,
`presence-narrowed` and `consensus`. The ladder is composed with core's own combinator,
`fallbackExtractor` (`packages/ribo-core/src/extraction/fallback-extractor.ts:41`), over the named
strategies with the default arbiter (`terminalFallsThrough`,
`packages/ribo-core/src/extraction/arbitration.ts:159`): the first rung that settles
acceptably wins, and a rung that fails terminally falls through to the next. The run records the
whole ladder in its settings object (§4) and the rung that won in the result's own usage.

**Consensus picks an index; it never re-decides the answer.** `consensusExtractor`
(`packages/ribo-core/src/extraction/consensus-extractor.ts:201`) runs every candidate and chooses
the winning index — the arbiter judges the candidates, not the value. The harness therefore never
wraps consensus in an arbiter that re-judges the extracted value: a run that measures consensus is
measuring consensus's own choice, and a second opinion over it would be a different strategy with
the same name. The candidate count is part of the settings object, because it multiplies the run's
cost and changes what the run measured.

## 9. Document inputs under Node: the pdf.js spike framing

This section is written by T7b.

## 10. The accuracy-page generator's scope

This section is written by T7b.

## 11. Reuse rules and wiring for the build tickets

The build tickets wire into what already exists. Nothing re-walks, re-wires or re-builds.

- **Terminal colour** goes through `colorsFor` (`packages/ribo-cli/src/colors.ts:10`) and nowhere
  else: colour only on a TTY, `NO_COLOR` honoured, and the JSON rendering byte-identical whatever
  the colour environment.
- **Built-bin suites** go through `buildCliOnce`
  (`packages/ribo-cli/src/test-support/build-once.ts:48`), which builds the CLI once per test run
  under a lock; the built bin is `packages/ribo-cli/dist/bin.js`. A suite that rebuilds the bin per
  test is a suite that spends its time compiling.
- **Field counting** goes through `walkFieldInventory`
  (`packages/ribo-cli/src/inspect/field-inventory.ts:64`), the one field-counting walk.
- **Call counts** go through `describeCalls` (`packages/ribo-cli/src/inspect/calls.ts:123`), the one
  call model.
- **Canonical JSON** goes through the rule `canonicalJson`
  (`packages/ribo-cli/src/inspect/fingerprint.ts:12`) already implements; a second canonicaliser is
  a second answer to the same question.

**New runtime dependencies are bundled into the single-file bin**, per ADR 0037: the CLI ships as
one Node file, and a dependency that is not bundled is a dependency the consumer must install.

**The CLI's runtime dependencies never include an adapter.** The eval harness reads a corpus's
schema as a JSON document, so it never needs a tool adapter at run time. Test-only
`devDependencies` on the Snugg adapter are allowed — they exist on main today, where
`packages/ribo-cli/package.json` carries `@azx/ribo-adapter-snuggpro` as a devDependency only, and
the adapter's fixture schema is what the round-trip test of ADR 0038 renders.

**The CLI backends spawn the user's installed binaries, never the vendor SDKs.** A backend that
needs a vendor's command-line tool runs the tool the operator installed, so the harness measures
the tool the operator actually uses and adds no vendor SDK to the bundle.

## 12. The manual-vs-CI split and the no-spend rule

**Eval never runs in CI.** No continuous-integration step runs `ribo eval` or `ribo compare`
against a real backend. A CI run that spends money is a CI run whose bill nobody approved.

**Every test stubs the `ChatClient`.** Core's chat seam is the boundary, and the eval suite stubs
it exactly as inspect's agreement tests do — a counting stub that records the requests as they
arrive. No test in this series reaches a transport, and no test spends on a real model. The
agreement rule holds: a test that drove nothing must fail, never pass vacuously.

**Paid runs are operator steps outside acceptance.** Running the harness against a paid backend is
something an operator does by hand, with their own key and their own ceiling; the artefacts land in
the records directory and are read by compare and by the accuracy page. Nothing in this series
prescribes a paid run, and this document's own examples assume stubbed clients.

**No corpus counts appear in prose.** This document never states how many cases a corpus holds or
how many leaves a schema has; those are facts about a corpus, read from the corpus and the schema,
never quoted here.

## 13. The gate wrapper

This section is written by T7b.
