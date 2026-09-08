# 21 — Three-phase extraction on the managed path: measured, and the cap nobody was looking for

**Date:** 2026-09-08
**Status:** Result, recorded. Corpus runs against the **real Helix managed LLM route**
(`POST /_api/llm/chat`) through `helixChat`, over the same 14-transcript corpus as docs 18 and
19, scored with `spikes/extraction-snuggpro/score.mjs` **reused verbatim** (13 graded; `score.mjs`
excludes `02-oil-boiler-basement` as contaminated). Harness: `spikes/managed-three-phase/`.
**Nothing under `packages/` was modified.**

## The one thing to take away

**Three-phase does not run against today's managed path, and the premise for adopting it — that
per-group is bounded by a 32,768-byte schema cap — is not the constraint that actually binds.**

Three separate incompatibilities stop `threePhaseExtractor` from producing a single non-null
field against `helixChat` (§1). Working around all three in the harness, it runs — and on a
frontier managed model it is **worse than per-group on every quality axis except span fidelity**:
25.3% miss against 10.4%, and **2 hallucinated health passes against 0**. It costs 3.2× the calls
and 6× the wall clock, though — genuinely, and against expectation — about **a third the token
spend** (§3).

The finding worth keeping is the one nobody was looking for: on this route, **Anthropic-family
models reject any response schema containing more than 16 nullable unions.** This repo's
provenance envelope emits two per leaf, so the real ceiling is **8 enveloped leaves per call** —
and `perGroupExtractor`'s `hvac` (12 leaves) and `health` (14 leaves) groups are **already over
it**. On the committed 51-leaf schema, unchanged, per-group scores **0/14 against
`claude-sonnet-5`** and **14/14 against `gpt-4.1`**.

Nothing is on fire in production: the playground still wires `openAiChat` with
`gpt-4o-2024-08-06`, and `helixChat` has no construction site outside a spike. But the managed
path moving onto the Helix LLM route is the plan of record (doc 13, ask A2), and the day it does
with a `claude-*` model, extraction stops working — with an error message about the "strict JSON
Schema subset" that names neither the cap nor the field count. The byte cap doc 16 is built
around is real but distant; this one is invisible in every existing measurement, because every
existing measurement used an OpenAI model or a CLI.

**Recommendation: NO-GO on adopting three-phase as the standard managed strategy.** §6.

---

## 1. "Just construct it with the managed `CapableChatClient`" — three ways that fails

The premise was that `threePhaseExtractor` is transport-agnostic: it is typed against
`CapableChatClient`, which `helixChat` implements identically to `OnDeviceChat`
(`chat-client.ts:216-222` — "Both the managed and on-device transports implement this"). The
type-checks. Nothing else does.

Each of the three below was found by running it, not by reading it, and each one **fails
silently**: `threePhaseExtractor` catches every call failure and writes a null leaf
(`three-phase-extractor.ts:92-99`, `:120-125`, `:376-388`), so a wholly broken run reports
`14/14 completed` with an empty grid.

### 1.1 The schema walk cannot see five of the seven groups

`extractGroups` reads `schema.properties[group].properties[leaf].properties.value`
(`three-phase-extractor.ts:162-188`). That walk assumes every top-level group is an **object** of
enveloped leaves. Since the R1.6 instance ladder, five of the adapter's seven groups — `hvac`,
`attic`, `wall`, `window`, `dhw` — are **arrays** of instances, which have no `properties`. The
walk drops them without a word, and the extractor then throws on its own closing
`target.extractionSchema.parse()` with five `invalid_type` errors:

```
calls attempted: ["basedata-presence" ×4, "health-presence" ×4]
error: [{ "expected": "array", "path": ["hvac"], ... }, … ×5]
```

30 of the 51 leaves are never asked about. Doc 19's measurements predate the instance ladder,
when all seven groups were flat objects; three-phase was never updated and nothing caught it,
because it is only wired to the on-device path and no corpus run has crossed it since.

**Consequence for the comparison.** To run at all, three-phase needs an instance model it does
not have. The harness projects each collection group down to a single instance (`z.array(X)` →
`X`) and wraps the result back into a one-element array. That is exactly `perGroupSingletonExtractor`'s
semantics — Tier 3 of the instance ladder, which "cannot represent a second instance"
(`instance-ladder.ts:12`) — which is why Tier 3 is measured alongside as three-phase's matched
baseline in §3. **Three-phase is a Tier-3-class strategy.** Making it Tier 2 means designing an
instance-discovery phase that does not exist.

