# 0011 — Narrowing the managed extractor with a presence pass

**Status:** Answered · **Date:** 2026-09-24 · **Target:** arithmetic over spike 0008's committed
results — no new API calls, no new corpus

## The question

`perGroupExtractor` carries the 467-leaf schema through all 20 groups: **376k input tokens and 66
calls per transcript** (doc 16). ADR 0009 ruled out the obvious fix — scoping a fill phase to the
groups a dictation touches — because the closing trust-boundary parse requires every top-level
group key, so a scoped fill leaves keys absent and the run dies. It closed by observing that this
leaves "a planner's decision space … repetition and ordering, not selection", and asked for that to
be weighed.

Spike 0008 measured a System One presence signal at two granularities and shipped
`systemOnePresencePhase`. Nothing consumes it: the **only** presence phase consumer in the repo is
`threePhaseExtractor`, on the on-device path. The managed path has none.

So: how much of that 376k / 66 survives a presence pass, and does anything real die?

## The answer

**Group presence removes 42.9% of extraction calls with zero groups lost. Leaf presence removes
81.4% of the schema with zero leaves lost.** Both from one ~600 ms request.

And the reason it is sound where ADR 0009's scoping was not is a single line in that ADR:

> **Narrowing** skips work that is **already done**, so those keys are in the draft and survive the
> merge's copy. **Scoping** skips work that was **never done**, so those keys never appear at all.

A presence phase **seeds every group with a full null envelope** — that is what
`systemOnePresencePhase`'s merge does, and why it needed `nullEnvelope` exported from core. After
it runs, every key is in the draft, so the fill is a refiner and ADR 0009 permits it by its own
rule. The on-device path already relies on this: `span-phase`'s plan "returns one item per group
that has at least one present leaf. A group whose leaves are all absent yields no item and
therefore no call."

Seeding first is what converts the unsound operation into the sound one. Recorded as ADR 0028.

## The two signals have very different margins, and that decides their jobs

| threshold | calls kept | skipped | % saved | groups wrongly skipped |
| --------- | ---------- | ------- | ------- | ---------------------- |
| 0.20      | 43         | 27      | 38.6%   | 0                      |
| 0.30      | 40         | 30      | 42.9%   | **0**                  |
| 0.40      | 40         | 30      | 42.9%   | **0**                  |
| 0.50      | 40         | 30      | 42.9%   | **0**                  |
| 0.60      | 34         | 36      | 51.4%   | 1 — `wall`             |
| 0.80      | 32         | 38      | 54.3%   | 2 — `hvac`, `wall`     |

**Group presence has a 0.30-wide plateau** where the outcome does not change and nothing is lost.
A threshold that can move that far without changing the answer is one a new transcript cannot
fall off.

**Leaf presence has no plateau at all.** Spike 0008 recorded its recall 1.000 as "one leaf wide",
and the number reproduces here: the lowest discussed leaf sits at exactly **0.300** against an
operating threshold of 0.20. There is one leaf of headroom.

So the two get different jobs, matched to the evidence each one carries:

- **Group presence decides which calls to skip** — irreversible, so it runs on the signal with room.
- **Leaf presence trims the schema inside a surviving call** — recoverable, because the group is
  still being asked and gap-fill still runs over it.

## Three bands, not two

Two bands force one threshold to be both the recall floor and the work floor. Three separate them:
`lo` is the recall floor and must lose nothing; `hi` only decides how sure a leaf must be to skip
the middle.

| band             | skip  | band | extract | touched  | discussed leaves lost |
| ---------------- | ----- | ---- | ------- | -------- | --------------------- |
| [0.20, 0.40)     | 129.4 | 10.2 | 19.4    | 29.6     | 0                     |
| **[0.20, 0.50)** | 129.4 | 12.9 | 16.7    | **29.6** | **0**                 |
| [0.20, 0.60)     | 129.4 | 14.9 | 14.6    | 29.6     | 0                     |
| [0.15, 0.50)     | 120.6 | 21.7 | 16.7    | 38.4     | 0                     |

Per transcript, out of 159 leaves. **159 → ~30 touched, 81.4% of the schema dropped, nothing lost.**

**The band is a residue, not a second pipeline.** 129 of 135 discussed leaves — 95.6% — are already
above 0.50. So the middle band is ~13 leaves, and the cheapest way to honour it is to **include
those leaves in the same extraction call**. There is no second call to pay for; the band's whole
job is "do not skip these", and at 13 leaves honouring it is free.

