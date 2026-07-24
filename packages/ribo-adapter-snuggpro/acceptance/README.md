# Extraction acceptance gate (Phase 4 Task 3)

The extraction-**quality** acceptance test for the built-default extractor. It runs
`singleShotExtractor` (over `openAiChat`) against all 14 transcripts in
`spikes/extraction-snuggpro/`, scores the output with the spike's own `score.mjs`,
and asserts the four hazards hold with hallucination inside the committed baseline
band.

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

| Check                      | Rule                                                         | Committed baseline        |
| -------------------------- | ------------------------------------------------------------ | ------------------------- |
| Coverage                   | all 14 transcripts produce a scoreable result                | 14/14                     |
| Hazard 1 — fuel axis       | `fuelDropped == 0` and `fuelInvented == 0`                   | 0 / 0                     |
| Hazard 2 — health silence  | `hHallucinatedPass == 0`                                     | 0                         |
| Hazard 3 — R-value         | `rvalueConversion == 0` (no R→band)                          | 0                         |
| Hazard 4 — enum paraphrase | `enumWrongMember == 0` and `enumInvalid == 0`                | 0                         |
| Provenance                 | `spanFabricated == 0` and `spanMissing == 0` (100% verbatim) | 100%                      |
| Hallucination              | hard rate ≤ widest committed baseline + 0.5pp                | codex 0.5%, opencode 1.0% |
| Miss guard                 | miss rate ≤ widest committed baseline + 5pp                  | ~0–1%                     |

The hallucination and miss bands are computed **at run time** from
`spikes/extraction-snuggpro/results/{codex,opencode}-score.json`, so the gate tracks
the committed baseline rather than a hardcoded number. The miss guard exists so a
degenerate all-`null` output (which scores a perfect 0% hallucination and is
useless) cannot pass.

`confidence` is **not** gated: the spike found a 0.9-confidence hallucination, so it
is uncalibrated and no accept/reject threshold is built on it.

## Watching it fail

The gate must be seen to fail on a real regression, not just pass. To watch a hazard
trip, mutate the extraction and re-run — e.g. force `heatingFuel` to `null` in the
normalization pass (dropping the fuel axis) and the Hazard 1 assertion fails; emit a
`passed` for a silent health test and Hazard 2 fails. Revert after.
