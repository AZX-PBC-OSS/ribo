# 0028. Seeding makes selection a narrowing

Status: Accepted
Date: 2026-09-24

## Context

ADR 0009 rejected group scoping — "this dictation is all HVAC, fill that and skip the rest" — and
it was right on the facts it had. Two verified facts made it unsound:

- The closing trust-boundary parse **requires every top-level group key**. `enveloped()` strips
  top-level `.optional()` and rebuilds with `z.strictObject`.
- A phase's merge **writes only the groups it ran jobs for**.

So scoping `fillPhase` to `["hvac"]` leaves every other key absent and the run dies at the parse.
That ADR concluded: "A planner's decision space is repetition and ordering, not selection. That is
materially thinner than the case for an agentic layer opened with, and it should be weighed before
that layer is built rather than after."

This is that weighing, and the conclusion changes — not because either fact is wrong, but because
ADR 0009 drew a distinction it did not then apply to its own problem:

> **`narrowToAbstained` was kept, and the distinction is the whole decision.** Narrowing skips work
> that is **already done**, so those keys are in the draft and survive the merge's copy. Scoping
> skips work that was **never done**, so those keys never appear at all.

"Already done" is a property of the draft, not of history. A phase that writes a full null envelope
for every group has _done_ that work, in exactly the sense the merge's copy cares about. After it
runs, every key is present and every later phase is a narrowing.

That phase exists. `presencePhase` in core and `systemOnePresencePhase` both seed — the latter's
merge "seeds every group with a full null envelope … without the seed a group whose map is
all-false is MISSING from the fields", which is why `nullEnvelope` is exported from core at all.
The on-device path already depends on this: `spanPhase` "returns one item per group that has at
least one present leaf. A group whose leaves are all absent yields no item and therefore no call."

The managed path has no presence phase. `perGroupExtractor` carries the 467-leaf schema through
all 20 groups for 376k input tokens and 66 calls per transcript (doc 16), and
`systemOnePresencePhase` has shipped since ADR 0021 with nothing consuming it.

## Decision

**Selection is available to any phase list that seeds first.** A phase may skip work for a group
if, and only if, an earlier phase in the same list has already written that group's keys into the
draft. Seeding is the precondition; it is not optional, and it is not a detail of one strategy.

Concretely, for the managed path: a presence phase runs first and seeds every group null, then the
fill narrows to what presence found. This is ADR 0009's `narrowToAbstained` rule applied to a draft
the run itself produced rather than to a previous extractor's output.

**The two presence granularities get different jobs, chosen by the margin each one has.** Spike
0011, over spike 0008's committed results:

|           | operating point | margin                                   | job                                      |
| --------- | --------------- | ---------------------------------------- | ---------------------------------------- |
| **group** | 0.30–0.50       | plateau 0.30 wide, 0 groups lost         | decides which calls to skip              |
| **leaf**  | 0.20            | one leaf — lowest true positive is 0.300 | trims the schema inside a surviving call |

Group presence removes **42.9%** of extraction calls with zero groups lost. Leaf presence removes
**81.4%** of the schema with zero leaves lost. Both from one ~600 ms, ~1k-token request.

The asymmetry is the decision, not an implementation note. Skipping a call is irreversible — the
leaves keep the null seed and nothing revisits them — so it runs on the signal with room to move.
Trimming a schema inside a call that still happens is recoverable, because the group is still
being asked and gap-fill still runs over it, so it may run on the signal with none.

**Leaf presence resolves into three bands, not two.** Below `lo` skip; `[lo, hi)` is an uncertainty
band; at or above `hi` extract. `lo` is the recall floor and must lose nothing; `hi` only decides
how sure a leaf must be to skip the band. At `[0.20, 0.50)` the band is ~13 leaves per transcript
and 95.6% of discussed leaves are already above it, so **band leaves ride along in the same
extraction call**. The band is a residue, not a second pipeline, and it buys no extra call.

