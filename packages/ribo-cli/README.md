# @azx/ribo-cli

Ribo's command-line tools for measuring extraction quality before you trust a schema to a model.
The CLI drafts a schema from real samples, authors a reviewed semantic plan over it, sizes both
before the first paid call, runs a hand-written corpus of documents through a model backend, scores
the answers against what you said was true, and compares two runs — so a schema change, a plan
change or a model change shows up as numbers, not vibes.

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

### `ribo schema init <samples...>`

Drafts an evidence-linked OpenAPI schema from real samples — each sample a direct text file or an
existing corpus case folder with exactly one declared input — and optionally scaffolds a corpus
beside it. The draft's expectations and instructions stay empty: a draft never invents what your
documents should answer. Without `--out`, stdout is the complete schema alone; `--out` names a
distinct new file and never overwrites an existing path. Spend is estimated to stderr before the
first call and refused above `--max-spend`.

- **0** — the schema was drafted and reached stdout or the new `--out` file.
- **2** — could not run: usage, input, transcription, backend, model, spend or output refused
  the run; stdout empty.

### `ribo schema plan <schema>`

Authors a reviewed **semantic plan** over the schema — the ordered, named pieces that say which
leaves one call reads together — or, with `--update <plan>`, re-plans a stored one. A plan is
validated for exact coverage: every schema leaf in a piece exactly once, no invented paths.

**Freshness.** An update compares the stored plan with the current schema without a model call:
_unchanged_; _fingerprint-only_ (bytes moved, membership did not — one note, still valid); or
_stale_ (field membership drifted), which is what `ribo eval` refuses and what the update fixes.

**The two update output forms.** Both write the complete artifact; the update never modifies the stored input plan:

- without `--out`, the complete JSON artifact is on stdout — redirect it where you like;
- with `--out <file>`, the complete artifact is written to that distinct new file and stdout stays
  empty.

- **0** — the plan was authored and the complete artifact reached stdout or the new `--out` file.
- **2** — could not run: usage, input, backend, model, spend or output refused the run; stdout
  empty.

### `ribo schema inspect [path]`

Sizes a JSON Schema document in OpenAPI 3.0 form before the first model call: how many fields the
schema carries, how ribo would split it into calls, what each strategy costs in calls per attempt,
how many fields carry `description` guidance, and which fields ask a model to reformat (a finding —
the answer should arrive as the source stated it). Reads the file at `<path>`, or stdin when
`<path>` is `-` or absent and stdin is piped.

With `--plan <path>`, the report gains the plan's semantic pieces and the **actual planned packed
calls** the plan produces under the split caps, plus core's plan fingerprint.

The exit codes, and what each leaves on stdout:

- **0** — the report was computed and no supplied threshold (`--max-depth`, `--max-piece-chars`)
  was breached.
- **1** — a supplied threshold was breached; the full report is still on stdout. The measurement
  ran; the number is the finding, not a fault.
- **2** — could not run, and stdout stays empty: unreadable file, malformed JSON, not a JSON Schema
  document, a refused draft-2020-12-form document, an unconvertible one, a usage error — or an
  **unbuildable plan**, which is exit 2 with no report whether or not `--max-piece-chars` was
  supplied: nothing that cannot be built into calls can be measured.

Threshold rows name the layout they judged: the schema's nesting depth is shared — `--max-depth`
judges it under every layout; without a plan, `--max-piece-chars` judges the rule-based worst piece; only with `--plan` does it judge the planned packed calls. A piece the packer splits across
calls is named `<piece name> — call <i> of <n>`, one-based.

### `ribo corpus text <corpus-dir> [case-id]`

Prints the combined text each case's prompt carries: the case's declared inputs, joined in list
order — capture markers included when the manifest does not turn them off; document inputs
transcribed locally through the same pdf.js path `ribo eval` uses. No model call, no credential.
With a case id it prints that case alone, without a header; without one, every case under a
per-case header.

- **0** — the text was printed.
- **2** — could not run: an unreadable corpus, an unknown case id, or a document input that
  cannot be transcribed (no text layer, or bytes pdf.js cannot open).

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
- **Strategies and ladders.** `--strategy` names one arm: `single-shot`, `per-group`,
  `presence-narrowed` or `planned`. A comma-separated value is that arm's ordered fallback ladder —
  `--strategy single-shot,per-group` runs per-group only when single-shot fails terminally. Repeat
  the flag to measure more arms; a multi-arm run prints a cross-arm comparison summary to stderr.
