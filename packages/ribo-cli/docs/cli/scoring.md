# Scoring and comparing runs

`ribo eval` scores one run against one corpus, leaf by leaf, and reduces every leaf of every case
to a verdict. The verdicts, the three rates built from them, and the record the run persists are
this page.

## The verdicts

A leaf is **judged** when the case expects something of it: an `asserted` entry, or a
`declared-absent` one (explicit or from a covering default). The verdict follows from the
expectation and what the run produced:

| Expectation     | The run produced                               | Verdict        |
| --------------- | ---------------------------------------------- | -------------- |
| asserted        | the expected value, or one of its alternatives | `correct`      |
| asserted        | a different value                              | `wrong`        |
| asserted        | no value                                       | `missed`       |
| declared-absent | no value                                       | `correct`      |
| declared-absent | a value                                        | `hallucinated` |
| —               | not judgeable                                  | `unscorable`   |

`hallucinated` is its own verdict, not a flavour of `wrong`: the case said nothing happened, and
the run said something did.

**Declared-absent is not an asserted `false`.** The two are different claims and they score
differently. Take a boolean leaf `insulation.present`: an entry
`{ "status": "asserted", "value": false }` claims the document _says_ there is no insulation — a
run producing `false` is `correct`, `true` is `wrong`, and no value is `missed`. An entry
`{ "status": "declared-absent" }` claims the document says _nothing_ about insulation — a run
that leaves the leaf empty is `correct`, and a run that produces any value at all, `false`
included, is `hallucinated`. Assert `false` when the document denies; declare absent when it is
silent.

`unscorable` always carries its reason: `unmentioned` (the corpus says nothing about the leaf),
`incomparable-expectation` (an enum or literal expectation naming no member the schema declares —
a corpus authoring fault, reported rather than scored as wrong), or `unreviewed-proposal` (the
entry is a proposal still awaiting review). A pending proposal's cell is in no denominator,
whatever the run produced — an unreviewed model answer is never a measurement — but the cell is
still written: it carries the proposed value and what the run produced, labelled with the reason,
so a reader sees what would have been judged. An unscorable cell counts in no denominator.

A case whose extraction **failed** is judged over every leaf and earns no credit for silence:
every asserted leaf is `missed`, and every declared-absent leaf is `missed` too — the failure
said nothing, so its silence is not a chosen abstention. The cells stay judged: they count in
accuracy-over-all's denominator and never in its numerator, so a run that produced nothing scores
zero rather than reading as accurate, and its answer rate is visibly zero rather than quietly
absent. A failed case's pending proposals are in no denominator either — they stay `unscorable`.

### Nothing unreviewed is a measurement

A pending proposal contributes to no rate ([Proposals and review state](/cli/corpus)). Partial
review stays useful: three reviewed cases give a real measurement over those three. When a corpus
holds pending proposals, `ribo eval` prints one stderr line counting the pending cells and the
fully pending cases and naming `ribo corpus review`. The run still pays extraction for every
case — eval has no case selector; proposing and reviewing **per case** is the budget path.

When the corpus holds no judgeable expectation at all — every entry a pending proposal, or no
entries at all (a fresh scaffold) — `ribo eval` refuses before transcription, the spend estimate
and any model call (exit 2, empty stdout): with pending proposals the refusal names
`ribo corpus review`; with none, `ribo corpus propose`. This is a deliberate change of today's
behaviour for an expectation-free corpus, which previously ran, spent and recorded nothing
judged. Every other corpus — any corpus with at least one judgeable expectation — loads, scores,
fingerprints and records exactly as before; the expectation-free corpus is the exception.

Two rules decide whether the produced value _is_ the expected one:

- **The normalisation bridge.** Two strings that differ only in case, whitespace or trailing
  punctuation are the same; two numbers that are numerically equal are the same (a spoken number
  and its digits included). Nothing else is folded — no stemming, no synonyms.
- **Collections compare whole.** A collection leaf's produced list must be the expected length,
  every element matching its ordinal's expectation (or an alternative's same ordinal); a run that
  produced extra instances is `wrong`, not correct.

## The three rates

Every report and record states three rates, always together, because any two read as a
contradiction when the third is missing:

- **Answer rate** — of the judged cells, the fraction where the run produced a value at all.
  Coverage.
- **Accuracy over answered** — of the cells where the run produced a value, the fraction that were
  `correct`. The quality of what was said; the number that ignores the misses. (A `correct` cell
  on a declared-absent leaf was never said, so it counts here in neither the numerator nor the
  denominator.)
- **Accuracy over all** — of the judged cells, the fraction that were `correct`. The quality of
  the whole run.

A run that answers almost nothing scores a perfect accuracy-over-answered and a poor
accuracy-over-all; a run that answers everything wrongly scores the reverse. The answer rate tells
the two apart. A rate whose denominator is zero is `null`, never NaN.

## The run record