**A recovery pass may not be a re-ask.** Jev's per-question probability standard deviation across
identical repeats is ~0.010, an order below the LLM conditions the same cookbooks measure
([nouls](https://docs.typesafe.ai/cookbooks/consistency_noul_cookbook.md),
[choices](https://docs.typesafe.ai/cookbooks/consistency_choice_cookbook.md)). Asking twice
returns the same number. Any recovery step must change the question — after extraction, over
leaves that came back null, with the extraction result as context — or it is not a second opinion.

## Consequences

**ADR 0009 is narrowed, not overturned.** Its two facts stand and its rejection of _unseeded_
scoping stands. What changes is the closing assessment: a planner's decision space includes
selection, provided the plan seeds. Anyone reading 0009 for the planner's scope should read this
next.

**Seeding becomes a load-bearing property of two phases rather than an internal detail.** Core's
`presencePhase` and `systemOnePresencePhase` both seed today, and neither documents it as a
contract that a caller depends on — `systemOnePresencePhase` explains it as protection against a
group vanishing from the fields. It is now also the thing that makes every later narrowing legal.
A future presence implementation that skipped the seed would silently reintroduce ADR 0009's
failure, at the closing parse, far from the change. This wants a test that pins it.

**The ordering constraint is already expressible, and a narrowing phase must declare it.**
`validatePhases` enforces `requires`, which "names PHASE IDS … and a dependency is satisfied only
by the specific named phase appearing earlier in the same list" (ADR 0008), rejecting at
construction with a message naming the id. So a fill phase that narrows declares
`requires: ["presence"]` and a misordered list cannot be built. That is not a new mechanism and
needs no follow-up — but it is a declaration, and the validator explicitly "does not verify what a
phase READS", so omitting it is the way this decision gets silently violated. A narrowing phase
without a `requires` naming its seeder is a bug, and the failure surfaces far away, at the closing
parse, as a missing group key.

That also sets where the eventual planner is constrained: ADR 0008's note that construction
rejection "is the admission control … the repair prompt for the next attempt" applies directly —
a planner emitting seed-less selection gets an id-named rejection rather than a parse failure.

**The measured fractions are on 5 of 20 groups.** The corpus covers 5 groups and 159 leaves; doc
16's 66 calls and 376k tokens are over 20 groups and 467 leaves. 42.9% and 81.4% are measured on
the covered subset. The uncovered groups are ones the corpus never discusses, so the true rate is
plausibly higher — but that is an argument, not a measurement, and the number should not be quoted
against the full schema.

**Nothing here measures what narrowing does to extraction accuracy.** The claim is about work
removed, on the presence signal's own numbers. Whether an extractor given 30 leaves instead of 159
extracts them as well is unmeasured, and producing that comparison needs current-schema extractions
— the same Helix burst-budget wall that blocked spike 0008's probes 8/9. This decision is about
which designs are _sound_; it does not assert the narrowed pipeline is _better_, and it should not
ship without that run.

**It adds a hard dependency on a System One provider to the managed path** if the presence phase is
the System One one. Core's own `presencePhase` is chat-backed and costs one call per group, which
buys back less. That trade is a wiring choice for the preset, not a property of this decision.

**It pulled the transport-agnostic extraction cluster into core, which ADR 0010 had already half
done.** `presenceFillPhase` is transport-agnostic — its imports are the chat seam — so by ADR
0010's rule it belongs beside `presencePhase`, `spanPhase` and `classifyPhase`. Writing it first
into `ribo-extractor-openai` reproduced exactly the mistake ADR 0010 corrected: those three sat in
`ribo-extractor-ondevice` because `threePhaseExtractor`, the on-device _preset_, was there, and
"nothing in them is on-device". This phase sat in `ribo-extractor-openai` because
`perGroupExtractor`, the managed preset, is there, and nothing in it is OpenAI.

Moving the phase alone was not possible: it needs `projectTarget`, `singleShotExtractor` and the
`extraction-common` helpers, which form a closed cluster — they import each other, `zod` and core,
and nothing else. So the cluster moved with it. ADR 0010's reasoning extends to
`singleShotExtractor` cleanly: that ADR kept `threePhaseExtractor` out of core because it is
"genuinely device-specific — device-tuned per-call ceilings, zero retry delay", and single-shot has
no such specificity.

`ribo-extractor-openai` re-exports all of it, ADR 0010's own compatibility approach ("re-exports
the whole seam so no consumer breaks"), so this is additive rather than breaking. The re-exports
are transitional; removing them belongs to ADR 0020's scheduled `ribo-extractor-chat` split, which
this shrinks but does not do. The presets — `perGroupExtractor`, `presenceNarrowedExtractor` — stay
out of core, because a preset is a wiring choice and ADR 0010 drew that line first.
