# The ribo CLI

`@azx/ribo-cli` is Ribo's command-line package for authoring and measuring an extraction schema
before you trust it to a model. `ribo schema init` drafts an evidence-linked schema from real
samples and can scaffold a corpus around them; `ribo schema plan` authors and updates a reviewed
semantic plan over a schema; `ribo schema inspect` sizes a schema — or a plan's actual packed
calls — before the first paid call; `ribo corpus text` shows you exactly what a run would send;
`ribo corpus propose` drafts pending expected answers for every leaf the corpus does not yet
answer, each grounded in a case's own inputs; `ribo corpus review` shows every pending proposal
with its evidence and records the reviewer's decision; `ribo eval` runs the reviewed corpus of
documents through a model backend and scores the answers; and `ribo compare` lines two scored
runs up.

The questions it answers, in order: is my schema well-formed for extraction, what does the model
actually read, how often does it read the right thing, and did my change make that better or worse.

## Install and invoke

```bash
pnpm add -D @azx/ribo-cli
```

If your registry does not carry the `@azx` scope yet, pack the package from the repository
(`pnpm pack` in `packages/ribo-cli`) and install the tarball:
`pnpm add -D ./azx-ribo-cli-<version>.tgz`.

::: warning `npx ribo` is not this package
The bare name `ribo` resolves to an unrelated npm package. Invoke this CLI as `npx @azx/ribo-cli`,
`pnpm exec ribo`, or `./node_modules/.bin/ribo`.
:::

The package's README is self-sufficient — it ships in the tarball and covers every command. These
pages go deeper on the formats, and they ship in the tarball too, under
`node_modules/@azx/ribo-cli/docs/cli/` — a reader with only the installed package has the same
text.

## The commands at a glance

| Command               | What it does                                                                         | Exit codes |
| --------------------- | ------------------------------------------------------------------------------------ | ---------- |
| `ribo schema init`    | Draft an evidence-linked schema from samples; optionally scaffold a corpus           | 0, 2       |
| `ribo schema plan`    | Author or update a reviewed semantic plan over a schema                              | 0, 2       |
| `ribo schema inspect` | Size a schema in OpenAPI 3.0 form — or a plan's packed calls — before the first call | 0, 1, 2    |
| `ribo corpus text`    | Print the text each case's prompt carries — no model call, no key                    | 0, 2       |
| `ribo corpus propose` | Draft a pending expected answer for every leaf no entry and no default answers       | 0, 2       |
| `ribo corpus review`  | Show each pending proposal with its evidence and record the reviewer's decision      | 0, 2       |
| `ribo eval`           | Run a corpus through a backend, score it, persist one record per arm                 | 0, 2       |
| `ribo compare`        | Compare two persisted run records — a difference is a finding                        | 0, 2       |

Every command writes results to stdout and diagnostics to stderr; a refusal (exit 2, or a usage
error) leaves stdout empty. `ribo schema inspect` adds exit 1 for a breached threshold, with the
full report still on stdout. No command accepts a credential on a flag: the `openai-compatible`
backend reads `OPENAI_API_KEY` from the environment or a gitignored `.env.local`, and the
`claude-cli` / `codex-cli` backends spawn the binary you already have installed, on your own
subscription.

## The authoring path, end to end

Start from what you have — any of these is a valid starting point, and `ribo schema init` reads
all of them:

- a **bare PDF** — loaded as a one-input document sample, its page count measured from the file and
  its `capturedAt` stamped with the run instant (or the `--captured-at` you pass);
- **a folder per job** — a plain directory of `.pdf`, `.txt` and `.md` files, loaded as one sample
  named after the directory;
- **an existing case folder** — a corpus case with any number of declared inputs, passed through
  untouched;
- **a hand-written schema** — skip the draft and start from the walkthrough below.

For a large set, draft from a few representative samples with `--draft-from` while `--corpus`
scaffolds every sample into a case.

The commands compose into one reviewable workflow, from your own samples to a measured verdict —
the same path the worked example's finished plan
(`node_modules/@azx/ribo-cli/examples/basic-corpus/plan.json`) is the end product of:

1. **Draft:** `ribo schema init ./notes.txt --backend claude-cli --model claude-haiku-5-5 --corpus
./corpus --corpus-name "Field notes" --corpus-provenance real` — the schema alone on stdout (or
   a new file with `--out`), plus a scaffolded corpus whose expected maps and prompt instructions
   are empty — the draft never invents either.
2. **Review the draft, then size it:** `ribo schema inspect ./corpus/schema.json`.
3. **Plan the calls:** `ribo schema plan ./corpus/schema.json --backend openai-compatible --model
gpt-4o` — the complete plan is on stdout; save it as a file and review the pieces. When the
   schema later drifts, `--update` re-authors it, never in place.
