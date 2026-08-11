# Extraction Accuracy Report — Design

**Date:** 2026-08-11
**Status:** Approved, not implemented
**Scope:** `packages/ribo-adapter-snuggpro/acceptance/`, `docs/deep-dives/`

Make the extraction-quality numbers the acceptance gate already measures **visible** — to an
engineer mid-prompt-change and to a stakeholder asking "is this good enough yet" — by persisting
each run as a committed artifact and rendering it on the docs site.

## 1. What already exists, and what is actually missing

The accuracy harness is **already built**. `packages/ribo-adapter-snuggpro/acceptance/gate.manual.ts`
runs `singleShotExtractor` over the 14-transcript `spikes/extraction-snuggpro/` corpus, scores it
with the spike's own `score.mjs`, and asserts four hazards, span verbatim-ness, and
hallucination/miss rates against a per-backend committed baseline. Three backends are selectable
via `RIBO_ACCEPTANCE_BACKEND` (`openai`, `claude-cli`, `codex-cli`). It is manual and opt-in by
design, outside `./check.sh`, because it makes real inference calls.

What is missing is **not measurement — it is persistence and presentation.** Today a run prints a
console report and writes per-transcript extractor output to `acceptance/results/`, which is
gitignored. Nothing accumulates. Nobody who is not at a terminal ever sees a number, and there is
no way to ask "did that prompt change help, and which fields moved?" without re-running and
eyeballing two consoles side by side.

This design adds exactly that: a persisted run record, a small CRUD interface over run records,
and a docs page.

### Explicitly out of scope

- **Running inference from a Helix app.** Considered and deferred. Display and trigger are
  separable concerns; display is what unblocks the stated goal. A Helix-hosted harness would
  additionally exercise the production LLM route (`response_format`/json_schema, model allowlist,
  budget) — a genuine benefit — but it costs a manifest, approvals, a deploy and an LLM budget, and
  it is strictly a second **producer** of the same run record this design defines. Nothing here
  forecloses it.
- **Changing what is measured.** The scorer, corpus, hazards and baselines are untouched.
- **Putting the gate in CI.** It stays manual. `docs:build` likewise stays out of `check.sh`.

## 2. Decisions

| #   | Decision                                                               | Rationale                                                                                                |
| --- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| D1  | Display-only; no inference in the viewer                               | Separable from triggering; unblocks the goal at a fraction of the cost                                   |
| D2  | Full per-cell detail, not aggregates only                              | Serves both audiences; `scoreTranscript` already computes it and the gate discards it                    |
| D3  | Artifacts are producer-owned, under `acceptance/`                      | They carry the gate's semantics (`schemaFingerprint`, `backend`), siblings of the baselines              |
| D4  | No publish flag; the gate always writes, `git diff` is the review gate | A promote step you must remember yields an empty trend; a wrong committed point is visible and deletable |
| D5  | Two artifacts: one overwritten grid, one appended history              | Keeps full drill-down without repo bloat, and keeps the trend                                            |
| D6  | The docs page lives under Deep Dives                                   | Existing section, existing editorial stance ("measured numbers, a floor, not marketing")                 |
| D7  | Store code is flat in `acceptance/`, never in `src/`                   | It imports `node:fs`; `src/` compiles into the published browser bundle                                  |

## 3. Artifacts

Under `packages/ribo-adapter-snuggpro/acceptance/runs/` (data only), all committed:

| File                      | Write mode  | Approx. size | Contents                                                                                                                                     |
| ------------------------- | ----------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `current-<backend>.json`  | overwritten | 40–60 KB     | one run in full: aggregates, hazard counts, shape conformance, and a dense verdict grid of 51 leaves × 14 transcripts, with per-cell detail  |
| `history-<backend>.jsonl` | appended    | ~400 B/run   | one line per run: `capturedAt`, `schemaFingerprint`, `backend`, `model`, `hallRate`, `missRate`, hazard counts, shape conformance, pass/fail |

`baseline*.json` is **unchanged**. `acceptance/results/` stays gitignored — raw extractor output
remains a debugging aid; the run record is the derived, committed thing.

`<backend>` is the existing `backendLabel` (`gate.manual.ts:134`): the OpenAI model id for
`openai`, otherwise the backend id. Every artifact carries `schemaFingerprint` and `backend`
**inside** the file, not merely implied by the filename — the same rule the baselines already
follow, for the same reason (a rename must not silently make two incomparable numbers look
comparable).

### Why the grid is densified on write

