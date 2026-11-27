# 0049. Expectations may be proposed and are scored only once reviewed

Status: Accepted
Date: 2026-11-27

## Context

A corpus case's `expected` map is the corpus's judgement, and eval measures a run against it —
but the map is entirely hand-authored, and authoring it is the cost the eval pipeline asks a
person to pay up front. The input material is already there: a model could draft each case's
expectations from the case's own inputs, exactly as `ribo schema init` drafts the schema. What
stopped it was a rule: a model-made answer must never be scored as a measurement, and the
expectation must be the author's judgement. This decision keeps the rule and removes the toil:
a model may propose, a reviewer disposes, and nothing unreviewed is ever scored.

## Decision

**The rule stands; one consequence sentence is superseded.** ADR 0045's Decision ("Expectations
and instructions remain empty") and ADR 0046's "no inferred expectations" remain literally true —
init is not changed. What changes is 0045's Consequence "a person must author expectations". It
becomes: **a reviewer must confirm every expectation before it is scored; authoring may start
from an evidence-linked proposal.** This ADR records that change; no accepted ADR is edited.
Rejected: declaring the rule overturned — the judgement stays with the reviewer, and saying
otherwise would license scoring unreviewed output. Rejected: no ADR — the corpus documentation
and 0045's consequence do change meaning.

**Proposing is a new command: `ribo corpus propose <corpus-dir> [case-id...]`.** It works on any
existing corpus — after a schema edit, on a newly added case, on a hand-built corpus — and makes
one call per case. Keeping it out of init keeps 0045 and 0046 true as written. Rejected: a flag
on `schema init --corpus`, which ties labelling to drafting, cannot be re-run, and multiplies
init's spend bound by the case count. Rejected: reusing an eval run's outputs — that makes the
proposer the scored pipeline itself (same prompt, same strategy), the purest form of the
circularity below.

**The model speaks a flat, code-owned proposal language.** Following `schema-init/proposal.ts`
("deliberately not JSON Schema"), the reply is a list of scalar items (leaf path, then absent or
value plus quote) and a list of collections (collection path, rows in document order, each row a
list of cells with leaf, value and quote). The response format's depth and size are constant
whatever the corpus schema, so provider structured-output limits never depend on the user's
schema; the schema document travels in the prompt. Code validates each item against the corpus's
`leafInventory` (known path, scalar versus collection, value kind, enum membership), grounds each
quote per input, derives the input name, and pivots collection cells to the ordinal-keyed
leaf-major value the scorer reads — a leaf missing from one row omits that ordinal; a leaf
missing from every row, or an empty collection, is a proposed absence. One bounded repair round;
after it, an unparseable reply fails that case alone, and item-level problems drop the item into
the report's unproposed list rather than failing the case. Rejected: asking for core's enveloped
schema as the response format — it reintroduces schema-size limits and shares the scored wire
shape. Rejected: one quote per row — a system "row" in a quote spans several lines, and long
quotes fail exact matching. Rejected: all-or-nothing per case, as init does — one bad quote among
a hundred values would discard paid work the reviewer could still use.

**Eval scores an unreviewed proposal as `unscorable` with reason `unreviewed-proposal`, and
refuses before spend when nothing is judgeable.** The pre-spend refusal applies whenever the
corpus holds no judgeable expectation at all — all entries pending, or none (a fresh scaffold):
with pending proposals it names `ribo corpus review`; with none it names `ribo corpus propose`.
It exists so a small budget is not spent on a run that measures nothing, and it deliberately
changes today's behaviour for an expectation-free corpus, which currently runs and records
nothing judged. A partly reviewed corpus still pays extraction for every case, since eval has no
case selector; the stderr line quantifies the unjudged share, and the docs name per-case propose
and review as the budget path. Rejected: refusing whenever any proposal is pending — that blocks
incremental review and pushes a reviewer toward bulk confirmation. Rejected: scoring pending
proposals as a labelled non-measurement — it prints an agreement number in the shape of an
accuracy, and that number would be reported as the result.

**Circularity is made visible, not forbidden.** The operator names the proposer with `--backend`
and `--model` on propose; both are stamped on every proposal; the docs and init's handoff
recommend a proposer that is not the model to be scored. Equality is allowed — a subscription
user may have one model, and "similar" cannot be detected. Eval counts every judged cell by
origin and writes the count into the record and report; when accepted-unchanged cells were
proposed by the scored backend and model, stderr states that for those cells the run measures
agreement with that model's own proposal, and the count is in the record. "Unchanged" is decided
with the scorer's own `sameAnswer`, so it means "scores identically". The proposer's prompt is
its own and omits the manifest's instructions — that reduces the correlation but does not remove
it, and the docs say so. Rejected: refusing proposer equal to scored model — a false guarantee
that blocks the single-model user. Rejected: per-origin sub-rates — corrected cells are selected
for difficulty, so their rate misleads. Rejected: a self-reported `--reviewer` name —
unverifiable, and it would read as assurance.

