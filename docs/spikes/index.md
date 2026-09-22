# Spikes

A spike is an **investigation with a dated answer**: a question the code could not settle, the
scripts that settled it, and a README saying what came back. Numbered like the ADRs so the record
reads in order, and never rewritten — a spike whose answer was later overturned says so and points
at what replaced it, rather than being edited into agreement with the present.

They live under `docs/` because that is what they are: findings, with the evidence beside them.
They are **excluded from the built docs site** (`.vitepress/config.ts`'s `srcExclude`), alongside
`roadmap/` and `implementation/` — a spike is a working record, not a published page, and several
carry corpora and result trees that have no business in a site build.

## What belongs here, and what does not

A probe produces three separable things, and they have different shelf lives. Route them
separately, or the "do we commit this?" argument happens every time:

| You have                                                                | Where it goes                                                                   |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| A **finding** and nothing that can change it                            | A doc or an ADR. The code dies in the scratchpad.                               |
| A finding that **a dependency can change under you**                    | A re-runnable gate: `packages/*/acceptance/*.manual.ts`, opt-in and outside CI. |
| An **investigation** — several scripts, a corpus, results worth keeping | A numbered directory here, with a README.                                       |
| Scaffolding that got you there                                          | Nowhere. Delete it.                                                             |

The three are not exclusive: spike 0007 is a numbered record here _and_ promoted two of its
assertions into a manual gate, because the vendor can change them. It says so rather than keeping
two copies of the same probe.

## The rules

1. **`NNNN-kebab-name/`**, numbered in date order, with a `README.md`.
2. The README opens with **Status** (`Answered`, `Abandoned`, `Superseded by …`) and **Date**, then
   the question, then the answer. The answer is the point — a spike with scripts and no stated
   conclusion is scaffolding someone committed.
3. **Findings get written down somewhere durable** — a doc, or an ADR if the finding drove a
   decision — and the README links there. The spike is the evidence, not the home of record.
4. **Spikes are outside every gate.** No typecheck, no type-aware lint, not in vitest, not in the
   docs site; Prettier formats them and that is all. They are allowed to bit-rot, which is exactly
   why the README must carry the answer: the prose outlives the script.
5. **A spike that writes to a live system says so in its README**, and is reversible by
   construction if it can be.

## The record

| #    | Spike                                                                 | Question                                                                      | Status   | Date       |
| ---- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------- | -------- | ---------- |
| 0001 | [`0001-extraction-snuggpro`](./0001-extraction-snuggpro/)             | Can an LLM extract Snugg Pro fields from a dictated audit at usable accuracy? | Answered | 2026-07-24 |
| 0002 | [`0002-transcription-measurement`](./0002-transcription-measurement/) | What is on-device WER on real field audio, and is it fast enough?             | Answered | 2026-07-24 |
| 0003 | [`0003-extraction-search-plan`](./0003-extraction-search-plan/)       | Does a plan-then-search extraction beat a single shot?                        | Answered | 2026-07-24 |
| 0004 | [`0004-schema-generation`](./0004-schema-generation/)                 | Can a model partition a schema under a byte cap?                              | Answered | 2026-08-07 |
| 0005 | [`0005-ondevice-acceptance`](./0005-ondevice-acceptance/)             | Does the platform's on-device model survive a real extraction?                | Answered | 2026-08-27 |
| 0006 | [`0006-managed-three-phase`](./0006-managed-three-phase/)             | Which phase decomposition fits the managed route's caps?                      | Answered | 2026-09-08 |
| 0007 | [`0007-snuggpro-write-semantics`](./0007-snuggpro-write-semantics/)   | Does the vendor honour `Idempotency-Key`, and does a write merge or replace?  | Answered | 2026-09-21 |
| 0008 | [`0008-typesafe-jev`](./0008-typesafe-jev/)                           | Where does a System One model (TypeSafe's Jev) fit ribo's pipeline?           | Answered | 2026-09-21 |

Numbers are assigned by first-commit date. The three sharing 2026-07-24 arrived in one squashed
initial release and are ordered by the doc that reports each (01, 14, 16).

**0001–0006 predate the convention and were migrated into it wholesale**, which rewrote 209
references across 78 files — including `.gitignore`'s fifteen result-tree patterns, `.prettierignore`
and `check.sh`'s `score:mutations` stage. That was worth doing in one pass rather than two: moving
the tree under `docs/` touched every one of those references anyway, so deferring the numbering
would have meant paying the same cost twice.

**0006 and 0005 still have no README.** Their answers live in docs 21 and 19 respectively; rule 2
is not satisfied until someone who knows what they concluded writes one. Recorded here rather than
quietly tolerated — an index that hides its own gaps is worth less than one that names them.