## Re-asking Jev is not a recovery mechanism

The obvious way to rescue a false negative is to ask again and take the union. It does not work
here, and the vendor's own cookbooks are why.

Both self-consistency cookbooks —
[nouls](https://docs.typesafe.ai/cookbooks/consistency_noul_cookbook.md) and
[choices](https://docs.typesafe.ai/cookbooks/consistency_choice_cookbook.md) — resample the
**identical** question 15 times with a throwaway `uid`. Jev's mean per-question probability
standard deviation is **0.0102** (nouls) and **0.0098** (choices), against 0.0245–0.0543 for the
LLM conditions. Their headline is that "the LLM answers
move from run to run, at temperature `0` too, and on the judgment calls the models disagree with
_themselves_" — and Jev does not. A second identical call returns the same number.

What those cookbooks do instead is exactly the three-band shape above: below 0.30 no, 0.30–0.70
uncertain, above 0.70 yes. The band **is** the recovery mechanism.

A recovery _phase_ still earns its place, but only if it asks a different question — after
extraction, over leaves that came back null, with the extraction result as context. That is a
different question, not a repeat. Reframing is the one lever measured to move this family: spike
0008's escape arm took invention from 100% to 1.4%, and spike 0010 took hallucination-catching
from 15.5% to 75.6% on identical weights, both purely by changing the question's shape. Not built
here.

## What is NOT measured

**The corpus covers 5 groups, not 20.** Every figure above is over 14 transcripts × 5 groups and
14 × 159 leaves. Doc 16's 66 calls and 376k tokens are over the full 20-group, 467-leaf schema.
**42.9% of 66 is not a measured claim** — the fraction is measured on the covered subset, and
whether it holds across the other fifteen groups is unknown. The uncovered groups are the ones the
corpus's transcripts never discuss, so if anything the true skip rate is higher; that is an
argument, not a measurement.

**No end-to-end run.** Nothing here ran `perGroupExtractor` behind a presence phase and compared
extraction accuracy. These are the presence signal's own numbers, and the claim is about how much
work it removes — not about what removing that work does to the result. That is the probe to run
before building, and it hits the same Helix burst-budget wall that blocked spike 0008's probes 8/9.

## An aside, from the same data and not pursued here

Probe 3's `bare` arm — Jev picking an enum member for every leaf with no "not stated" escape —
produced a value for 100% of the fields nobody mentioned. Read as extraction that was fatal. Read
as a **suggestion** list a contractor accepts or dismisses, 634 high-confidence (≥0.90) proposals
across 14 audits break down as:

- **51.4%** negative/absence defaults — `No`, `None`, `No Treatment`, `Unknown`
- **39.0%** `*Improved` fields — post-upgrade values, i.e. proposed retrofit scope, not observations
- **9.6%** positive guesses about the home

So Jev's reliable direction is **absence**, which is the same property this spike's narrowing
rests on. Two hazards if that is ever built: `*Improved` proposes work a homeowner gets quoted for
and should never ride an "accept all"; and `hvacDuctLeakage = "Measured (CFM25)"` was suggested in
10 of 14 audits, which asserts a test was performed. Recorded here so the numbers are not lost;
the feature is not designed.

## Running these

Pure arithmetic over `../0008-typesafe-jev/results/`. No credential, no network, no model.

```bash
node docs/spikes/0011-presence-narrowing/analyze-groups.mjs
node docs/spikes/0011-presence-narrowing/analyze-leaves.mjs
```

## Sources

Vendor documentation read for this spike. Fetched 2026-09-24; Mintlify serves the Markdown of any
page by appending `.md`, which is what these links do.

- [Self-consistency: nouls](https://docs.typesafe.ai/cookbooks/consistency_noul_cookbook.md) and
  [self-consistency: choices](https://docs.typesafe.ai/cookbooks/consistency_choice_cookbook.md) —
  the resampling design and the ~0.010 stability figure the "no re-ask" decision rests on, plus the
  three-band shape (below 0.30 no / 0.30–0.70 uncertain / above 0.70 yes).
- [Known issues in Jev 1.13](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md) — "accuracy
  falls as the state grows with content unrelated to the decision. Filter and retrieve in code
  first", which is the vendor's own argument for narrowing what each call sees.
- [State](https://docs.typesafe.ai/concepts/state.md) — "all questions see the same state and are
  evaluated independently", i.e. one request carries every presence question at once.
- [Documentation index](https://docs.typesafe.ai/llms.txt) — the page list these were found from.