### 1.2 It has no `model` option, and sends the transport's name as the model id

```ts
// three-phase-extractor.ts:70-71
// The on-device chat transport ignores the model id, but ChatRequest requires one.
const model = chat.engine;
```

`ThreePhaseExtractorOptions` has no `model` field. Against `helixChat`, `engine` is the literal
string `"helix"`, so every call is:

```
403 model_not_allowed: model "helix" is not allowed
```

True for the Prompt API; false for any managed transport, where the model id is a routing key.
`perGroupExtractor` and `singleShotExtractor` both take `model` explicitly.

### 1.3 Phase 2 sends a bare root schema, and its own fallback can never fire

`classifyLeaf` sets `response_format.json_schema.schema` to the leaf's **bare value schema** —
`{"type":"number"}`, or `{"anyOf":[{…enum},{"type":"null"}]}`. Measured against the route
(`root-probe.mjs`):

| root schema                                     | result                          |
| ----------------------------------------------- | ------------------------------- |
| `{"anyOf":[{"type":"number"},{"type":"null"}]}` | `400 validation_failed`         |
| `{"type":"number"}`                             | `400 validation_failed`         |
| the same, wrapped in `{value: …}` object root   | `200`, `content: {"value": 30}` |

Doc 16 §1 already records the rule from OpenAI's side — "Root objects must not be `anyOf` and
must be an object" — and the Helix skill states it too. The Prompt API accepts a bare root; no
managed route does.

`threePhaseExtractor` **has** the right fallback — `classifyWrapped` wraps the value schema in
exactly that object root. It is unreachable: it fires only on
`ChatError.kind === "unsupported"` (`isUnsupportedError`, `:501-503`), and a managed transport
reports a rejected schema as `http` with status 400. So phase 2 retries the bare form four
times, gives up, and returns `null` — **for every leaf**. Left alone, three-phase against the
managed path yields a 100% miss rate that says nothing about the strategy.

The harness wraps non-object roots at the transport and unwraps the reply, doing at the seam
what `classifyWrapped` would have done at the extractor, for zero extra calls.

**None of this is a "mainly construct it with the managed client" change.** Two of the three are
defects in `three-phase-extractor.ts` that a unit test with a fake chat cannot catch, because a
fake chat has neither a model allowlist nor a strict-subset validator.

---

## 2. The cap that actually binds: 16 nullable unions, and only on Anthropic models

With the three gaps worked around, three-phase runs. `perGroupExtractor` then did not — on
`claude-sonnet-5` it produced **0 of 14 transcripts**, every one failing with
`400 validation_failed … check responseFormat.schema against the strict JSON Schema subset`.

Submitting each group's schema on its own (`group-probe.mjs`) isolates it: **five of the seven
groups are accepted — `basedata`, `attic`, `wall`, `window`, `dhw` — and `hvac` and `health` are
rejected.** In the corpus run that is enough to lose everything, because `perGroupExtractor`
aborts its sibling calls on the first failure. Stripping descriptions did not help either group.

That is not the documented byte cap. `health` serialises to 13,330 chars and `hvac` to 9,251,
both far under 32,768, and both fail with descriptions stripped (5,070 and 5,241 chars).

Bisecting each group leaf by leaf, both flip at **exactly 9 leaves**, at very different
character counts — `hvac` at 6,970 chars, `health` at 8,894. Holding the leaf count at the flip
point and removing one factor at a time (`factor-probe.mjs`, `claude-sonnet-5`):

| variant                                              | props |  chars | result       |
| ---------------------------------------------------- | ----: | -----: | ------------ |
| health, 8 leaves, as shipped                         |    33 |  7,938 | **OK**       |
| health, 9 leaves, as shipped                         |    37 |  8,894 | **REJECTED** |
| health, 9 leaves, descriptions stripped              |    37 |  3,395 | **REJECTED** |
| health, 9 leaves, enums replaced by plain strings    |    37 |  2,945 | **REJECTED** |
| health, 14 leaves, `value` only (no confidence/span) |    29 | 11,706 | **OK**       |
| health, 14 leaves, no envelope at all                |    15 | 10,432 | **OK**       |
| health, 14 leaves, `value` only + plain strings      |    29 |  2,756 | **OK**       |

