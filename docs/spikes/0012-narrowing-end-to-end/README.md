# 0012 — Presence narrowing, end to end

**Status:** Answered · **Date:** 2026-10-29 · **Target:** the Foundry resource in `.env.local` —
chat model `gpt-5.6-luna`, presence on Microsoft-Decision-1 (deployment `md-1`) and on hosted Jev

## The question

ADR 0027 licensed narrowing the managed extractor behind a presence phase, and spike 0011 measured
how much work presence would remove. Both said the same thing was missing: nobody had run
`presenceNarrowedExtractor` against the extractor it would replace and compared what came out.

So: does a narrowed run extract what `perGroupExtractor` extracts, and what does it save?

## The answer

**As shipped, no. Narrowing lost about a third of the stated values. The run found three defects,
and once they were fixed it matches the baseline to within this corpus's noise, at about half
the wall time and a third of the chat tokens.**

| run                               | md-1 miss | Jev miss | md-1 health | Jev health |
| --------------------------------- | --------- | -------- | ----------- | ---------- |
| baseline (`perGroupExtractor`)    | 1.2%      | 1.2%     | 100%        | 100%       |
| as shipped — bare path, singleton | 35.5%     | 28.1%    | 85.2%       | 87.1%      |
| + enum members in the question    | 22.5%     | 20.3%    | 87.0%       | 88.0%      |
| + collection asked for its array  | 18.0%     | 15.0%    | 87.0%       | 88.5%      |
| + a stated decline counts         | **2.3%**  | **2.3%** | **97.6%**   | **98.1%**  |

Miss is the scorer's all-leaves figure, the one it says to quote: a value the ground truth states
that the run left null, health matrix included. Health is the scorer's health-matrix state
accuracy. Hallucination stayed between 0.5% and 0.8% in every run; the baseline's is 0.7%.

## Three defects, each a silent loss

Each defect left a stated value null, and a null is also what an honest "nobody said it" looks
like. Nothing failed, nothing was reported. `diagnose.mjs` attributes every lost value to presence
(the leaf was never asked for), the fill (it was asked and came back null), or a second instance.

**1. The presence question named a wire path.** `systemOnePresencePhase` asked "Is the field
`"dhw.dhwType2"` discussed in the transcript?". That names nothing a model can match against
speech. Spike 0008's probe 10, the measurement behind the phase's recall 1.000, described each
enum leaf by its members instead. `reask-described.mjs` asked probe 10's form again for every
value presence had dropped below the threshold: 21 of 21 cleared it on md-1, and 13 of 13 on Jev.
The question now states an enum leaf's members.

**2. A collection group was asked for one instance.** `presenceFillPhase` projected every group to
a singleton, so a transcript with three heating systems got one back. That lost 7 values on each
arm, all second and third appliances in transcripts 05 and 08. Presence decides which leaves to
ask about, never how many instances exist, so a collection is now asked for its array. The
returned instances replace the seed's single null one.

**3. A blanket decline was not "discussed".** "No tests" and "no safety tests" (transcripts 11 and 14) assert that every health test was not done, without naming one. The question said "a field
merely implied is no", so presence scored all 13 tests absent, the fill was never asked, and the
ground truth's `"Not Tested"` came back null. Probe 10's wording had said "including explicitly
declining to give a value". The question now counts a statement that a field was not done, not
checked or not known, made about the field alone or as part of a set it belongs to.

Two alternatives were rejected for defect 3. Always filling the health group whole hard-codes one
group, and the corpus already has a second blanket set (`blowerDoor`, two leaves inside
`basedata`). A group-level "was a set declined?" question assumes declined sets line up with schema
groups, and that one doesn't.

## What it costs

Means per transcript over 14 runs, except wall time, which is the median.

| arm                 | wall p50 | chat calls | chat in tok | chat out tok | presence in tok |
| ------------------- | -------- | ---------- | ----------- | ------------ | --------------- |
| baseline            | 20.2s    | 22.0       | 132,884     | 10,011       | —               |
| md-1, array fill    | 9.4s     | 5.4        | 21,361      | 1,486        | 35,215          |
| Jev, array fill     | 6.7s     | 6.9        | 26,911      | 1,655        | 33,399          |
| **md-1, all three** | 10.8s    | 8.5        | 36,664      | 2,603        | 49,327          |
| **Jev, all three**  | 9.0s     | 10.8       | 48,947      | 3,466        | 47,070          |

The decline wording costs tokens rather than data. Presence says yes more often, so more fields
reach the fill. Presence itself is 5 requests of 100 questions. At Decision-1's $0.042 per
million input tokens, it is about $0.002 a run.

The baseline is the field app's split (`maxSerializedCharsPerGroup: 32_768`, no union cap): 22
calls, measured here. The "66 calls / 376k tokens" that ADR 0027 and spike 0011 quote is spike
0008's probe 8 run (`extract-haiku.log`), on the split of that time and a different model. It is
not today's baseline.