- **The planned strategy.** `--strategy planned --plan <path>` executes a reviewed schema plan's
  pieces as the call layout. Two refusal directions, both before any work: **planned without `--plan`**
  is refused — the strategy has nothing to execute — and **`--plan` without a planned rung** is
  refused — an ordinary arm must not inherit a plan's identity silently. The plan is
  checked against the corpus schema before preflight, transcription or spend: a **stale** plan is
  refused with the drift named; an **unbuildable** plan is refused with the construction error —
  exit 2, no report, no records. Fingerprint-only drift prints one note and the run continues.
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
- **Records and identity.** A planned arm's record carries the plan's fingerprint in an **optional
  `settings.planFingerprint`** — additive at record version 1, derived by the runner from core's
  plan, never typed by hand. old v1 records and planned v1 records share one version and one
  directory; an older reader that has never heard of the field still reads a planned record, while
  older strict readers refuse one — the settings key is what they have never seen, so strictness,
  not the version, does the distinguishing.
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
`node_modules/@azx/ribo-cli/examples/basic-corpus` — the same files the docs site embeds, with its
finished plan at [`examples/basic-corpus/plan.json`](examples/basic-corpus/plan.json). Every
command below runs against it verbatim; substitute your own directory once the shape is familiar.

1. **Gather samples.** The raw material is what your documents actually say — a dictated site
   note, a transcript, a worksheet. Start from real inputs, not an imagined field list; the
   drafting command is evidence-linked and cannot propose more than the samples support.
2. **Draft the schema with `schema init`.**
   `ribo schema init ./notes.txt --backend claude-cli --model claude-haiku-5-5 --out ./schema.json`
   — an evidence-linked OpenAPI draft, every leaf's guidance grounded in what a sample said. Then
   **review it yourself**: the model proposed, you own the result. With `--corpus`, the same run
   scaffolds a corpus whose expectations and instructions stay empty — filling those is your
   judgement, never the draft's.
3. **Pick the fields.** Decide what the model should read out of your documents. The example asks
   for a home's address and year built, its heating fuel and last service date, and a list of
   recommended upgrades.
