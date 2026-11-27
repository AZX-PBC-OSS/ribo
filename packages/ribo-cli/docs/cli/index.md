# The ribo CLI

`@azx/ribo-cli` is Ribo's command-line package: six commands for authoring and measuring an
extraction schema before you trust it to a model. `ribo schema init` drafts an evidence-linked
schema from real samples and can scaffold a corpus around them; `ribo schema plan` authors and
updates a reviewed semantic plan over a schema; `ribo schema inspect` sizes a schema — or a plan's
actual packed calls — before the first paid call; `ribo corpus text` shows you exactly what a run
would send; `ribo eval` runs a hand-written corpus of documents through a model backend and scores
the answers; and `ribo compare` lines two scored runs up.

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
| `ribo eval`           | Run a corpus through a backend, score it, persist one record per arm                 | 0, 2       |
| `ribo compare`        | Compare two persisted run records — a difference is a finding                        | 0, 2       |

Every command writes results to stdout and diagnostics to stderr; a refusal (exit 2, or a usage
error) leaves stdout empty. `ribo schema inspect` adds exit 1 for a breached threshold, with the
full report still on stdout. No command accepts a credential on a flag: the `openai-compatible`
backend reads `OPENAI_API_KEY` from the environment or a gitignored `.env.local`, and the
`claude-cli` / `codex-cli` backends spawn the binary you already have installed, on your own
subscription.

## From documents to scores

The package ships a small worked example corpus at
`node_modules/@azx/ribo-cli/examples/basic-corpus` — synthetic energy-visit notes over one small
schema — and every step below runs against it verbatim. The corpus page embeds the same committed
files.

1. **Pick the fields** the model should read out of your documents.
2. **[Write the schema](/cli/schema)** — one JSON Schema document in OpenAPI 3.0 form, each leaf
   described.
3. **Check it:** `ribo schema inspect node_modules/@azx/ribo-cli/examples/basic-corpus/schema.json`.
4. **[Lay out the corpus](/cli/corpus)**: a `manifest.json`, the schema, one directory per case —
   the example's `service-sheet` case is a document case, a PDF with a text layer and the
   `capture` block every document case declares.
5. **Read what the model will read:**
   `ribo corpus text node_modules/@azx/ribo-cli/examples/basic-corpus`.
6. **Write the expected answers** in each case's `case.json` — asserted values, declared-absent
   scopes, and silence where you do not know.
7. **[Run `eval` under a spend cap](/cli/spend):**
   `ribo eval --corpus node_modules/@azx/ribo-cli/examples/basic-corpus --backend claude-cli --model claude-haiku-5-5 --strategy single-shot --max-spend 1.00 --out ./runs`.
8. **Read [the report](/cli/scoring)** — the verdict counts beside the three rates, always
   together.
9. **Change one thing and [compare](/cli/scoring#compare):** re-run with a different strategy or
   model, then `ribo compare ./runs/<first>.json ./runs/<second>.json`.

## The authoring path, end to end

The commands compose into one reviewable workflow, from your own samples to a measured verdict —
the same path the worked example's finished plan
(`node_modules/@azx/ribo-cli/examples/basic-corpus/plan.json`) is the end product of:

1. **Draft:** `ribo schema init ./notes.txt --backend claude-cli --model claude-haiku-5-5 --corpus
./corpus --corpus-name "Field notes" --corpus-provenance real` — the schema alone on stdout (or
   a new file with `--out`), plus a scaffolded corpus whose expectations are empty, because
   expectations are the author's judgement, never the model's.
2. **Review the draft, then size it:** `ribo schema inspect ./corpus/schema.json`.
3. **Plan the calls:** `ribo schema plan ./corpus/schema.json --backend openai-compatible --model
gpt-4o` — the complete plan is on stdout; save it as a file and review the pieces. When the
   schema later drifts, `--update` re-authors it, never in place.
4. **Read what each call will carry:** `ribo corpus text ./corpus` — before writing expectations.
5. **Measure planned and unplanned under one cap:** `ribo eval --corpus ./corpus --strategy
single-shot --strategy planned --plan ./plan.json --backend claude-cli --model claude-haiku-5-5
--max-spend 1.00 --out ./runs`.
6. **[Compare](/cli/scoring#compare)** the two records. A plan changes how calls are cut and what
   each is asked; whether that helps your corpus is what `eval` and `compare` measure — no accuracy
   improvement is claimed anywhere.

[Planning and authoring](/cli/planning) is the detailed reference for all three authoring
commands: their samples, refusals, update forms and the record identity a planned arm carries.

## Where each format is specified

- [Writing a schema for ribo](/cli/schema) — the OpenAPI 3.0 dialect, groups and leaves, what
  `description` does, and what `schema inspect`'s report lines mean.
- [Planning and authoring](/cli/planning) — `schema init`'s samples and scaffolds, `schema plan`'s
  artifact and update forms, and the `planned` strategy's refusals and record identity.
- [The corpus format](/cli/corpus) — the manifest, the case file, the expectation statuses, and
  the one-input-file rule.
- [Scoring and comparing runs](/cli/scoring) — the verdicts, the three rates, the run record, and
  `compare`'s axes and intersection.
- [Spend](/cli/spend) — the estimate, the per-model price rows and fallback, and `--max-spend`.