## What is still wrong

- **Transcript 11:** `healthLead` stays null on both arms. That's 1 of the 13 declined tests.
- **Transcript 07:** md-1 dropped one stated `"Passed"` (`healthUndilutedFlueCo`).
- **Transcript 14:** "Everything else was a no-go … nothing else today" now also fills
  `healthRoofCondition` and `healthDrainageSystemCondition` with `"NA"`. The ground truth keeps
  those two out of `healthTests` deliberately: they are visual condition checks, not tests. You
  could read the sentence either way, but it is the one place the wider wording overshoots.
- **Hallucination rose to the baseline's rate** (md-1 0.5% → 0.8%, Jev 0.6% → 0.8%, baseline
  0.7%). The new cases are the baseline's kind, and about half are the same cells: inferred
  ambient CO, safety overviews, notes, foundation percentages. Asking the fill about more fields
  makes it behave more like the baseline.

## Decision-1 against Jev, as a presence model

After the fixes the two are level on accuracy. Jev is faster (9.0s against 10.8s p50). md-1 sends
the fill fewer groups (8.5 calls against 10.8), so it uses fewer chat tokens. Spike 0008's probe comparison
(its 2026-10-29 addendum) found md-1's leaf presence keeps recall 1.000 up to a 0.40 threshold,
where Jev's holds only to 0.30. That margin did not show up as a difference end to end at 0.20.
The latency is from an eastus2 `GlobalStandard` deployment. A nearby `DataZoneStandard` one is
unmeasured.

## Things found on the way

- **A hung connection outlives the retry budget.** Transcript 01's narrowed cells took 1515s and
  1918s. The Foundry connections hung until Node fetch's 300s header timeout fired, more than once
  per cell. Re-run minutes later they took 23s and 9s, with identical token counts, and
  `summarize.mjs` uses the re-run. Both cells ran well past the 15-minute deadline `run.mjs`
  passes. The retry budget assumes a call ends within `PER_CALL_CEILING_MS` (120s), but that
  constant only feeds the budget arithmetic. Nothing on the chat path enforces it.
- **Leaf presence is not a "~1k-token request".** ADR 0027 says that, but the ~1k figure is the
  group router's (probe 2). Leaf presence here is 5 requests and 33k–49k input tokens per
  transcript, because every question carries its own instructions. It is still cheap; the
  ADR's figure is wrong.
- **Snugg's rule 9 claims a write-layer default that ribo does not have.** The Snugg instructions
  say "the write layer later renders an un-asserted test as Snugg's 'Not Tested'". Ribo's
  `write/body.ts` passes `null` through, and the vendor clears the field. Whether Snugg Pro then
  displays a cleared test as "Not Tested" is unverified. Either way, the review screen shows an
  empty field where the auditor said something, which is why defect 3 is a loss, not a rendering
  detail.

## What is NOT measured

- **Synthetic corpus, one run.** 14 transcripts, 13 scored (02 is the few-shot example), each run
  once. At this size, 2.3% against 1.2% is a few cells either way. "Matches the baseline" means
  "within that", not "equal".
- **5 groups.** The corpus covers 5 of the schema's 20 groups, as in spike 0011.
- **Real audio.** Nothing here ran on a field recording.

No ADR. Nothing here changes a decision. `presenceNarrowedExtractor` stays opt-in, and the field
app does not use it. The three fixes are bugs against ADR 0027's design, not new design. Making
narrowing the default is the decision that would need one, after a run on real recordings.

## Running these

Needs `AZURE_AI_FOUNDRY_API_KEY`, `AZURE_AI_FOUNDRY_OPENAI_BASE_URL` and `TYPESAFE_API_KEY` in
the repo-root `.env.local`, and built packages. Arms are interleaved per transcript, so drift in
the chat deployment's load lands on all of them.

```bash
pnpm build:packages
node docs/spikes/0012-narrowing-end-to-end/run.mjs                  # baseline, md-1, jev
TAG=decline node docs/spikes/0012-narrowing-end-to-end/run.mjs 99 md-1,jev
ONLY=01-attic-r-value-shell node docs/spikes/0012-narrowing-end-to-end/run.mjs   # one cell
node docs/spikes/0001-extraction-snuggpro/score.mjs docs/spikes/0012-narrowing-end-to-end/results/md-1
node docs/spikes/0012-narrowing-end-to-end/diagnose.mjs
SYSTEMONE=md-1 node docs/spikes/0012-narrowing-end-to-end/reask-described.mjs
node docs/spikes/0012-narrowing-end-to-end/summarize.mjs
```

The per-arm extraction outputs (`results/<arm>/`) are not committed; the metrics, the score
reports and the diagnosis are. The `-pathonly` and `-singleton` files are the earlier runs in the
table above, kept so each step's effect stays checkable.