Each arm of a run persists one record — the source of truth every view renders. It is written
whole (a temp file, then a rename), never overwritten (a colliding name gets a suffix), to
**`./ribo-eval-runs/` beside the working directory**, or to the directory `--out` names; the
report's per-arm `record` field names the path. The record is a versioned JSON document
(`contractVersion` owned by the CLI) carrying the corpus's name and fingerprint, the run's
identity in plain text — backend, model, settings and the run fingerprint over the schema and the
prompt — the totals, the leaf paths, the dense per-leaf, per-case grid of cells, and the lineage
of earlier records of the same identity in the same directory. A record is zod-parsed on read; a
malformed one is a refusal, never a silent drop.

The stdout report is the arms' summary — settings, per-case results, totals, fingerprint, record
path — written only once every arm's record is on disk. A multi-arm run also prints a cross-arm
comparison summary to stderr, rendered by the same code `ribo compare` uses.

## Planned arms and record identity

A `planned` arm executes a reviewed semantic plan ([Planning and authoring](/cli/planning)) and is
estimated, scored and persisted like any other arm. Two usage refusals fence the strategy, both
before any work starts: **planned without `--plan`** is refused — the strategy has nothing to
execute — and **`--plan` without a planned rung** is refused — an ordinary arm must not inherit a
plan's identity silently.

After the usage check, the plan is judged against the corpus schema in a fixed order, each refusal
leaving no report and no records: a **stale** plan (field membership drifted) is refused first,
naming the added and removed leaves and the `--update` fix; then a plan that cannot be built into
calls at all under the run's split caps is refused with the construction error. Both are exit 2
before preflight, transcription, spend or chat. Fingerprint-only drift — the schema's bytes
changed, its field membership did not — prints one note and the run continues.

What is different about a planned record is identity: the record's optional
`settings.planFingerprint` names the exact plan the arm executed, derived by the runner from the
parsed plan — it is computed from the plan's own content alone (its version, its field paths, its
pieces), so it is stable under schema key reorder and byte churn that leaves membership alone. The
field is **additive at record version 1**: old records and new records share one version, records
from planned and unplanned arms line up in the same directory, and both read back under the same
schema. An older reader validates v1 settings strictly, so it refuses a planned record's unknown
key rather than silently treating two different layouts as the same run; unplanned records read as
before.

## `compare`

`ribo compare <a> <b>` reads exactly the two record files it is named — no corpus, no schema, no
re-scoring — and lines them up:

- **Axes** — the identity fields that differ: `backend`, `model`, `settings`, `fingerprint`. A
  difference is reported, never refused and never silently equated; the axes are the reader's
  first question ("did I actually change only one thing?"). A planned and an unplanned arm of the
  same corpus therefore differ on the `settings` axis — one carries `planFingerprint`, the other
  does not — and `compare` reports that difference as a finding, exactly like any other settings
  difference.
- **The leaf intersection** — leaves align on the intersection of the two records' leaf sets, with
  each side's exclusion counts printed, so a reader sees how much of each side the comparison did
  not cover. No shared leaf, or — under the corpus override — no shared case, is a could-not-run
  refusal: an empty comparison dressed as a result would hide it.
- **The differences** — per leaf, per case, every cell pair whose verdict changed, with both
  sides' values behind it. Two `correct` cells with different phrasing agree; the verdict is the
  entry rule.

Two records from **different corpora** (the corpus fingerprint covers the cases — each case's
input and expected answers) are refused unless `--allow-corpus-mismatch` is passed, and the
override is recorded in the report whether or not the fingerprints turned out to match — it
records what the caller asserted.

Exit codes: **0** — the comparison was computed (a difference is a finding, never a failure);
**2** — could not run.

### Comparing across a corpus edit

The refusal above turns on the **corpus fingerprint**, and the fingerprint covers exactly: each
case's id; the case's declared inputs in order — each input contributing its file name, its kind,
and a digest of the file's bytes; the case's expected entries and its defaults; and the
corpus-wide effective `markCaptures` policy. Changing any of those — an edited expectation, a
different input file, a re-ordered inputs list, a flipped marker policy — changes the corpus
fingerprint, and the pair is refused without `--allow-corpus-mismatch`. The expected entries are
hashed whole: a proposal's provenance and an entry's review state are covered too, because review
state decides which cells are judged and provenance decides how the totals may be read (ADR 0049).

Just as exactly, these leave the corpus fingerprint alone and never cause that refusal: the
capture metadata beside a document's bytes (`capturedAt`, `pageCount`), the schema document, the
prompt instructions and every other manifest field, and reformatting the corpus's JSON files —
the fingerprint hashes parsed values, not bytes. A schema edit is still visible: it moves the
record's own `fingerprint`, which `compare` reports as an axis rather than a refusal.

The clean fix for a covered edit is to re-run the baseline on the edited corpus, so both records
measure the same questions. `--allow-corpus-mismatch` compares what the two records share and
records the override in the report; a score change read across a corpus edit mixes the edit with
the run, and attributes both to whichever axis you thought you had changed.