Bytes are irrelevant (11,706 accepted, 2,945 rejected). Descriptions and enum values are
irrelevant. Raw property count is not it either — a flat object of **72** plain string properties
is accepted. The one quantity that separates every accepted row from every rejected one is the
number of **nullable unions**: 16 accepted, 18 rejected.

Bisected directly (`anyof-probe.mjs`):

| model             | `anyOf:[T,null]` properties | `type:["T","null"]` properties | full enveloped leaves |
| ----------------- | --------------------------: | -----------------------------: | --------------------: |
| `claude-sonnet-5` |                      **16** |                         **16** |                 **8** |
| `claude-opus-5`   |                      **16** |                         **16** |                 **8** |
| `gpt-4.1`         |                       ≥ 120 |                          ≥ 120 |                 ≥ 120 |
| `gpt-4o`          |                       ≥ 120 |                          ≥ 120 |                 ≥ 120 |

Both spellings of "nullable" hit the same wall, so it is nullability itself, not the `anyOf`
keyword. `provenance.ts`'s rule — every key required **and nullable**, so the model must emit an
explicit `null` rather than omit a key — spends two of the sixteen on every leaf (`value` and
`sourceSpan`). **Eight enveloped leaves per call, on Anthropic models.**

Three consequences, in order of how much they matter:

1. **`perGroupExtractor` is already over the cap for Anthropic models.** `hvac` (12) and `health`
   (14) exceed it today, at the committed 51-leaf schema, with no schema growth at all. Nothing
   caught it because every measurement in docs 16, 18 and 19 used an OpenAI model or a CLI, the
   playground still defaults to `openAiChat` + `gpt-4o-2024-08-06`, and `helixChat` had no
   construction site outside a spike before this one.
2. **`per-group-cap.test.ts` guards the wrong number.** It asserts each group serialises under
   `SCHEMA_SERIALIZED_CHAR_CAP` (32,768) and nests within `SCHEMA_NESTING_DEPTH_CAP` (12). Both
   hold. Neither is what the route rejects.
3. **Three-phase is not immune either** — see §5.

**Scope, stated honestly.** This was measured against one deployment's `/_api/llm/chat` with one
dev token. Whether the 16 is the vendor's own limit or this route's translation of it is not
established here; what is established is that it is **model-family-specific on the same route**,
which rules out a route-wide request validator and points at the upstream provider.

---

## 3. The corpus comparison

Because `perGroupExtractor` cannot run on an Anthropic model (§2), the apples-to-apples quality
comparison has to happen on **`gpt-4.1`**, where both strategies run cleanly. That is also the
family every prior baseline in this repo used.

All three ran the full 14 transcripts with **zero failed calls**; `score.mjs` graded 13.
`per-group` is Tier 2 — the strategy `playground/src/extractor-store.ts` wires today, with
`snuggGroupInstructions`. `per-group-singleton` is Tier 3, the matched baseline for three-phase's
single-instance modelling (§1.1).

| metric (gpt-4.1, 13 graded)  |  **three-phase** | per-group (Tier 2) | per-group-singleton (Tier 3) |
| ---------------------------- | ---------------: | -----------------: | ---------------------------: |
| transcripts completed        |        **14/14** |              14/14 |                        14/14 |
| hard hallucination           |  **4.4%** 11/249 |        4.4% 11/249 |                   3.6% 9/249 |
| miss rate (all 51 leaves)    | **25.3%** 44/174 |       10.4% 18/173 |                 22.1% 38/172 |
| accuracy, both non-null      |        **96.4%** |          **99.1%** |                     **100%** |
| enum member accuracy         |        **96.3%** |               100% |                         100% |
| band mapping                 |              5/5 |                5/5 |                          5/5 |
| source-span verbatim         | **100%** 144/144 |      95.2% 158/166 |                95.1% 137/144 |
| — of which fabricated        |            **0** |              **0** |                        **0** |
| hallucinated health passes   |            **2** |              **0** |                        **0** |
| hallucinated health problems |            **1** |              **0** |                        **0** |
| chat calls                   |          **318** |                 98 |                           98 |
| input / output tokens        |   **136k / 11k** |         424k / 19k |                   420k / 18k |
| seconds per transcript       |           **23** |              **4** |                        **4** |
| wall clock, whole corpus     |      **5.5 min** |            1.0 min |                      1.0 min |
| estimated cost, whole corpus |        **$0.36** |          **$1.00** |                    **$0.98** |