`scoreTranscript()` returns _sparse_ problem lists (`hallucinations`, `misses`, `wrong`,
`badSpans`, `axis`, `health`, `conformance`), all keyed by leaf path. A consumer could infer
"absent from every list ⇒ fine", but could not distinguish `correct` from `correctNull` without
reading the corpus ground truth. Densifying to all 714 cells costs ~40 KB and makes the artifact
**self-contained**: the docs build reads one file and needs nothing from `spikes/`.

### Why append-only history, and its one wrinkle

History is append-only, so a bad run that gets committed leaves a permanent bogus point. This is
accepted deliberately, and `deleteHistoryEntry` (below) is the remedy. A visible wrong point that
can be deleted by identity beats a trend that is silently empty because nobody ran a promote
command.

## 4. The run store

```
acceptance/run-record.ts     # zod schemas: RunRecord, HistoryEntry, BackendId
acceptance/run-store.ts      # the CRUD interface
acceptance/run-store.test.ts # hermetic, runs in check.sh
acceptance/runs/             # data
```

```ts
export function openRunStore(opts?: { dir?: string }): RunStore;

export interface RunStore {
  // C + U — one call. Overwrites `current` (temp + rename), then appends one
  // `history` line, in that order.
  saveRun(run: RunRecord): Promise<void>;

  // R
  readCurrent(backend: BackendId): Promise<RunRecord | null>;
  readHistory(backend: BackendId): Promise<HistoryEntry[]>;
  listBackends(): Promise<BackendId[]>;

  // D
  deleteHistoryEntry(backend: BackendId, capturedAt: string): Promise<void>;
  deleteRun(backend: BackendId): Promise<void>;
  pruneHistory(backend: BackendId, opts: { keep: number }): Promise<void>;
}
```

The three delete operations are deliberately distinct, because "remove a run" is three different
intents:

- `deleteHistoryEntry(backend, capturedAt)` — drop **one bogus trend point**, leaving `current`
  alone. The common case: a run against a deliberately-broken extractor got committed.
- `pruneHistory(backend, { keep })` — trim the trend to the newest N. Maintenance, not correction.
- `deleteRun(backend)` — remove **both** `current-<backend>.json` and `history-<backend>.jsonl`
  for that backend, i.e. retire a backend entirely. `listBackends()` stops reporting it and the
  page stops showing a column for it.

Two properties this shape buys:

- **`openRunStore({ dir })` mirrors `openOutbox({ storage })`** ([AGENTS §5.5](../../../AGENTS.md)).
  The directory is injected and defaults to `./runs`, so the store's own tests run against a temp
  dir and never touch the committed tree.
- **zod at the boundary** ([AGENTS §4](../../../AGENTS.md)). `RunRecord` and `HistoryEntry` are
  parsed on read, not cast — persisted records crossing a trust boundary. A hand-edited or
  half-written line fails loudly at the docs build rather than rendering as a garbage data point.

**File placement is load-bearing.** The store imports `node:fs`, and everything under
`packages/ribo-adapter-snuggpro/src/` compiles into the published, browser-targeted `dist/`.
Putting the store in `src/` would reintroduce exactly the defect commit `deceacd` fixed by moving
`cliChat` out of `@azx/ribo-extractor-openai`. The files are also **flat** in `acceptance/`, not
nested under `runs/`, because the root vitest `unit` project's glob is
`packages/ribo-adapter-snuggpro/acceptance/*.test.{ts,tsx}` — one level, not `**`. Flat placement
means the store's tests run in `check.sh` with **no config change**, and it matches the existing
`cli-chat.ts` / `cli-chat.test.ts` pairing.

## 5. Gate integration

One change to `gate.manual.ts`: build a `RunRecord` and call `saveRun()` **immediately after
`aggregate()` (`:275`), before the first assertion.**

That ordering is the point. A run that _fails_ its hazard assertions is precisely the run whose
grid you want to open — "hazard 2 tripped, which transcript, which field, what did it say?" If
`saveRun` sat after the assertions (or in the baseline block at `:431`), the first `expect` throws
and the interesting run publishes nothing. Writing before asserting makes the artifact a record of
**what the run measured**, independent of whether it passed.

The consequence is intended: `current-<backend>.json` may hold a failing run and `history` may gain
a failing point. The record carries an explicit pass/fail so the page shows it as such rather than
implying green.

Everything else is reuse:

- `backendLabel` (`:134`) and the `schemaFingerprint` sha256 already computed for the baseline check
- `GENERIC_LEAF_PATHS` and `HEALTH_TEST_PATHS`, both already exported from `score.mjs`, for the grid
- the CLI shape-conformance tally (first-try / retried / never) already built for the console report;
  `n/a` for `openai`

