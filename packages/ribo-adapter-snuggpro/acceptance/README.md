# Extraction acceptance gate (Phase 4 Task 3)

The extraction-**quality** acceptance test for the built-default extractor. It runs
`singleShotExtractor` against every transcript in the `spikes/extraction-snuggpro/`
corpus (14, as of the vocabulary-neutral rebuild — see `RECONCILIATION.md`), scores
the output with the spike's own `score.mjs`, and asserts the four hazards hold with
hallucination/miss inside a **schema- and backend-matched** committed baseline.

## This is MANUAL — CI never runs it

It makes real inference calls. That is the point (you cannot measure extraction
quality without inference), and it is why the gate is **opt-in by nature**: it lives
under its own `vitest.acceptance.config.ts`, is **not** part of `./check.sh`, and is
**not** matched by any Vitest project the gate runs (`*.manual.ts`, and outside
`src/`). The key-free unit tests for the extractor now live in
`@azx/ribo-extractor-openai` (`single-shot.test.ts`, `openai-chat.test.ts`,
`cli-chat.test.ts`) — request shape, trust boundary, transient-failure
classification, the CLI shape-conformance retry loop — and are the parts that run in
CI.

## Two families of backend, chosen with `RIBO_ACCEPTANCE_BACKEND`

| `RIBO_ACCEPTANCE_BACKEND` | Transport                                      | Needs a key?           | Shape enforced by                                                         |
| ------------------------- | ---------------------------------------------- | ---------------------- | ------------------------------------------------------------------------- |
| `openai` (default)        | `openAiChat` — real OpenAI-compatible endpoint | yes (`OPENAI_API_KEY`) | the endpoint, server-side (`response_format.json_schema`, `strict: true`) |
| `claude-cli`              | `cliChat` shelling the installed `claude` CLI  | no                     | `cliChat` itself, client-side (ajv, with retry)                           |
| `codex-cli`               | `cliChat` shelling the installed `codex` CLI   | no                     | `cliChat` itself, client-side (ajv, with retry)                           |

Without `OPENAI_API_KEY` set AND `RIBO_ACCEPTANCE_BACKEND` left at its `openai`
default, the whole suite **skips** (it never fails for lack of a key). The CLI
backends need no key; if the CLI is not installed, that is a real, reported failure
(a `cliChat` "could not run ... — is it installed and on PATH?" error), never a
silent skip.

A CLI has no `strict: true` — the schema goes into the prompt in words instead, and
`cliChat` finds the JSON, validates it against that same schema with ajv, and
retries (feeding the validation error back in) before giving up. That means a CLI
run measures TWO things a keyed API run never has to separate: whether the reply
even came back the right SHAPE, and whether its CONTENT was accurate. This gate
reports the two separately — see "Shape conformance" below.

## How to run

Openai (needs a key):

```bash
OPENAI_API_KEY=sk-...            # required — bearer token (never committed)
OPENAI_MODEL=gpt-4o-2024-08-06   # optional — default shown
OPENAI_BASE_URL=https://api.openai.com/v1   # optional — point at the Helix proxy in prod

pnpm exec vitest run --config packages/ribo-adapter-snuggpro/vitest.acceptance.config.ts
```

All three env vars on one line:

```bash
OPENAI_API_KEY=sk-... OPENAI_MODEL=gpt-4o-2024-08-06 \
  pnpm exec vitest run --config packages/ribo-adapter-snuggpro/vitest.acceptance.config.ts
```

A CLI backend (no key — `claude` or `codex` must be installed and authenticated on
this machine):

```bash
RIBO_ACCEPTANCE_BACKEND=claude-cli \
  pnpm exec vitest run --config packages/ribo-adapter-snuggpro/vitest.acceptance.config.ts

RIBO_ACCEPTANCE_BACKEND=codex-cli \
  pnpm exec vitest run --config packages/ribo-adapter-snuggpro/vitest.acceptance.config.ts
```

