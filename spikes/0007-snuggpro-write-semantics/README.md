# 0007 — Snugg Pro write semantics

**Status:** Answered · **Date:** 2026-09-21 · **Target:** Snugg Pro staging, via the Helix dev
gateway (`/_api/fetch/…`), job `588613`

## The question

Before building write-back we needed three things the vendor's OpenAPI document cannot answer, each
of which changes the design rather than a detail of it:

1. Does the vendor honour `Idempotency-Key`? The whole retry story rested on it.
2. Does a write MERGE or REPLACE? If it replaces, a sparse patch silently blanks every field the
   auditor did not mention, and the design needs a read-merge-write step everywhere.
3. What does a partial update do to fields it does not name?

## The answers

**`Idempotency-Key` is IGNORED.** A create, then a byte-identical replay with the same key, returned
`200` with a _different_ uuid. The spec declares no header parameters on any endpoint and never
mentions idempotency. Duplicate protection had to be rebuilt on write receipts — ADR 0017.

**Writes MERGE, and an explicit `null` clears.** Measured on three endpoints covering both shapes:

| Endpoint                      | Shape                                               | Result                                                                |
| ----------------------------- | --------------------------------------------------- | --------------------------------------------------------------------- |
| `POST /jobs/hvac/{uuid}`      | collection update                                   | untouched year, equipment type and upgrade action all survived        |
| `POST /jobs/{jobId}/health`   | singleton upsert, 16 tests all null                 | setting one test then posting a _different_ one left the first intact |
| `POST /jobs/{jobId}/basedata` | singleton upsert, 163 leaves, job already populated | all 22 populated fields survived a one-field write                    |

So an omitted key leaves its field alone and a present `null` clears it — exactly the distinction
the reviewed patch already draws. No read-merge-write step is needed. Recorded in doc 15 §3.3.

**And one thing nobody asked about.** Reading real stored values showed the four thermostat
setpoints hold a _range_ in 36 of 38 populated records (`64-72`, `66-70`, `68-74`). The vendor's own
field description sanctions it — "you may enter a range of temperatures … separated by a dash (no
spaces)" — in the second half of a long paragraph. We had modelled them `z.number()`. Doc 15 §3.4.

## What is here, and what was promoted out

- `basedata-probe.mjs` — the largest-blast-radius merge probe. Snapshots to disk _before_ mutating,
  writes one previously-null field, diffs every populated field, then restores and verifies
  byte-identical. The pattern to copy for any future singleton probe.
- `setpoint-survey.mjs` — read-only. Samples N jobs and buckets a field's real values by shape.
  This is what found the setpoint ranges, and it is the cheapest useful tool here: **before trusting
  a field's declared type, look at what the vendor actually stores in it.**
- `model-probe.mjs` — read-only. Checks the vendor's own derived model still produces sane output
  for a job, used to sanity-check that ranges were not breaking their engine.

**Promoted to a re-runnable gate:** the idempotency replay and the collection/singleton merge
assertions now live in `packages/ribo-adapter-snuggpro/acceptance/write-real.manual.ts`, because
those are facts a vendor can change under us and the whole no-overwrite design rests on them. They
are deliberately NOT duplicated here — this README is the dated record, that file is the check.

**Not kept:** the gateway-token and endpoint-shape scaffolding. It established which credential and
which paths work; the answers are in doc 15 and the generated endpoint table, and the code added
nothing once they were written down.

## Running these

Each reads `HELIX_DEV_TOKEN` from the field app's `.env.local` at runtime and prints no secret.
They are plain Node scripts, outside every gate, and they hit a live vendor:

```
node spikes/0007-snuggpro-write-semantics/setpoint-survey.mjs
node spikes/0007-snuggpro-write-semantics/basedata-probe.mjs 588613
```

`basedata-probe.mjs` WRITES. It is reversible by construction and restores what it touched, but it
writes to a real staging job — read it before running it, and do not point it at production.
