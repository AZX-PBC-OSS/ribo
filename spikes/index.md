# Spikes

A spike is an **investigation with a dated answer**: a question the code could not settle, the
scripts that settled it, and a README saying what came back. Numbered like the ADRs so the record
reads in order, and never rewritten — a spike whose answer was later overturned says so and points
at what replaced it, rather than being edited into agreement with the present.

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
4. **Spikes are outside every gate.** No typecheck, no type-aware lint, not in vitest; Prettier
   formats them and that is all. They are allowed to bit-rot, which is exactly why the README must
   carry the answer: the prose outlives the script.
5. **A spike that writes to a live system says so in its README**, and is reversible by
   construction if it can be.

## The record

| #    | Spike                                                               | Question                                                                      | Status   | Date       |
| ---- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------- | -------- | ---------- |
| 0001 | [`extraction-snuggpro`](./extraction-snuggpro/)                     | Can an LLM extract Snugg Pro fields from a dictated audit at usable accuracy? | Answered | 2026-07-24 |
| 0002 | [`transcription-measurement`](./transcription-measurement/)         | What is on-device WER on real field audio, and is it fast enough?             | Answered | 2026-07-24 |
| 0003 | [`extraction-search-plan`](./extraction-search-plan/)               | Does a plan-then-search extraction beat a single shot?                        | Answered | 2026-07-24 |
| 0004 | [`schema-generation`](./schema-generation/)                         | Can a model partition a schema under a byte cap?                              | Answered | 2026-08-07 |
| 0005 | [`ondevice-acceptance`](./ondevice-acceptance/)                     | Does the platform's on-device model survive a real extraction?                | Answered | 2026-08-27 |
| 0006 | [`managed-three-phase`](./managed-three-phase/)                     | Which phase decomposition fits the managed route's caps?                      | Answered | 2026-09-08 |
| 0007 | [`0007-snuggpro-write-semantics`](./0007-snuggpro-write-semantics/) | Does the vendor honour `Idempotency-Key`, and does a write merge or replace?  | Answered | 2026-09-21 |

**0001–0006 predate the convention and keep their unnumbered directory names for now.** Their
numbers above are assigned by first-commit date and are the real ones; the directories catch up in
a migration change of its own. That is deliberate rather than lazy: `extraction-snuggpro` alone is
referenced from 40 places including `check.sh`, `.gitignore` and `.prettierignore`, where a missed
path pattern silently starts committing results directories. Mixing 63 path edits into a feature
branch makes both harder to review, and the record — this table — is the part that was actually
missing.

Two of them (`managed-three-phase`, `ondevice-acceptance`) have no README at all. The migration
adds one; until then, their answers live in docs 21 and 19 respectively.