**Provenance and review state live on the expectation entry, and the corpus fingerprint covers
them whole.** An explicit entry gains two optional members, present together or not at all:
`proposal` and `review`. `proposal` is immutable — backend, model, proposed-at instant, the
proposed status, and for an asserted proposal the proposed value and its evidence (one
quote-plus-input for a scalar leaf, an ordinal-keyed map of them for a collection leaf); a
proposed-absent block carries no value and no evidence. `review` is `pending` or `confirmed`.
The reviewer edits the entry's own `status`, `value` and `alternatives`; the untouched `proposal`
is what lets code classify a confirmed entry as accepted-unchanged or corrected, and an entry
with no `proposal` is hand-written. A proposal never carries alternatives, so any alternative on
a proposal-bearing entry is an addition and classifies the entry as corrected.
`corpusFingerprint` already hashes each case's `expected` map whole, so no fingerprint code
changes — review state decides which cells are judged and provenance decides how the totals may
be read, so covering them is right. Rejected: a sidecar proposal file — the loader ignores
undeclared files, so eval could not see pending state, and applying it would still rewrite
`case.json`. Rejected: carving provenance out of the fingerprint — two records with different
proposers would compare as the same questions. Accepted limit: deleting a `proposal` block makes
an entry look hand-written; a plain-file format cannot prevent that, and the honest path is
cheaper than the dishonest one.

**Propose and review write `case.json` in place, additively and atomically.** This departs from
the authoring commands' never-write-your-input port, because the corpus is the author's working
tree — "reviewed, diffed and version-controlled as ordinary files" — and a copy-out form would
duplicate every PDF per run and leave the reviewer to merge JSON by hand, the very cost this
work removes. One writer module guards every write: only `expected` may change, every other
member and the key order are preserved, the result must re-parse as a case, and publication is
temp file then rename, as the eval record store does. Propose only adds keys, and writes each
case as soon as that case validates, so a later failure keeps paid work. Rejected: a new corpus
directory per proposal run. Rejected: stdout-only output.

**Review is one command: `ribo corpus review <corpus-dir> [case-id]`, with file edits for values
and three flags for decisions.** With no flags it is read-only and makes no model call: it
prints the pending sheet, re-verifies each quote against the current inputs, and marks each
value `literal` when the value itself occurs in its quote; `--json` emits a versioned form.
Decisions need a case id and one action: `--confirm`, optionally narrowed by a repeatable
`--leaf`; `--mark-absent --leaf <path>`, which sets the entry declared-absent and confirms it;
`--reject --leaf <path>`, which removes the entry so the leaf is unmentioned. A correction is
editing `value` in `case.json`, then confirming — a JSON value on a command line is unwritable,
the argument ADR 0048 made against flags that carry structure. A whole-case `--confirm` confirms
only entries whose every value is literal in a still-grounded quote; proposed absences and
non-literal values must be named with `--leaf`, and the command prints what it left pending and
why — a claim of silence has no evidence to show, and the trial's failure was exactly a false
"absent". For an agent reviewer the JSON sheet is the input, the docs tell it to check each
absence against `ribo corpus text`, and the record's accepted-unchanged count is the backstop.
Rejected: an interactive prompt — the existing commands have none, and an agent could not drive
it. Rejected: corpus-wide blanket confirm. Rejected: a decisions file applied by a third command.

**Spend uses the fixed-call model, summed per case.** Each case with at least one unanswered
leaf is one initial call, priced through `estimateFixedCallSpend` with the proposer's repair
bound, init's transport retries and `AUTHORING_CLI_SHAPE_ATTEMPTS`; the per-case estimates are
summed and enforced through `enforceOperatorSpendCeiling`. Every sample is loaded and
transcribed before the estimate, and the estimate precedes backend preparation — init's order.
HTTP requests carry the priced reply cap; a CLI backend that cannot cap makes the estimate a
priced expectation, as ADR 0045 states for init. The repair request quotes only the validation
problems, never the prior reply, and is bounded in size. The `cheaperFix` is backend-specific:
fewer case ids, `--only` and `--response-cap` for HTTP, but only fewer case ids and `--only` for
`claude-cli` and `codex-cli`. A ceiling is per invocation, as the spend docs say. `--only`
(repeatable, matched with `scopeCovers`) narrows the leaves asked and is the way through for a
schema too large for one reply. Rejected: pricing every call at the largest case — safe, but it
can refuse a small-budget run falsely. Rejected: eval's `estimateSpend` — it prices extraction
strategies, not this call.

**Record changes are additive at record version 1.** The `planFingerprint` precedent: the
additions are the new unscorable reason, one optional per-cell member named **`review`** (the
review class — the existing `origin` member, `explicit`/`default`/`none`, is unchanged in name,
values and meaning — plus, for a proposal-bearing entry, the proposer backend and model), and an
optional record-level expectations summary. The two optional members are written only when the
corpus holds a proposal-bearing entry, so every existing record stays byte-identical. An older
strict reader refuses a record carrying them rather than misreading it. Rejected: bumping the
contract version — that strands every stored record for a change most corpora will not exercise.

Init's handoff sends expected answers through `ribo corpus propose` then `ribo corpus review`;
a separate line keeps prompt instructions the author's to write. This supersedes ADR 0045's
expectation-authoring handoff wording only, not its instruction-authoring rule, and ADR 0045 is
not edited.

## Consequences

A case file's `expected` entries now carry their provenance and review state, so nothing
downstream has to guess whether an answer is a measurement or a model's guess: pending
proposals are unscorable, confirmed proposals are scored with their origin visible, and
hand-written entries behave exactly as before. The corpus fingerprint moves when provenance or
review state changes, so two records with different proposers never compare as the same
questions. The cost is that the format is now write-shared between a model (propose), a
reviewer (edits) and code (the writer module's guarantees), which makes the writer module the
one place the format's write-side invariants can live — every new authoring command must go
through it. The proposal prompt is deliberately a second prompt that can drift from eval's; the
circularity it reduces is disclosed per run rather than eliminated, and a reader who needs a
proposal-free measurement must correct for the accepted-unchanged count the record carries.
