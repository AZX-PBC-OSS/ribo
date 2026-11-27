# Planning and authoring

Two commands author, one strategy executes. `ribo schema init` drafts an OpenAPI schema from real
samples; `ribo schema plan` authors and updates a reviewed semantic plan over that schema; the
`planned` strategy of `ribo eval` executes the plan and measures it. This page is the authoring and
reference guide for all three — the schema dialect itself lives in
[Writing a schema for ribo](/cli/schema), the record and verdicts in
[Scoring and comparing runs](/cli/scoring).

The worked example ships a finished plan at
`node_modules/@azx/ribo-cli/examples/basic-corpus/plan.json` — authored by hand so an installed user can read a complete artifact before running anything.

## `schema init`: draft the schema from samples

```sh
ribo schema init ./notes.txt ./spoken-case --backend claude-cli --model claude-haiku-5-5
```

Each sample is a direct text file or an existing corpus case folder with exactly one declared
input — the transcript or text the draft will be evidence for. The draft is **evidence-linked**:
every leaf it proposes carries guidance grounded in what a sample actually said, not invented
structure. With `--corpus`, the command also scaffolds a corpus directory beside the schema; the
scaffold's `expected` maps and instructions stay **empty** — a draft never invents expected answers
or defaults, because expectations are the author's judgement, not the model's.

Output discipline matches `eval`: without `--out`, stdout is the complete schema alone; `--out`
writes a distinct new file and never overwrites an existing path. Every run prints an upper-bound
spend estimate to stderr before the first call and refuses above `--max-spend`.

Review the draft the way any schema is reviewed: read the guidance, check the groups against what
your documents talk about, and size it with `schema inspect`.

## `schema plan`: author the semantic layout

A plan is a small versioned JSON artifact over the schema's field inventory: the exact leaf paths
(`fieldPaths`) and an ordered list of named **semantic pieces**, each carrying a subset of those
paths plus the description the extraction prompt will read. Validation is exact — every schema
leaf appears in the pieces exactly once, and no piece names a path the schema does not have.

```sh
ribo schema plan ./schema.json --backend openai-compatible --model gpt-4o
```

The model proposes; you review. The reviewable surface is the pieces themselves: their names,
their descriptions, and which leaves belong together — a semantic decision about what one call
should read about. Re-author, edit the JSON, or hand-write one; the artifact is data, and nothing
in the execution path cares who wrote it.

### Freshness, staleness and `--update`

A stored plan can drift from the schema it was planned over. `ribo schema plan --update` reads the
stored plan, compares it with the current schema **without a model call**, and reports:

- **unchanged** — the plan matches the schema.
- **fingerprint-only** — the schema's bytes changed but its field membership did not; one note,
  and the plan stays valid.
- **stale** — field membership drifted (leaves added or removed). The plan is refused by
  `eval`, and the only fix is `ribo schema plan --update`, which re-plans the drifted membership
  and reports what moved.

An update never reads a model's suggestion over your review of it — but it does spend a call, so
the same estimate-and-ceiling discipline applies.

### The two update output forms

Both forms write a **complete** artifact; an update never modifies the stored input plan:

- without `--out`, the complete JSON plan is on **stdout** — redirect it where you like;
- with `--out <file>`, the complete plan is written to that **distinct new file** and stdout stays
  empty.

Neither form is an in-place edit: `--update ./plan.json` reads `plan.json` and writes the result
somewhere else, always.

## Executing the plan: the `planned` strategy

```sh
ribo eval --corpus ./corpora/workshop --backend claude-cli --model claude-haiku-5-5 \
    --strategy planned --plan ./plan.json --out ./runs
```

Two refusal directions, both usage errors before any work starts:

- **planned without `--plan`** is refused — the strategy has nothing to execute;
- **`--plan` without a planned rung** is refused — an ordinary arm must not inherit a plan's
  identity silently.

The plan is checked against the corpus schema before preflight, transcription or spend: a **stale**
plan is refused with the membership drift named; a plan that cannot be built into calls at all
(unbuildable under the split caps) is refused with the construction error — exit 2, no report, no
records. Fingerprint-only drift prints one note and the run continues.

### Spend, records and compare

A planned arm is estimated, capped and persisted like any other arm: the estimate prices the same
`--model`, the ceiling is the same `--max-spend`, and the record lands beside the others. What is
different is identity: the record's optional `settings.planFingerprint` names the exact plan the
arm executed. The field is **additive at record version 1** — old records and new records share
one version, records from planned and unplanned arms line up in the same directory, and `compare`
works unchanged across them. Two consequences, both deliberate: an **older reader** that has never
heard of the field still reads a planned record (optional fields are ignorable), while an **older
strict reader** — one that validated v1 records against a settings object that knew no such key —
refuses a planned record. The version did not move; the strictness did the distinguishing.

## Row citations: the direct-first owner rule

A collection row's citations must have exactly one owner, decided at **authoring** time from the
plan alone:

- the owner is the **earliest piece in plan order that carries a direct leaf** of the row — a leaf
  one level below the row's path;
- nested descendants are consulted **only** for a row with no direct leaves anywhere in the plan;
- the row's citation is emitted on the owner piece's **first packed call**.

In practice: if `upgrades.measure` and `upgrades.estimatedCost` sit together in one piece, that
piece owns every `upgrades` row's citation, whichever piece mentions other parts of the row. The
rule needs no configuration — it falls out of the plan you authored.

## Thresholds, with and without a plan

`ribo schema inspect --plan` measures the plan's actual packed calls, which is what a
piece-character threshold then judges; without a plan, the same threshold judges the rule-based
worst piece. The exact row semantics — the `shared` depth layout, the one-based size-split call
labels, and the exit codes — are pinned in
[Writing a schema for ribo](/cli/schema#threshold-rows).

## The library path, not the CLI path

In a host application the plan is executed by core, not the CLI: parse the same artifact with
`parseSchemaPlan` and hand it to `plannedExtractor`, both exported from `@azx/ribo-core`. The CLI
is the measuring bench; production imports core.

No claim is made here — or anywhere — that a plan improves accuracy. A plan changes how calls are
cut and what each call is asked; whether that helps your corpus is a measurement, and
`ribo eval` and `ribo compare` exist to make it.
