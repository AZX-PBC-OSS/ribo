# Schema at Scale: Measured

The reason a real target schema doesn't fit in one model call is not "it would extract badly." It's
two independent, documented hard ceilings on a structured-output request — plus a third, tighter
one that turned up only when it started rejecting requests, for one model family. This page is the
reasoning behind [Comparison](/guide/comparison)'s first row and the partition-ceiling note in
[Important Defaults](/guide/important-defaults).

All of it was measured against Snugg Pro, the field-service system of record one of Ribo's own
adapters writes into. Snugg Pro is the example here — the ceilings themselves are vendor limits and
route limits, not anything specific to that API.

## The ceilings a structured-output request has to fit under

Quoted directly from OpenAI's structured-outputs documentation as fetched on 2026-08-06:

- "A schema may have up to 5000 object properties total, with up to 10 levels of nesting."
- "A schema may have up to 1000 enum values across all enum properties."

Both are ceilings on the **whole request schema**, not per field. Ribo's provenance envelope turns
each leaf into its own key plus `value`, `confidence` and `sourceSpan` — four properties where there
was one — before either ceiling is ever tested against a real spec.

## How big the real spec actually is

Walked directly against Snugg Pro's public OpenAPI spec (a snapshot taken 2026-08-06: 91 paths, 117
operations, 61 definitions):

| schema scope                               | raw leaves | enveloped properties | vs. 5,000-property cap  | vs. 1,000-enum cap    |
| ------------------------------------------ | ---------: | -------------------: | ----------------------- | --------------------- |
| `allJobData` — every field the API returns |      1,326 |                5,360 | **over by 360**         | **over by 490**       |
| `basedata` — the capture/write endpoint    |        300 |                1,201 | under (24% of budget)   | under (44% of budget) |
| the pilot schema at that time              |         34 |             ~102–140 | under (~2–3% of budget) | —                     |

`allJobData` is rejected outright, on two independent limits at once, before any question of
extraction quality arises. `basedata` fits with real headroom, at roughly 9× the pilot's leaf count.

**The `allJobData` figure is a named snapshot, not a current count.** A later reconciliation pass
against a fresher spec snapshot (92 paths, 121 operations, 63 definitions) recorded that the API had
drifted since and did not re-derive the 1,326 figure — and separately, `allJobData` isn't even the
same surface as what Ribo writes: it spans every read-only rollup and computed total the API
returns — a different set from the fields the write endpoints accept, and a larger one. Treat
1,326 as illustrative of scale, measured against the named 2026-08-06 snapshot, not as today's
number.

The number that is current: walking every write operation directly, Snugg Pro exposes **837
distinct writable field names**. That's the current count, and the one to cite for the size of the
writable surface. The committed extraction schema's current size is tracked by
`packages/ribo-adapter-snuggpro/src/__fixtures__/snugg-fields-json-schema.json`, a frozen,
test-gated fixture rather than a figure that goes stale here: it covers 467 of those 837 fields, in
20 top-level groups.

## The nullable-union wall: the undocumented cap

The property and enum ceilings above are OpenAI's own documented limits, and they bind at
whole-spec scale. A second, unrelated ceiling binds much sooner, on one model family only, and it
was found by running calls, not by reading documentation.

Measured directly against the managed LLM route Ribo's extractors call through, bisecting one
schema property at a time to isolate which factor actually flips a request from accepted to
rejected: not byte size, not description text, not enum values, not raw property count. The one
factor that separates every accepted schema from every rejected one is the count of **nullable
unions** — the `X | null` shape `enveloped()`'s anti-hallucination rule puts on every leaf's `value`
and `sourceSpan`:

| model             | max nullable unions accepted | enveloped leaves per call |
| ----------------- | ---------------------------: | ------------------------: |
| `claude-sonnet-5` |                           16 |                         8 |
| `claude-opus-5`   |                           16 |                         8 |
| `gpt-4.1`         |                         ≥120 |                      ≥120 |
| `gpt-4o`          |                         ≥120 |                      ≥120 |

