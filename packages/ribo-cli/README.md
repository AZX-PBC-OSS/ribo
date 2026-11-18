# @azx/ribo-cli

Ribo's command-line tools for measuring extraction quality before you trust a schema to a model.
The CLI sizes a JSON Schema document before the first paid call, runs a hand-written corpus of
documents through a model backend, scores the answers against what you said was true, and compares
two runs — so a schema change, a strategy change or a model change shows up as numbers, not vibes.

It never holds a credential on a flag: the `openai-compatible` backend reads `OPENAI_API_KEY` from
the environment or a gitignored `.env.local`, and the `claude-cli` / `codex-cli` backends spawn the
`claude` / `codex` binary you already have installed, on your own subscription.

## Install and invoke

```bash
pnpm add -D @azx/ribo-cli
```

If your registry does not carry the `@azx` scope yet, pack the package from the repository
(`pnpm pack` in `packages/ribo-cli`) and install the tarball:
`pnpm add -D ./azx-ribo-cli-<version>.tgz`.

> **Warning: `npx ribo` is not this package.** The bare name `ribo` resolves to an unrelated npm
> package. Invoke this CLI as `npx @azx/ribo-cli`, `pnpm exec ribo`, or
> `./node_modules/.bin/ribo`.

The rest of this README says `ribo` and means one of those three.

## The commands

Output discipline is the same everywhere: results on stdout, diagnostics on stderr, and a refusal
leaves stdout empty. `--json` on the commands that take it emits a versioned JSON contract whose
`contractVersion` the CLI owns.

### `ribo schema inspect [path]`

Sizes a JSON Schema document in OpenAPI 3.0 form before the first model call: how many fields the
schema carries, how ribo would split it into calls, what each strategy costs in calls per attempt,
how many fields carry `description` guidance, and which fields ask a model to reformat (a finding —
the answer should arrive as the source stated it). Reads the file at `<path>`, or stdin when
`<path>` is `-` or absent and stdin is piped.

- **0** — the report was computed and no supplied threshold (`--max-depth`, `--max-piece-chars`)
  was breached.
- **1** — a supplied threshold was breached; the full report is still on stdout.
- **2** — could not run: unreadable file, malformed JSON, not a JSON Schema document, a refused
  draft-2020-12-form document, an unconvertible one, or a usage error.

### `ribo corpus text <corpus-dir> [case-id]`

Prints the text each case's prompt carries: transcript and text cases verbatim, document cases
transcribed locally through the same pdf.js path `ribo eval` uses. No model call, no credential.
With a case id it prints that case alone, without a header; without one, every case under a
per-case header.

- **0** — the text was printed.
- **2** — could not run: an unreadable corpus, an unknown case id, or a document that cannot be
  transcribed (no text layer, or bytes pdf.js cannot open).

### `ribo eval --corpus <dir> --backend <name> --model <id> --strategy <ids> [...]`

Runs a corpus through the eval runner, scores every case against its expected answers, and writes
one run record per arm — under `./ribo-eval-runs/` beside the working directory, or the directory
`--out` names. The report (the arms, their settings, per-case results, totals and record paths)
lands on stdout only once every arm's record is on disk.

- **Backends.** `--backend openai-compatible` POSTs to an OpenAI-compatible `/chat/completions`
  endpoint (`OPENAI_BASE_URL`, default `https://api.openai.com/v1`; the credential is
  `OPENAI_API_KEY` from the environment or `.env.local` — never a flag). `--backend claude-cli`
  and `--backend codex-cli` spawn your installed `claude` / `codex` binary on your own
  subscription, preflighted with `<binary> --version` before the run starts, and need no key.
- **`--model`** is required for every backend; it is the id every call carries, and it is what the
  spend estimate prices.
- **Strategies and ladders.** `--strategy` names one arm: `single-shot`, `per-group` or
  `presence-narrowed`. A comma-separated value is that arm's ordered fallback ladder —
  `--strategy single-shot,per-group` runs per-group only when single-shot fails terminally. Repeat
  the flag to measure more arms; a multi-arm run prints a cross-arm comparison summary to stderr.
- **Consensus.** `--consensus <n>` runs the whole arm as n candidates on the same backend and
  model, decided leaf by leaf; `--consensus-arbiter` picks `unanimous` (the default) or
  `majority`.
- **Spend.** Every run prints an upper-bound cost estimate to stderr before the first model call
  and refuses to start above the ceiling: `--max-spend <usd>` (default USD 10.00), or `--yes` to
  proceed anyway. The estimate is priced per model: a model with its own dated row in the price
  table (the models this README and the docs name — gpt-4o, claude-sonnet-5-5, claude-haiku-5-5)
  is priced on that row; any other model is priced on the backend's reference row, and the
  estimate says it fell back and names the reference.