No new dependency, no new script, no flag. The gate does what it does today and writes two files.

## 6. The docs page

**`docs/deep-dives/accuracy.md`**, fed by **`docs/deep-dives/accuracy.data.ts`** — a VitePress
`defineLoader`. The loader runs in Node at build time and calls
`openRunStore({ dir: "…/acceptance/runs" })` directly, so there is exactly one definition of the
artifact format, zod-parsed. `watch` on the run files gives HMR in `docs:dev`. Output remains fully
static, so "deployable anywhere" is unaffected.

Deep Dives is the right section: the docs-site plan already reserves it for measured numbers,
citing the transcription measurements (doc 14) as the model, with the explicit stance "a floor, not
marketing." The spec you are reading stays internal — `docs/roadmap/**` is `srcExclude`d from the
public build — while the report page is public. That is acceptable because the Snugg Pro schema is
public and the corpus is synthetic.

Reaching into `packages/` from the docs build introduces no new coupling: the Reference section
already generates from `packages/*/src/index.ts` via TypeDoc.

Three bands, matching the two audiences:

1. **Headline** — one row per backend: hall rate, miss rate, the four hazards as pass/fail, span
   verbatim %, shape conformance, run time. The complete stakeholder answer, above the fold, no
   interaction required.
2. **Trend** — hall rate and miss rate over `history`, per backend. Hand-rolled inline SVG. Two
   series over a few dozen points does not justify a charting dependency, and adding one would be a
   deliberate decision under [AGENTS §5.4](../../../AGENTS.md) rather than an incidental detail of
   this feature.
3. **Drill-down** — the grid as **51 leaf rows × 14 transcript columns**, not the transpose. Tall
   and narrow fits a docs content column; 51 columns would require horizontal scrolling and be
   unreadable. Each row carries a rollup ("11/14 correct"); each cell is colour-coded by verdict and
   expands on click to expected / got / source span / verdict detail.

## 7. Failure modes

| Situation                                  | Behavior                                                                                                                                                                                                                                |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runs/` missing or empty                   | `readCurrent` → `null`; page renders "no accuracy runs published for this backend". Never a broken build, never an implied zero                                                                                                         |
| Malformed `history` line                   | zod throws at load, naming file and line — loud, not a silent garbage point                                                                                                                                                             |
| Run's `schemaFingerprint` ≠ current schema | Page renders a prominent **stale** banner and still shows the data. Not a throw: the numbers are real, just measured against a retired field set. A page presenting confident numbers from a dead schema is strictly worse than no page |
| Interrupted `saveRun`                      | `current` written temp-then-rename, history appended after — a crash cannot leave a history point referencing a grid that was never written                                                                                             |
| Gate assertions failed                     | Artifact still written (§5); record carries pass/fail; page marks the run failed                                                                                                                                                        |

## 8. Testing

**In `check.sh`** (hermetic, no inference, injected temp dir — picked up by the existing
`acceptance/*.test.ts` glob):

- `saveRun` → `readCurrent` / `readHistory` round-trip; `current` overwritten, `history` appended
- densification: a synthetic report set yields exactly 51 × 14 cells with correct verdicts
- zod rejects a malformed `history` line, naming file and line number
- `deleteHistoryEntry` removes by `capturedAt`, leaving neighbours intact
- `pruneHistory({ keep })` retains the newest N
- an interrupted write leaves no half-written `current`

**Not covered, stated honestly:**

- The gate's own write path — it needs a real backend, and the gate is manual by design.
- The docs page render. `docs:build` is outside `check.sh` per the docs-site plan's explicit
  constraint, so a broken loader would not be caught by CI. Mitigation: keep the loader thin — it
  calls the store and hands data to the template, with the store's zod parse doing the real
  validation. Pulling `docs:build` into the code gate is rejected; the docs plan excludes it for
  good reasons.

## 9. Definition of done

- `acceptance/run-record.ts`, `run-store.ts` and `run-store.test.ts` exist; store tests run and pass
  under `./check.sh` with no vitest config change.
- A manual gate run writes `runs/current-<backend>.json` and appends `runs/history-<backend>.jsonl`,
  **including when its assertions fail**.
- `pnpm docs:dev` renders the accuracy page from committed artifacts; `pnpm docs:build` emits it
  statically.
- With `runs/` empty, `docs:build` succeeds and the page says so.
- With a mutated schema fixture, the page shows the stale banner.
- `./check.sh` is green.