16 was accepted; 18 was rejected, on identical schemas differing only in nullable-union count. Since
an enveloped leaf costs two nullable unions (`value` and `sourceSpan`), the working ceiling on the
Anthropic-family side of that table is **8 enveloped leaves per call** — and two of the extraction
groups already committed at the time of this measurement, `hvac` (12 leaves then) and `health` (14
leaves then), already exceeded it. Both groups, and the schema generally, have grown since: the
fixture cited above now puts `hvac` at 46 leaves and `health` at 16; several other groups have since
crossed the 8-leaf bar too.

**This is our own measurement, not published vendor documentation.** It was taken against one
deployment, through one route, with one dev token. Whether 16 is Anthropic's own limit or this
particular route's translation of it is not established here. What is established is that it's
model-family-specific on the identical route — the same schema shape that's rejected for
`claude-sonnet-5` is accepted without complaint for `gpt-4.1` — which rules out a route-wide request
validator and points at the model provider.

## What Ribo does about it

`splitExtractionSchema` (`@azx/ribo-core`) partitions a schema by nullable-union weight,
not by leaf count, against a tunable `MAX_NULLABLE_UNIONS_PER_CALL` (16 by default). A group over the
cap is split into multiple entries sharing one response key, run as separate calls against a bounded
concurrency pool, and reassembled into one result — the same mechanism whether the split is forced
by the byte cap below or by the nullable-union wall above. A follow-up pass re-asks about any leaf
that abstained despite the transcript quoting evidence for it, before the result is treated as
final.

Counting unions rather than leaves matters because provenance granularity changes the cost per leaf:
an enveloped (`"leaf"`) field costs two unions, a row- or none-granularity field costs one — see
[Provenance: Measured](/deep-dives/provenance-measurement) for why that choice exists and how it was
measured. Nothing changes for a schema that's entirely leaf-granularity: the partition boundaries
the old, leaf-counting version of this constant produced are the same ones the union-counting
version produces, verified against the Snugg Pro schema.

## The second wall: what basedata scale costs even after the union fix

Before the nullable-union wall was found, the ceiling this repo designed around was a route-specific
32,768-byte cap on one call's serialized response schema — unrelated to OpenAI's own 120,000-character
limit, and a different number again from the property/enum ceilings above. Synthesizing a
`basedata`-shaped slice at increasing leaf counts, with the vendor's own field descriptions attached:

| leaves in one call | bytes, with descriptions | bytes, descriptions stripped | over the 32,768 cap? |
| -----------------: | -----------------------: | ---------------------------: | -------------------- |
|                 50 |                   32,373 |                       16,623 | no                   |
|                 60 |                   38,804 |                       19,904 | **yes**              |
|                100 |                   64,530 |                       33,030 | yes (stripped too)   |
|                163 |                  105,246 |                       53,901 | yes (321% / 164%)    |

The byte cap breaks between 50 and 60 leaves per call with descriptions attached, and between 90 and
100 without them — well before `basedata`'s full 163 fields. On an OpenAI-family
model that's the wall that binds. On an Anthropic-family model the nullable-union wall binds first,
roughly seven times sooner, at 8 leaves rather than 50–60: a plan that only budgets against the byte
cap is sized for half the model roster.

Reaching `basedata` scale under either constraint needs the same thing: sub-partitioning a group
into calls small enough for whichever ceiling applies to the target model. That partitioning work is
what `splitExtractionSchema` already does per call; scaling it to `basedata`'s size is a matter of
degree, not a new mechanism.

## What this doesn't settle

Nothing here claims a `basedata`-scale schema would **extract well** — only that a request that size
can be submitted at all, under the right partitioning. Extraction quality at that scale is not
measured. And the nullable-union figure above is scoped exactly as stated: one route, one token,
model-family-specific, not confirmed as a published vendor ceiling.
