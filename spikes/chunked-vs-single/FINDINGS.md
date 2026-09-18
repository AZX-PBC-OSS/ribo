# Chunking a collection group inflates its instance count

**Date:** 2026-09-18 · **Model:** `gpt-5.6-luna` · **Corpus:** the 14 `extraction-snuggpro`
transcripts · **Group:** `hvac` · **Budget:** 600 chars, forced

The first measurement of `chunkedExtractor` against real dictation. The question was whether
splitting a transcript loses anything a single pass finds. The answer is worse than "loses": for a
**collection** group it _fabricates instances_, reliably.

## Result

| transcript                | chunks | hvac single → chunked | lost | found |
| ------------------------- | ------ | --------------------- | ---- | ----- |
| 01-attic-r-value-shell    | 3      | 1 → **3**             | 6    | 6     |
| 02-oil-boiler-basement    | 2      | 1 → **2**             | 0    | 2     |
| 03-quick-exterior-short   | 1      | 0 → **1**             | 0    | 0     |
| 04-fuel-stated-separately | 2      | 1 → **2**             | 0    | 1     |
| 05-full-walkthrough       | 13     | 2 → **11**            | 11   | 15    |
| 06-homeowner-crosstalk    | 3      | 1 → **3**             | 0    | 1     |
| 07-combustion-safety      | 4      | 1 → **4**             | 0    | 0     |
| 08-no-fuel-silent-drop    | 4      | 2 → **3**             | 6    | 5     |
| 09-chatter-and-scheduling | 3      | 1 → **3**             | 0    | 0     |
| 10-crawlspace-loose-units | 4      | 1 → **4**             | 4    | 5     |
| 11-ambiguous-attic        | 3      | 1 → **3**             | 2    | 3     |
| 12-wrong-field-old-unit   | 3      | 1 → **3**             | 1    | 1     |
| 13-enum-paraphrase        | 4      | 1 → **4**             | 8    | 8     |
| 14-rapid-recap            | 2      | same                  | 0    | 0     |

**Instance count inflated in 13 of 14 transcripts.** Calls: 14 → 51 (3.6×).

## What is actually happening

**The instance count tracks the chunk count.** 3 chunks → 3 instances, 4 → 4, 13 → 11. Each chunk
sees a fragment of one furnace's description, dutifully reports a furnace, and the merge
concatenates them. One physical unit becomes one instance per chunk that mentions it.

**Of 38 "lost" leaves, 32 reappear at a different instance index with the same value.** They were
not lost — the instance was _split_. `01-attic` is the clean example: `hvac.0.*` loses Natural Gas /
Trane / TUD100 / 2017 / 100000, and `hvac.1.*` gains exactly those five values. Six leaves vanish
outright; the rest are relocation, not loss.

So the failure is not "chunking finds less". It is "chunking shreds one entity into several partial
ones", which then reach review as several records to link or create.

## What this means for the design

**Concat-by-default is not a safe default for a collection group.** SP3's design chose it over
index-wise merging because index-wise merging _splices different entities into one_ — silently, with
citations. That reasoning was right and the choice is still better than the alternative: this
failure is visible (several suspiciously-partial units in review) where the other is invisible (one
plausible unit that never existed). But "better than the silent failure" is not "safe", and the
current default produces a wrong instance count on essentially every real transcript with a
collection.

The options, in the order they should be considered:

1. **Refuse collection groups unless `alignInstances` is supplied.** Construction-time, like
   `assertLeafGranularity`. A caller chunking a schema with a collection is asking for this failure,
   and the type can stop them. Cheapest and most honest.
2. **Ship a matcher that can say `"same"`.** `contradictionMatcher` deliberately never does, because
   agreement on identifying fields is not identity (two identical furnaces). But that argument is
   about _distinct_ records agreeing; here the evidence is a single entity split across adjacent
   chunks, which is a different problem and may admit a different rule — adjacency, for instance.
3. **Accept it and document it loudly.** Weakest, and the numbers above argue against it.

## Honest limits of this measurement

- **The 600-char budget is forced and unrealistic.** These transcripts are 700–2000 chars; a real
  context window would give one chunk and measure nothing. This reproduces the _mechanism_ at
  higher density than a real long document would, so the rate is an upper bound on how often a
  boundary bisects an entity — but the mechanism itself is not an artefact.
- **`03-quick-exterior-short` produced ONE chunk and still differed** (0 → 1 instance). With one
  chunk the two paths run identical input, so that difference is model nondeterminism, not chunking.
  Some of the leaf-level lost/found counts elsewhere will be the same noise. The instance-count
  inflation is too systematic to be explained that way, but the leaf counts should be read as
  indicative rather than exact.
- One group (`hvac`), one model, one run, n=14. No repeats, so no variance estimate.
- Singleton groups were not measured. The mechanism described here is specific to collections;
  scalar leaves should be far safer and that is untested.

## Reproducing

```
node spikes/chunked-vs-single/run.mjs [maxChars] [transcript-substring...]
```

Needs `.env.local` at the repo root with `HELIX_DEV_TOKEN`. Note the gateway's own model names
(`GET /_api/openai/v1/models`) — they are not the public OpenAI/Anthropic names, and on this tenant
the `claude-*` models are allowlisted but their upstream rejects every request, including a bare
chat with no schema.