Cost is estimated from the manifests' real token counts at first-party list rates
(gpt-4.1 $2/$8 per Mtok); the route meters its own price, so treat it as a ratio, not an invoice.

**Three-phase loses on every quality axis except one, and the one it wins is worth less than
doc 19 makes it look.** Miss rate is 2.4× per-group's and still worse than the matched Tier-3
baseline (25.3% vs 22.1%), so the gap is not an artifact of the singleton projection. Enum
accuracy and both-non-null accuracy both slip below 100%, which neither per-group variant does.
Most damagingly it produces **2 hallucinated health passes and 1 hallucinated problem** —
hazard 2, the failure with real-world consequences — where both per-group variants score zero,
and where doc 18 recorded both CLI backends scoring zero too. 33 of its 44 misses are in the
health group.

Its one clean win is span fidelity: **100% against 95.2%**. But `spanFabricated` is **0 in all
three runs**. Per-group's 8 non-verbatim spans are all `near-miss` — differing only in
case, whitespace or quoting. So grounding is buying the difference between "the quote is
slightly reformatted" and "the quote is an exact substring", not doc 19's "a reviewer who finds
one fabricated citation has no reason to trust the others". On Gemini Nano, where fabrication was
real, that argument held. On a frontier managed model there is nothing to fabricate-proof, and
grounding's documented cost — dropping near-miss paraphrases along with fabrications — is
visible here as part of the miss gap.

**The cost result is the genuine surprise, and it runs the other way.** Three-phase is **~2.8×
cheaper** ($0.36 vs $1.00) despite making 3.2× the calls, because its calls are tiny: 429 input
tokens each against per-group's 4,325. Per-group re-sends the whole group schema, the vendor
descriptions and a projected few-shot example on every one of its seven calls. Note
`cacheReadInputTokens` came back **0 on every call in every run** — the route's prompt-prefix
cache never engaged, which is exactly the question `helix-chat.ts` flagged as unobservable from
the field. Per-group's cost is a cold-cache figure and would fall substantially if that prefix
were cached; three-phase has little prefix to cache and would gain much less.

So the honest cost sentence is: **three-phase trades 6× the wall clock and 3.2× the call count
for roughly a third of the token spend** — and pays for it in quality. Latency is the axis that
matters for a field app draining a queue on a phone, and 23 s versus 4 s per transcript is the
difference between an extraction that feels immediate and one that does not.

### 3a. The Anthropic-model run, where three-phase is the only thing that works

Three-phase was also run end-to-end on `claude-sonnet-5` — the case per-group cannot reach at all
(§2). It completed **14/14 with zero failed calls**, which is the strongest thing that can be said
for it: on this half of the model roster it is the only one of the two strategies that produces
anything.

| metric                       | three-phase / `claude-sonnet-5` | three-phase / `gpt-4.1` | per-group / `claude-sonnet-5` |
| ---------------------------- | ------------------------------: | ----------------------: | ----------------------------: |
| transcripts completed        |                       **14/14** |                   14/14 |                      **0/14** |
| hard hallucination           |                  **2.0%** 5/249 |             4.4% 11/249 |                           n/a |
| miss rate (all 51 leaves)    |                **37.2%** 64/172 |            25.3% 44/174 |                           n/a |
| accuracy, both non-null      |                           95.6% |                   96.4% |                           n/a |
| enum member accuracy         |                           95.5% |                   96.3% |                           n/a |
| source-span verbatim         |                            100% |                    100% |                           n/a |
| hallucinated health passes   |                           **1** |                       2 |                           n/a |
| chat calls                   |                             302 |                     318 |              98 (84 rejected) |
| seconds per transcript       |                          **69** |                      23 |                           n/a |
| wall clock, whole corpus     |                    **16.0 min** |                 5.5 min |                           n/a |
| estimated cost, whole corpus |                       **$1.02** |                   $0.36 |                           n/a |