4. **Read what each call will carry:** `ribo corpus text ./corpus` — before any expectation is
   written.
5. **Propose and review the expected answers:** `ribo corpus propose ./corpus --backend
openai-compatible --model gpt-4o` drafts a pending proposal for every leaf no entry and no
   default answers — prefer a proposer that is not the model you will score. Then `ribo corpus
review ./corpus` shows every proposal with its evidence; confirm, correct, mark absent or
   reject each one. A pending proposal is never judged: eval scores confirmed expectations only.
6. **Measure planned and unplanned under one cap:** `ribo eval --corpus ./corpus --strategy
single-shot --strategy planned --plan ./plan.json --backend claude-cli --model claude-haiku-5-5
--max-spend 1.00 --out ./runs`.
7. **[Compare](/cli/scoring#compare)** the two records. A plan changes how calls are cut and what
   each is asked; whether that helps your corpus is what `eval` and `compare` measure — no accuracy
   improvement is claimed anywhere.

Keep the drafted schema whole. Do not cut it down to the leaves that are cheap to label: a leaf
the reviewer cannot judge is rejected — `ribo corpus review --reject --leaf <path>` — and stays
unmentioned, in no denominator. Prompt instructions stay the author's to write: the proposal pass
never writes them.

[Planning and authoring](/cli/planning) is the detailed reference for all three authoring
commands: their samples, refusals, update forms and the record identity a planned arm carries.
When a plan is worth measuring — and when it is not — is its own question:
[when a plan is worth trying](/cli/planning#when-a-plan-is-worth-trying).

## From documents to scores

If you already have the schema and only need the measuring path, the package ships a small worked
corpus at `node_modules/@azx/ribo-cli/examples/basic-corpus` — synthetic energy-visit notes over
one small schema — and every step below runs against it verbatim. The corpus page embeds the same
committed files.

1. **Pick the fields** the model should read out of your documents.
2. **[Write the schema](/cli/schema)** — one JSON Schema document in OpenAPI 3.0 form, each leaf
   described.
3. **Check it:** `ribo schema inspect node_modules/@azx/ribo-cli/examples/basic-corpus/schema.json`.
4. **[Lay out the corpus](/cli/corpus)**: a `manifest.json`, the schema, one directory per case —
   the example's `service-sheet` case is a document case, a PDF with a text layer and the
   `capture` block every document case declares.
5. **Read what the model will read:**
   `ribo corpus text node_modules/@azx/ribo-cli/examples/basic-corpus`.
6. **Propose, then review, the expected answers.** `ribo corpus propose
node_modules/@azx/ribo-cli/examples/basic-corpus --backend <name> --model <id>` drafts a pending
   proposal for every leaf no entry and no default answers, then `ribo corpus review` shows each
   one with its evidence and records the decision: `--confirm`, a correction (an edit to `value`
   in `case.json`, then `--confirm --leaf`), `--mark-absent --leaf`, or `--reject --leaf`. A
   pending proposal is never judged — eval scores confirmed expectations only. Hand-writing the
   entries in `case.json` — asserted values, declared-absent scopes, and silence where you do not
   know — stays the alternative. Prompt instructions are a separate subject: the proposal pass
   never writes them; they are the author's to write.
7. **[Run `eval` under a spend cap](/cli/spend):**
   `ribo eval --corpus node_modules/@azx/ribo-cli/examples/basic-corpus --backend claude-cli --model claude-haiku-5-5 --strategy single-shot --max-spend 1.00 --out ./runs`.
8. **Read [the report](/cli/scoring)** — the verdict counts beside the three rates, always
   together.
9. **Change one thing and [compare](/cli/scoring#compare):** re-run with a different strategy or
   model, then `ribo compare ./runs/<first>.json ./runs/<second>.json`.

## Where each format is specified

- [Writing a schema for ribo](/cli/schema) — the OpenAPI 3.0 dialect, groups and leaves, what
  `description` does, and what `schema inspect`'s report lines mean.
- [Planning and authoring](/cli/planning) — `schema init`'s samples and scaffolds, `schema plan`'s
  artifact and update forms, the `planned` strategy's refusals and record identity, and
  [when a plan is worth trying](/cli/planning#when-a-plan-is-worth-trying).
- [The corpus format](/cli/corpus) — the manifest, the case file, the expectation statuses, and
  [when a case's inputs disagree](/cli/corpus#when-a-case-s-inputs-disagree).
- [Scoring and comparing runs](/cli/scoring) — the verdicts, the three rates, the run record,
  `compare`'s axes and intersection, and
  [comparing across a corpus edit](/cli/scoring#comparing-across-a-corpus-edit).
- [Spend](/cli/spend) — the estimate, the per-model price rows and fallback, and `--max-spend`.