Per-transcript extractor output is written to `acceptance/results/<backend-label>/NN-*.json`
(gitignored — `<backend-label>` is the OpenAI model id for `openai`, or the backend id
itself, e.g. `claude-cli`, for a CLI backend) so you can re-inspect a run or re-score
it by hand:

```bash
node spikes/extraction-snuggpro/score.mjs packages/ribo-adapter-snuggpro/acceptance/results/<backend-label>
```

The gate itself imports `score.mjs`'s scoring functions in-process and reads the
spike corpus **read-only** — it never writes into `spikes/`.

## Shape conformance is reported separately from content accuracy

For a CLI backend, the console report carries its own section:

```
[acceptance] ---- shape conformance (content accuracy is a SEPARATE axis, below) ----
  first-try conforming: 12/14   retried-then-conforming: 1/14   never conforming: 1/14
```

- **first-try conforming** — the CLI's first reply already validated against the
  schema (ajv). This is the number that answers "does this model reliably emit the
  requested shape without hand-holding" — the same question `strict: true` makes
  moot for the `openai` backend.
- **retried-then-conforming** — the first reply did not validate; `cliChat` fed the
  validation error back into a second (or third) prompt and got a conforming reply.
- **never conforming** — every attempt (`cliChat`'s `maxAttempts`, default 3) was
  exhausted without ever producing a conforming object. This makes
  `expect(scored).toBe(slugs.length)` fail below — a "never conforming" transcript
  is a real, reported extraction failure, not a silently-excused one.

For `openai` this whole section reads `n/a` — the endpoint enforces conformance
server-side, so there is no retry loop and nothing to tally.

## What it asserts

The first test is a guard: it checks every `ground-truth/*.json` file is in the
current vocabulary-neutral format and validates against the adapter's real 51-leaf
schema (`ground-truth.mjs`'s own `isNewFormat`/`validateGroundTruth`, not a
hand-rolled key comparison). If the corpus and the adapter diverge again, this
fails loudly instead of letting a run report every field as a miss.

| Check                      | Rule                                                            | Baseline-dependent? |
| -------------------------- | --------------------------------------------------------------- | ------------------- |
| Corpus format/vocabulary   | every ground-truth file is new-format and schema-valid          | no                  |
| Coverage                   | every corpus transcript produces a scoreable (parseable) result | no                  |
| Hazard 1 — fuel axis       | `fuelDropped == 0` and `fuelInvented == 0`                      | no                  |
| Hazard 2 — health silence  | `hHallucinatedPass == 0`                                        | no                  |
| Hazard 3 — R-value         | `rvalueConversion == 0` (no R→band)                             | no                  |
| Hazard 4 — enum paraphrase | `enumWrongMember == 0` and `enumInvalid == 0`                   | no                  |
| Provenance                 | `spanFabricated == 0` and `spanMissing == 0` (100% verbatim)    | no                  |
| Hallucination              | hard rate ≤ committed baseline + 0.5pp                          | **yes**             |
| Miss guard                 | miss rate ≤ committed baseline + 5pp                            | **yes**             |

## Baseline freshness: one file PER BACKEND, each labeled inside

The hallucination/miss rates are only meaningful compared against a run captured
under the SAME schema AND the SAME backend — the field set, enum vocabulary and
prompt all shape what "normal" looks like for a given schema, and a CLI's
free-text-then-validate path is not the same measurement as an endpoint that
enforces shape up front, even against the identical schema. Conflating the two is
exactly what sank this repo's two now-retired per-tool baselines (see below), so
each backend gets its OWN baseline file, all committed to git:

| Backend      | Baseline file                                                                       |
| ------------ | ----------------------------------------------------------------------------------- |
| `openai`     | `baseline.json` (unchanged filename, for continuity with every run before this one) |
| `claude-cli` | `baseline.claude-cli.json`                                                          |
| `codex-cli`  | `baseline.codex-cli.json`                                                           |

Every baseline file carries a `schemaFingerprint` (a sha256 of the frozen JSON
Schema at `../src/__fixtures__/snugg-fields-json-schema.json` — exactly the
artifact the shape contract is built from, whether enforced by the endpoint or
spelled out in a CLI prompt) **and** a `backend` field (`openai:<model>`,
`claude-cli`, or `codex-cli`) recorded INSIDE the JSON, not merely implied by the
filename — so a future copy/rename mistake cannot silently make two incomparable
numbers look comparable.

Each run computes its CURRENT fingerprint and backend identity and compares BOTH to
its own baseline file:

- **Match** — the baseline describes this exact schema and backend. The rate-band
  assertions run as normal.
- **Mismatch, or no baseline file yet** — stale or nonexistent. Asserting against it
  would be meaningless, so the gate instead **reports the numbers and writes a
  fresh baseline** for the current fingerprint and backend, and skips only the two
  rate-vs-history assertions. Every baseline-independent check above (coverage, the
  four hazards, span verbatim-ness) still runs and can still fail the build.

This replaces the two retired per-tool baselines
(`spikes/extraction-snuggpro/results/{codex,opencode}-score.json` — see their
removal commit for what they measured: the old spike's own 23-field flat schema,
graded by the old scorer, run through the `codex`/`opencode` CLIs rather than this
adapter's built extractor). Comparing across schemas — or across tools that were
never running this adapter at all — was never a real signal; the fingerprint AND
the backend identity make that structural instead of accidental.

## Every run writes a committed run record

Alongside the console report, each run writes two files under `acceptance/runs/`,
both committed to git:

| File                            | Write mode  | Contents                                                                                                                     |
| ------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `current-<backend-label>.json`  | overwritten | the full run: aggregates, hazard counts, shape conformance, and a dense verdict grid of every schema leaf × every transcript |
| `history-<backend-label>.jsonl` | appended    | one summary line per run — the trend                                                                                         |

`current` is ~150 KB and is **overwritten** every run, so it stays one file forever;
older grids are recoverable from `git log`. `history` gains ~400 bytes per run.
These are what the docs site's accuracy page renders. There is no publish step and
no flag: the gate always writes them, and `git diff` is the review gate.

**The record is written BEFORE the assertions run**, so a failing run still publishes
its grid — that is the run you most want to inspect. It carries `"passed": false`, and
the page shows it as failed. The persist block in `gate.manual.ts` is fenced with a
`DO NOT MOVE` banner for that reason: the property holds only while it stays above the
first `expect(...)`.

That means a run against a deliberately-broken extractor (see "Watching it fail"
above) WILL leave a bad point in the append-only history if committed. Remove it by
identity rather than hand-editing the file:

```ts
import { openRunStore } from "./run-store.js";
await openRunStore().deleteHistoryEntry("codex-cli", "<capturedAt>");
```

`pruneHistory(label, { keep })` trims the trend; `deleteRun(label)` removes both files
and retires a backend entirely. All three are unit-tested in `run-store.test.ts`, which
runs in `./check.sh` — the store is key-free and hermetic even though the gate is not.

**`acceptance/results/` is different and stays gitignored.** That is the raw
per-transcript extractor output, a debugging aid; the run record is the derived,
committed thing.

The miss guard exists so a degenerate all-`null` output (which scores a perfect 0%
hallucination and is useless) cannot pass.

`confidence` is **not** gated: the spike found a 0.9-confidence hallucination, so it
is uncalibrated and no accept/reject threshold is built on it.

## Watching it fail

The gate must be seen to fail on a real regression, not just pass. To watch a hazard
trip, mutate the extraction and re-run — e.g. force `heatingFuel` to `null` in the
normalization pass (dropping the fuel axis) and the Hazard 1 assertion fails; emit a
`passed` for a silent health test and Hazard 2 fails. Revert after.