The presence gate is more conservative on Sonnet: hallucination falls to the best figure in this
document (2.0%) and the miss rate rises to the worst (37.2%). That is the same trade doc 19
recorded on Nano, reproduced on a frontier model — three-phase buys precision with recall, and
here it overpays. It is also **3× slower than on gpt-4.1** (69 s versus 23 s per transcript), and
`claude-sonnet-5`'s adaptive thinking is why: 46k output tokens against gpt-4.1's 11k for the same
work, which erases the token-cost advantage entirely ($1.02, on par with per-group's $1.00).

So the honest reading of 3a is not "three-phase wins on Anthropic models". It is **"per-group is
disqualified there on a schema-shape rule, and three-phase's own numbers are not good enough to
call that a win."** Fixing the cap for per-group (§6) beats accepting a 37% miss rate.

---

## 4. Does per-group's byte cap break at `basedata` scale? Yes — but it is the second wall

Sanity-checked with a synthesized placeholder slice shaped like the 163-field "honest capture"
`basedata` target from doc 17 — the same enum/number/string/boolean mix and the measured
298-char average vendor description, enveloped through the real `enveloped()` helper
(`spikes/managed-three-phase/cap-probe.mjs`; run independently and reproduced).

Today's real groups, confirmed against the doc-16 figures:

| scope                      | with descriptions | stripped |
| -------------------------- | ----------------: | -------: |
| whole schema (single-shot) |            39,884 |   19,444 |
| largest group (`health`)   |            13,330 |    5,070 |

The synthesized 163-leaf `basedata` group as **one per-group call**:

| leaves | with descriptions | stripped | over 32,768 with desc? | stripped?      |
| -----: | ----------------: | -------: | ---------------------- | -------------- |
|     50 |            32,373 |   16,623 | no                     | no             |
|     60 |            38,804 |   19,904 | **YES**                | no             |
|     90 |            58,115 |   29,765 | **YES**                | no             |
|    100 |            64,530 |   33,030 | **YES**                | **YES**        |
|    163 |           105,246 |   53,901 | **YES** (321% of cap)  | **YES** (164%) |

So the byte cap **does** break, between 50 and 60 leaves with vendor descriptions and between 90
and 100 without — comfortably before 163. Nesting depth stays at 3 against a cap of 12 and is
never the threat. The doc-16 reasoning is sound.

**But on an Anthropic model it is the second wall, not the first.** The nullable-union cap bites
at **8 leaves**, roughly seven times sooner than the byte cap at 60. Any plan that treats 32,768
bytes as the constraint to design around is optimising against the wrong number for that half of
the model roster.

---

## 5. What three-phase would actually buy at scale — and what it would not

The structural argument for three-phase is that its per-call schema never grows with total
schema size. That is **half true**, and the half that is false is the half that matters on
Anthropic models. Bisected per phase (`phase-cap-probe.mjs`):

| phase | schema shape                            | grows with        | `claude-sonnet-5` ceiling | `gpt-4.1` |
| ----- | --------------------------------------- | ----------------- | ------------------------: | --------: |
| 0     | one **boolean** per leaf in the group   | group size        |             **72** leaves |     ≥ 300 |
| 1     | one **nullable string** per active leaf | presence-true set |             **16** leaves |     ≥ 300 |
| 2     | one leaf, wrapped object root           | nothing           |                         1 |         1 |

Phase 2 is genuinely size-independent. Phases 0 and 1 are not.

Today that is survivable: the largest group is `health` at 14 leaves, so phase 0 uses 14 of 72
and phase 1 at most 14 of 16 — **two leaves of headroom on the worst case**, which is exactly why
three-phase completes 14/14 on `claude-sonnet-5` (§3a) where per-group completes 0/14. Two
leaves. Adding a fifteenth field to `health` would take three-phase down too, and adding a
seventeenth would do it with certainty. At the 163-field `basedata`
target, phase 0 (163 booleans) is over the 72 ceiling and phase 1 is over the 16 ceiling the
moment 17 fields are discussed at once — which a full walkthrough transcript comfortably does.

So three-phase raises the per-call ceiling from 8 enveloped leaves to 16 active ones. It does
not remove it. **Scaling to `basedata` needs sub-group partitioning under either strategy**, and
that partitioning is the actual work — not the choice between these two.

---

## 6. Recommendation: no-go

**Do not adopt `threePhaseExtractor` as the standard managed extraction strategy.**

1. **It does not run against the current adapter**, and the fix is not wiring. It needs an
   instance model (§1.1) — without one it is permanently Tier 3 and cannot represent a second
   HVAC system, which the corpus contains and the review UI already enumerates.
2. **Its measured quality on a frontier managed model is worse than the incumbent's on every
   axis but one** (§3) — including 2 hallucinated health passes against per-group's 0 — at 3.2×
   the calls and 6× the wall clock. It is genuinely ~2.8× cheaper in tokens, which is a real
   result and the only one that favours it; that is not enough to buy a hazard-2 regression.
   Doc 19's win was against Gemini Nano's specific failure modes — degenerate loops and weak
   grounding — and doc 16 §5 already recorded decomposition as "a wash-to-worse at 3× the LLM
   cost" for frontier models. This is the third time that result has reproduced.
3. **It does not solve the scaling problem it was proposed for** (§5). It moves the ceiling from
   8 leaves to 16, and `basedata` needs 163. Its current 14/14 on `claude-sonnet-5` rests on two
   leaves of headroom in the `health` group — a fifteenth health field breaks it.

The one thing that does favour it: on an Anthropic model it is currently the only strategy that
runs at all (§3a). That is an argument for **fixing the cap**, not for adopting a strategy whose
own miss rate there is 37.2%.

**What to do instead, in priority order:**

- **Guard the real cap.** Extend `per-group-cap.test.ts` to assert a nullable-union count per
  group schema, alongside the char and depth caps it already checks. Today's `hvac` and `health`
  would fail that assertion, which is the point — it is a live production break against half the
  model roster, currently invisible.
- **Decide the model-family question explicitly.** Either pin the managed path to OpenAI-family
  models and record why, or partition `hvac` and `health` into sub-groups of ≤8 enveloped leaves.
  The second is the same partitioning `basedata` will need anyway, so doing it now buys the
  scaling work rather than merely unblocking today.
- **Take the two cheap wins from three-phase without the strategy.** Span grounding — dropping
  any value whose `sourceSpan` is not a verbatim substring — is what took doc 19's span fidelity
  to 100%. `review.ts:537` already computes `isGrounded` per field for display, but **no
  extractor drops on it**; wiring that drop into `perGroupExtractor` is a small change
  independent of which strategy wins. Likewise a boolean presence gate is a technique in its own
  right and does not require phases 1 and 2 to come with it.
- **Fix the three defects in `three-phase-extractor.ts` regardless** (§1) — it is the on-device
  path's only extractor, and 1.1 means it is broken there too, today, for five of seven groups.

---

## 7. What this does and does not settle

**Settled.** Three-phase cannot run against the current managed transport or the current
adapter schema without three changes, two of them defects. On this route, Anthropic-family
models cap a response schema at 16 nullable unions — 8 enveloped leaves — while OpenAI-family
models on the same route do not; `perGroupExtractor` is over that cap today for two of seven
groups. With the three changes made, three-phase completes the corpus on both families
(14/14 on each) and loses to per-group on quality on the family where both run. The 32,768-byte
cap does break at `basedata` scale, between 50 and 60 leaves with descriptions.

**Not settled.** Whether the 16 is the vendor's limit or this route's; one deployment, one token.
Whether three-phase's quality gap would close with adapter-specific prompts — it gets none
today, while per-group gets `snuggGroupInstructions`, and that is a real confound in §3, though
not one that plausibly reverses a result this size. Whether an instance-aware three-phase (a
phase −1 inventory pass, as `instance-fill.ts` already does for Tier 1) would score differently;
not built, not measured.

**Not measured at all.** `claude-opus-5` on the corpus (probed for caps only). Whether Sonnet's
adaptive thinking — 46k output tokens against gpt-4.1's 11k for the same work (§3a) — can be
turned down through this route, and what that would do to its 37.2% miss rate.
`singleShotExtractor`, which is not the incumbent and cannot fit anyway — its 51-leaf schema is
102 nullable unions against a cap of 16, and 39,884 bytes against a cap of 32,768, so it fails
both limits on an Anthropic model and one on an OpenAI one. Any sub-group partitioning of
`hvac`/`health`. Whether the route's prompt-prefix cache changes the cost picture
— `cacheReadInputTokens` came back `0` on every call in every run here, so nothing was cached and
the cost figures are cold-cache figures for both strategies alike.

---

## 8. Decision (2026-09-08)

Following this spike, and the parallel job-collections curation pass (doc 20), the decision is:

- **Pin the managed extraction path to OpenAI-family models.** This matches what is already
  deployed (`openAiChat` / `gpt-4o-2024-08-06`) — no migration required, just recording it as a
  deliberate choice rather than an accident of what happened to be wired up. An Anthropic-compatible
  managed path is a real possibility later, not adopted now.
- **Proactively partition `hvac` and `health` into ≤8-enveloped-leaf sub-groups**, ahead of any
  actual need on the OpenAI-pinned path, specifically so that a future Anthropic-compatible path
  does not require schema surgery to unblock it — the same partitioning `basedata`'s 163-field
  target will need anyway (§6).
- **Add the nullable-union cap as a guarded regression test**, per model family, so this ceiling
  stays visible regardless of which model the managed path is pinned to next.
- **Fix `three-phase-extractor.ts`'s defect 1.1 regardless** (§1) — it breaks the on-device path
  today, independent of the managed decision above.

Three-phase itself remains NO-GO for managed, per §6.

---

## Sources

- `spikes/managed-three-phase/` — the whole harness, committed. `run.mjs` (corpus runner over
  `helixChat`), `compare.mjs` (the §3 table), and the probes each finding rests on:
  `root-probe.mjs` (§1.3), `group-probe.mjs` / `subset-probe.mjs` / `factor-probe.mjs` /
  `anyof-probe.mjs` (§2), `cap-probe.mjs` (§4), `phase-cap-probe.mjs` (§5). Results land in
  `spikes/extraction-snuggpro/results/managed-*`, which is gitignored.

  Reproduce with `pnpm build:packages`, then
  `node spikes/managed-three-phase/run.mjs --strategy <three-phase|per-group|per-group-singleton> --model <id>`,
  then `node spikes/extraction-snuggpro/score.mjs <results-dir>`. Needs `HELIX_DEV_TOKEN`,
  `HELIX_BASE_URL` and `HELIX_ORIGIN` in the repo-root `.env.local`, against an app whose
  manifest grants `capabilities.llm`. **Run the strategies one at a time** — two concurrent
  corpus runs exhaust the route's burst spend budget, and a `429` reaches `threePhaseExtractor`
  as a null leaf, not an error.

  **Reproductions will not match the §3 quality figures exactly.** The models are
  non-deterministic and the corpus is 13 transcripts, so single-digit counts move between runs.
  What should reproduce are the structural results: §1's three failures, §2's 16/8 caps, and
  per-group's 0/14 against `claude-sonnet-5`.

- `spikes/extraction-snuggpro/score.mjs` — the scorer, reused verbatim, as docs 16, 18 and 19 all
  require.
- [Doc 16](16-extraction-schema-scale.md) §1 (the strict-subset rules, including the
  root-must-be-an-object rule §1.3 measures) and §5 (the frontier baseline, and the earlier
  finding that decomposition is a wash-to-worse for frontier models). **Note on that baseline:**
  §5's 0.5%/0.8% codex figures are from the **34-leaf** pilot via a CLI, not from the current
  51-leaf instance schema through a managed API — they are not directly comparable to §3 and are
  not used as the bar here.
- [Doc 17](17-snuggpro-field-reconciliation.md) — the 163-field `basedata` target §4 synthesizes
  against.
- [Doc 19](19-ondevice-extraction-strategies.md) — the on-device measurement that selected
  three-phase, and the source of the quality claims this document tests on a different model.
- `packages/ribo-extractor-ondevice/src/three-phase-extractor.ts`,
  `packages/ribo-extractor-openai/src/per-group.ts`,
  `packages/ribo-extractor-openai/src/helix-chat.ts`,
  `packages/ribo-adapter-snuggpro/src/per-group-cap.test.ts`.