- **Timeouts.** `--timeout <seconds>` sets the per-call timeout of the CLI backends (default 600;
  a large-document prompt takes a CLI minutes to answer). A call over the limit fails its case
  with a message naming the flag as the fix. On `openai-compatible` the flag is refused up front
  — the HTTP transport has no per-call timeout to set.
- **0** — the run finished; a case that failed is a measurement, not a fault.
- **2** — could not run: a usage error, an unreadable corpus, an invalid setting, a missing
  credential, a missing or non-answering CLI binary, or a refused spend.

### `ribo compare <a> <b>`

Lines two persisted run records up and reports their axes — the identity fields that differ
(backend, model, settings, run fingerprint) — then the leaf-and-case intersection with each
side's exclusion counts, then every cell whose verdict changed. A difference is a finding, never
a failure. Records from different corpora are refused unless `--allow-corpus-mismatch` is passed,
and the override is recorded in the report.

- **0** — the comparison was computed.
- **2** — could not run: a usage error, an unreadable or malformed record, differing corpora
  without the override, no shared leaf, or — under the override — no shared case.

## From documents to scores

A worked example corpus ships inside the package at
`node_modules/@azx/ribo-cli/examples/basic-corpus` — the same files the docs site embeds. Every
command below runs against it verbatim; substitute your own directory once the shape is familiar.

1. **Pick the fields.** Decide what the model should read out of your documents. The example asks
   for a home's address and year built, its heating fuel and last service date, and a list of
   recommended upgrades.
2. **Write the schema.** One JSON Schema document in OpenAPI 3.0 form — top-level objects are
   groups, arrays of objects are collections, `enum` constrains a leaf, `"nullable": true` marks a
   leaf that may hold no value, and each leaf's `description` is the guidance the model reads. The
   example's is
   [`examples/basic-corpus/schema.json`](https://ribo-docs.azx.helix.azxlabs.io/cli/corpus.html).
   The dialect, in full: <https://ribo-docs.azx.helix.azxlabs.io/cli/schema.html>.
3. **Check it with `schema inspect`.**
   `ribo schema inspect node_modules/@azx/ribo-cli/examples/basic-corpus/schema.json` — every
   field described, no refusals, and the call counts per strategy.
4. **Lay out the corpus.** A directory holding `manifest.json`, the schema, and one subdirectory
   per case. A case is its `case.json` plus exactly one input file — `input.txt` for the
   `transcript` and `text` kinds, `input.pdf` for a `document` case (which needs a text layer; a
   scan without one is refused before any model call). The format, in full:
   <https://ribo-docs.azx.helix.azxlabs.io/cli/corpus.html>.
5. **Read each case's text with `corpus text`.**
   `ribo corpus text node_modules/@azx/ribo-cli/examples/basic-corpus` — what the model will read,
   for free.
6. **Write the expected answers.** Each case's `expected` maps a dotted leaf path to an
   `asserted` value (with optional `alternatives` and a `sourceSpan`) or a `declared-absent`
   entry; a leaf you say nothing about is simply not judged, and a `defaults` entry declares a
   whole scope absent at once. The example's `morning-visit` case shows both kinds.
7. **Run `eval` under a spend cap.**
   `ribo eval --corpus node_modules/@azx/ribo-cli/examples/basic-corpus --backend claude-cli --model claude-haiku-5-5 --strategy single-shot --max-spend 1.00 --out ./runs`.
   Read the estimate on stderr before you confirm anything — it is an upper bound, priced per
   model.
8. **Read the report.** stdout carries one arm entry per `--strategy`: its settings, one result
   per case, the totals — the verdict counts beside the answer rate, the accuracy over answered
   and the accuracy over all, always together — and the record path. What each verdict and rate
   means: <https://ribo-docs.azx.helix.azxlabs.io/cli/scoring.html>.
9. **Change one thing and `compare`.** Re-run with one axis moved — a different `--strategy`, a
   different `--model`, an edited schema — then
   `ribo compare ./runs/<first>.json ./runs/<second>.json`. The report names the axes that
   differed and every cell whose verdict changed. How the records line up:
   <https://ribo-docs.azx.helix.azxlabs.io/cli/scoring.html#compare>.

## The docs

The full CLI section of the docs site:

- [Overview and install](https://ribo-docs.azx.helix.azxlabs.io/cli/index.html)
- [Writing a schema for ribo](https://ribo-docs.azx.helix.azxlabs.io/cli/schema.html)
- [The corpus format](https://ribo-docs.azx.helix.azxlabs.io/cli/corpus.html)
- [Scoring and comparing runs](https://ribo-docs.azx.helix.azxlabs.io/cli/scoring.html)
- [Spend: the estimate and the ceiling](https://ribo-docs.azx.helix.azxlabs.io/cli/spend.html)

## License

MIT