4. **Write the schema.** One JSON Schema document in OpenAPI 3.0 form — top-level objects are
   groups, arrays of objects are collections, `enum` constrains a leaf, `"nullable": true` marks a
   leaf that may hold no value, and each leaf's `description` is the guidance the model reads. The
   example's is [`examples/basic-corpus/schema.json`](examples/basic-corpus/schema.json). The
   dialect, in full: [docs/cli/schema.md](docs/cli/schema.md) (online:
   <https://ribo-docs.azx.helix.azxlabs.io/cli/schema.html>).
5. **Check it with `schema inspect`.**
   `ribo schema inspect node_modules/@azx/ribo-cli/examples/basic-corpus/schema.json` — every
   field described, no refusals, and the call counts per strategy.
6. **Author the plan with `schema plan`.**
   `ribo schema plan ./schema.json --backend openai-compatible --model gpt-4o --out ./plan.json`
   — named semantic pieces, each the set of leaves one call should read together. Review the
   pieces: their names, descriptions and membership are the authoring decision the planned
   strategy executes. When the schema later changes and the plan goes **stale**,
   `ribo schema plan ./schema.json --update ./plan.json --out ./plan.next.json` re-plans the
   membership and reports what moved — complete artifact on stdout or to the distinct new
   `--out` file, never modifying the stored input plan.
7. **Read the committed plan.** The example ships one finished artifact,
   [`examples/basic-corpus/plan.json`](examples/basic-corpus/plan.json). Authoring and review, in
   full:
   [docs/cli/planning.md](docs/cli/planning.md) (online:
   <https://ribo-docs.azx.helix.azxlabs.io/cli/planning.html>).
8. **Lay out the corpus.** A directory holding `manifest.json`, the schema, and one subdirectory
   per case. A case is its `case.json` plus its input files, declared as a non-empty ordered
   `inputs` list — each entry a `file` directly in the case folder and a `kind` (`transcript`,
   `text`, or `document`; a document entry also carries a `capture` block with `capturedAt` and
   `pageCount`, and its PDF needs a text layer — a scan without one is refused before any model
   call). A case's inputs are joined in list order into one text — capture markers on by
   default, `"combine": { "markCaptures": false }` in the manifest to turn them off — and that
   one text is extracted once and scored once per case. The example's `service-sheet` is the
   two-input case: the worksheet PDF first, then a `site-note.txt` note. The format, in full:
   [docs/cli/corpus.md](docs/cli/corpus.md) (online:
   <https://ribo-docs.azx.helix.azxlabs.io/cli/corpus.html>).
9. **Read each case's text with `corpus text`.**
   `ribo corpus text node_modules/@azx/ribo-cli/examples/basic-corpus` — what the model will read,
   for free.
10. **Write the expected answers.** Each case's `expected` maps a dotted leaf path to an
    `asserted` value (with optional `alternatives` and a `sourceSpan`) or a `declared-absent`
    entry; a leaf you say nothing about is simply not judged, and a `defaults` entry declares a
    whole scope absent at once. The example's `morning-visit` case shows both kinds, and its
    `service-sheet` case — a worksheet that says nothing the schema asks — shows the blanket form:
    one `defaults` entry declaring every scope absent.
11. **Run the per-group arm under a spend cap.**
    `ribo eval --corpus node_modules/@azx/ribo-cli/examples/basic-corpus --backend claude-cli --model claude-haiku-5-5 --strategy per-group --max-spend 1.00 --out ./runs`.
    Read the estimate on stderr before you confirm anything — it is an upper bound, priced per
    model.
12. **Run the planned arm against it.** Add the plan as a second arm in one run:
    `ribo eval --corpus node_modules/@azx/ribo-cli/examples/basic-corpus --backend claude-cli --model claude-haiku-5-5 --strategy planned --plan ./plan.json --out ./runs`
    — the plan is checked against the corpus schema before preflight, transcription or spend, so a
    stale or unbuildable plan costs nothing.
13. **Read the report.** stdout carries one arm entry per `--strategy`: its settings, one result
    per case, the totals — the verdict counts beside the answer rate, the accuracy over answered
    and the accuracy over all, always together — and the record path. Each record persists under
    `./runs/`; a planned record's settings carry the optional `settings.planFingerprint` the
    runner derived from the plan. What each verdict and rate means:
    [docs/cli/scoring.md](docs/cli/scoring.md) (online:
    <https://ribo-docs.azx.helix.azxlabs.io/cli/scoring.html>).
14. **Change one thing and `compare`.** Re-run with one axis moved — a different `--strategy`, a
    different `--model`, an edited schema — then
    `ribo compare ./runs/<first>.json ./runs/<second>.json`. The report names the axes that
    differed and every cell whose verdict changed. How the records line up — planned and
    unplanned, one record version — and what each rate means:
    [docs/cli/scoring.md](docs/cli/scoring.md#compare) (online:
    <https://ribo-docs.azx.helix.azxlabs.io/cli/scoring.html#compare>).
15. **In production, execute the plan through core, not the CLI.** The same plan artifact runs in
    a host application with two core exports:

    ```ts
    import { parseSchemaPlan, plannedExtractor } from "@azx/ribo-core";

    const plan = parseSchemaPlan(planArtifact, target.extractionSchema);
    const extract = plannedExtractor({ target, plan, chat, model });
    ```

    The CLI is the measuring bench; production imports `@azx/ribo-core`. No claim is made that a
    plan improves accuracy — it changes how calls are cut, and whether that helps is what
    `eval` and `compare` measure.

## The docs

The full CLI docs ship inside the package — the same pages the docs site renders:

- [Overview and install](docs/cli/index.md) — online:
  <https://ribo-docs.azx.helix.azxlabs.io/cli/index.html>
- [Writing a schema for ribo](docs/cli/schema.md) — online:
  <https://ribo-docs.azx.helix.azxlabs.io/cli/schema.html>
- [Planning and authoring](docs/cli/planning.md) — online:
  <https://ribo-docs.azx.helix.azxlabs.io/cli/planning.html>
- [The corpus format](docs/cli/corpus.md) — online:
  <https://ribo-docs.azx.helix.azxlabs.io/cli/corpus.html>
- [Scoring and comparing runs](docs/cli/scoring.md) — online:
  <https://ribo-docs.azx.helix.azxlabs.io/cli/scoring.html>
- [Spend: the estimate and the ceiling](docs/cli/spend.md) — online:
  <https://ribo-docs.azx.helix.azxlabs.io/cli/spend.html>

## License

MIT
