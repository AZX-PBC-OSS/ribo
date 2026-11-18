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

`unscorable` always carries its reason: `unmentioned` (the corpus says nothing about the leaf) or
`incomparable-expectation` (an enum or literal expectation naming no member the schema declares —
a corpus authoring fault, reported rather than scored as wrong). An unscorable cell counts in no
denominator.

A case whose extraction **failed** is judged over every leaf and earns no credit for silence:
every asserted leaf is `missed`, and every declared-absent leaf is `missed` too — the failure
said nothing, so its silence is not a chosen abstention. The cells stay judged: they count in
accuracy-over-all's denominator and never in its numerator, so a run that produced nothing scores
zero rather than reading as accurate, and its answer rate is visibly zero rather than quietly
absent.

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

## `compare`

`ribo compare <a> <b>` reads exactly the two record files it is named — no corpus, no schema, no
re-scoring — and lines them up:

- **Axes** — the identity fields that differ: `backend`, `model`, `settings`, `fingerprint`. A
  difference is reported, never refused and never silently equated; the axes are the reader's
  first question ("did I actually change only one thing?").
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
