# Extraction acceptance gate (Phase 4 Task 3)

The extraction-**quality** acceptance test for the built-default extractor. It runs
`singleShotExtractor` (over `openAiChat`) against every transcript in the
`spikes/extraction-snuggpro/` corpus (14, as of the vocabulary-neutral rebuild —
see `RECONCILIATION.md`), scores the output with the spike's own `score.mjs`, and
asserts the four hazards hold with hallucination/miss inside a **schema-matched**
committed baseline.

## This is MANUAL and needs a key — CI never runs it

It makes real, keyed inference calls to an OpenAI-compatible endpoint. That is the
point (you cannot measure extraction quality without inference), and it is why the
gate is **opt-in by nature**: it lives under its own `vitest.acceptance.config.ts`,
is **not** part of `./check.sh`, and is **not** matched by any Vitest project the
gate runs (`*.manual.ts`, and outside `src/`). The key-free unit tests for the
extractor now live in `@azx/ribo-extractor-openai` (`single-shot.test.ts`,
`openai-chat.test.ts`) — request shape, trust boundary, transient-failure
classification — and are the parts that run in CI.

Without `OPENAI_API_KEY` set, the whole suite **skips** (it never fails for lack of
a key).

## How to run

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

Per-transcript extractor output is written to `acceptance/results/<model>/NN-*.json`
(gitignored) so you can re-inspect a run or re-score it by hand:

```bash
node spikes/extraction-snuggpro/score.mjs packages/ribo-adapter-snuggpro/acceptance/results/<model>
```

The gate itself imports `score.mjs`'s scoring functions in-process and reads the
spike corpus **read-only** — it never writes into `spikes/`.

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

## Baseline freshness: `baseline.json`

The hallucination/miss rates are only meaningful compared against a run captured
under the SAME schema — the field set, enum vocabulary, and prompt all shape what
"normal" looks like. `baseline.json` (sibling of this file, committed to git)
carries a `schemaFingerprint`: a sha256 of the frozen JSON Schema at
`../src/__fixtures__/snugg-fields-json-schema.json`, exactly the artifact sent to
the model — so the fingerprint changes iff what the model is asked for changes.

Each run computes the CURRENT fingerprint and compares it to `baseline.json`:

- **Match** — the baseline describes this exact schema. The rate-band assertions
  run as normal.
- **Mismatch, or no `baseline.json` yet** — the committed baseline is stale (or
  this is the first run against this schema). Asserting against it would be
  meaningless, so the gate instead **reports the numbers and writes a fresh
  `baseline.json`** for the current fingerprint, and skips only the two
  rate-vs-history assertions. Every baseline-independent check above (coverage,
  the four hazards, span verbatim-ness) still runs and can still fail the build.

This replaces the two retired per-tool baselines
(`spikes/extraction-snuggpro/results/{codex,opencode}-score.json` — see their
removal commit for what they measured: the old spike's own 23-field flat schema,
graded by the old scorer, run through the `codex`/`opencode` CLIs rather than this
adapter's built extractor). Comparing across schemas — or across tools that were
never running this adapter at all — was never a real signal; the fingerprint makes
that structural instead of accidental.

The miss guard exists so a degenerate all-`null` output (which scores a perfect 0%
hallucination and is useless) cannot pass.

`confidence` is **not** gated: the spike found a 0.9-confidence hallucination, so it
is uncalibrated and no accept/reject threshold is built on it.

## Watching it fail

The gate must be seen to fail on a real regression, not just pass. To watch a hazard
trip, mutate the extraction and re-run — e.g. force `heatingFuel` to `null` in the
normalization pass (dropping the fuel axis) and the Hazard 1 assertion fails; emit a
`passed` for a silent health test and Hazard 2 fails. Revert after.
