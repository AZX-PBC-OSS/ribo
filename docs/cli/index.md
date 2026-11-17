# The ribo CLI

`@azx/ribo-cli` is Ribo's command-line package: four commands for measuring extraction quality
before you trust a schema to a model. It sizes a JSON Schema document before the first paid call
(`ribo schema inspect`), shows you exactly what a run would send (`ribo corpus text`), runs a
hand-written corpus of documents through a model backend and scores the answers (`ribo eval`), and
lines two scored runs up (`ribo compare`).

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
pages go deeper on the formats.

## The commands at a glance

| Command               | What it does                                                         | Exit codes |
| --------------------- | -------------------------------------------------------------------- | ---------- |
| `ribo schema inspect` | Size a schema in OpenAPI 3.0 form before the first call              | 0, 1, 2    |
| `ribo corpus text`    | Print the text each case's prompt carries — no model call, no key    | 0, 2       |
| `ribo eval`           | Run a corpus through a backend, score it, persist one record per arm | 0, 2       |
| `ribo compare`        | Compare two persisted run records — a difference is a finding        | 0, 2       |

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
4. **[Lay out the corpus](/cli/corpus)**: a `manifest.json`, the schema, one directory per case.
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

## Where each format is specified

- [Writing a schema for ribo](/cli/schema) — the OpenAPI 3.0 dialect, groups and leaves, what
  `description` does, and what `schema inspect`'s report lines mean.
- [The corpus format](/cli/corpus) — the manifest, the case file, the expectation statuses, and
  the one-input-file rule.
- [Scoring and comparing runs](/cli/scoring) — the verdicts, the three rates, the run record, and
  `compare`'s axes and intersection.
- [Spend](/cli/spend) — the estimate, the per-model price rows and fallback, and `--max-spend`.
