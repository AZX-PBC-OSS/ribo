# Structured search-plan extraction pipeline — spike

**Question.** Does a three-stage _plan → locate → decide_ pipeline beat the committed **single-shot**
baseline (one call, "here is a 35-slot schema, fill it") on the Snugg Pro extraction corpus? The
hypothesis is that forcing the model to **locate evidence before deciding values** suppresses
hallucination and cross-context bleed. The counter-hypothesis, taken seriously, is that the baseline
already sits at ~0.5–1% hard hallucination, so there is almost no headroom, and a planner mostly
trades hallucinations for **misses** — dropping fields it failed to plan or locate.

This is a **spike**, not production. It imports the untouched snuggpro scorer and reads the untouched
corpus/ground-truth/schema/prompt; it modifies none of them.

> **The design and prompts below were written and committed BEFORE the full evaluation was run.** That
> is the anti-overfitting control: the pipeline shape is fixed before any score is seen. Any prompt
> change made after seeing scores is disclosed in the [Results](#results) section, with counts.

---

## Prior art (Step 1, timeboxed)

What actually informed the design:

- **Quote-first / evidence-first prompting** (Anthropic's own long-context guidance and the
  ["According to…"](https://arxiv.org/abs/2305.13252) line of work): asking a model to pull verbatim
  quotes _before_ answering grounds the answer in real text and makes fabrication visible, because a
  fabricated answer would need a fabricated quote. This is the core lever the pipeline formalises —
  the baseline already asks for a `sourceSpan`, but _after_ the value; here evidence comes first, as
  its own stage, and is **verified deterministically** before any value is decided.
- **LangExtract** (Google): source-grounded extraction with exact character offsets, and a
  **multi-pass** strategy that raises recall (2 passes ≈ 93%, 3 ≈ 96% in their needle tests) _without
  losing precision_. Encouraging for the "locate" idea, but note their gain is on **recall** (misses),
  which is precisely the axis our counter-hypothesis says a planner risks _hurting_ — so the corpus
  will tell us which way it cuts here.
- **ExtractBench** (arXiv 2602.12247): the dominant predictor of extraction failure is **output
  volume / schema breadth**, not input length — 369-field schemas collapse to invalid JSON. Our
  schema is only ~35 slots so we are far from that cliff, which tempers the "the field set is too big,
  split the call" motivation. Their failure taxonomy (omission vs hallucination) is the same pair the
  snuggpro scorer already separates.
- **Structured-output vs tool-calling / per-field calls**: the consistent finding is that _more calls
  = more latency, cost, and chances to pick the wrong path_; per-field function calling is not a free
  accuracy win and is usually reserved for when a single structured call cannot hold the schema. We
  are **not** going per-field: three coarse stages, one JSON object each, keeps the call count at 3
  (vs 1) rather than 35.
- **BAML / Instructor / DSPy framing**: separation of "the typed contract" from "the control flow" —
  we keep the same Zod schema as the typed contract for the final DECIDE stage and put the control
  flow (plan, locate, gate, decide) in a plain runner, rather than adopt a framework for a 14-item
  spike.

Net: the literature supports evidence-first grounding as a precision lever and multi-pass as a recall
lever, and warns that call-count and schema-splitting have real costs and are not obviously warranted
at ~35 slots. That is exactly the tension this spike measures.

---

## Design (fixed before running)

Three LLM nodes per transcript, plus one deterministic gate. All three CLI calls run with `cwd` set
to a temp dir **outside the repo** and stdin closed (`opencode run` is agentic — it must not roam the
repo); codex runs `--skip-git-repo-check --sandbox read-only`. Each node's raw output is parsed by
taking the **last balanced top-level JSON object**. Every node is resumable (skip if its output file
already exists).

### Node 1 — PLAN (LLM)

**In:** `prompts/plan.md` + `schema.ts` + transcript. **Out:** `{ "targets": [ { field, cue } ] }`.

Decides which of the 23 fields + 11 health tests the transcript **plausibly** addresses, and the
spoken cue to look for. **Biased toward inclusion** — a false include is discarded downstream (cheap),
a false exclude permanently drops the field (the miss-trade risk, pushed to the stage most able to be
generous). Fused mentions ("oil boiler") list both axes.

### Node 2 — LOCATE (LLM) + deterministic verbatim gate

**In:** `prompts/locate.md` + the PLAN targets + transcript. **Out:**
`{ "located": [ { field, spans: [...] } ] }`.

For each planned target, quote the **verbatim span(s)** that carry the answer — copy, never retype;
include the whole self-correction in one span so DECIDE sees the final value in context; omit a target
if no verbatim span exists.

**Why LLM, not deterministic keyword search, for LOCATE — argued before running.** A pure
keyword/cue grep is attractive (cheap, deterministic, cannot hallucinate a span) but it fails on the
exact cases this corpus is built to stress: the spoken form rarely equals the stored token
("clad" ⇒ `wood_or_metal_clad`, "power-vented" ⇒ `power_vented_at_unit`, "some but thin" ⇒ `poorly`),
and the evidence is a paraphrase with no fixed keyword to match. Locating that evidence needs the same
semantic reading that makes the task hard in the first place. So LOCATE is an **LLM**, but its output
is passed through a **deterministic verbatim gate**: any returned span that is not a
character-for-character substring of the transcript (`transcript.includes(span)`) is dropped before
DECIDE ever sees it. That is the design's grounding guarantee — the LLM supplies recall and paraphrase
matching; the gate supplies the hard grounding a keyword search would give, without its brittleness.
(A deterministic _keyword_ stage remains a reasonable alternative to A/B later; it is out of scope for
this spike, which tests the plan-then-locate _shape_, not the locate _mechanism_.)

### Node 3 — DECIDE (LLM)

**In:** `prompts/decide.md` + `schema.ts` + the **gated located spans only — NOT the transcript**.
**Out:** the full `SnuggFieldsSchema` JSON (the scored artifact).

Assigns each field a value from **only** the located spans (enum mapping, band bucketing, R-value
holding-pen, health-matrix states, fuel-axis split), else `null`. The normalization rules in
`decide.md` are **reused verbatim from the baseline `prompt.md`** so that the only variable this
experiment changes is _the input_ (located spans vs whole transcript, after a plan+locate step) — not
the decision logic. Withholding the transcript is deliberate and is the crux the counter-hypothesis
targets: if DECIDE loses a value because LOCATE didn't quote it, that is a real miss, and the corpus
will show it.

### Cost shape (by construction)

**3 LLM calls per transcript** vs the baseline's **1**. Wall-clock and per-node timing are recorded in
`results/<model>-timing.json` and reported below.

### Files

| Path                                                     | What                                                               |
| -------------------------------------------------------- | ------------------------------------------------------------------ |
| `prompts/{plan,locate,decide}.md`                        | The exact node prompts (this design, fixed pre-run)                |
| `run-pipeline.mjs`                                       | Orchestrator: 3 nodes + verbatim gate, resumable, leak-safe cwd    |
| `score-compare.mjs`                                      | Imports the untouched snuggpro scorer; diffs vs committed baseline |
| `results/<model>/NN-slug.json`                           | Final DECIDE output per transcript (committed)                     |
| `results/<model>/NN-slug/*`                              | Raw per-node dumps + `gated.json` (gitignored)                     |
| `results/{codex,opencode}-score.json`, `comparison.json` | Scored summaries (committed)                                       |

### Running

```bash
cd spikes/extraction-search-plan
node run-pipeline.mjs codex        # ~ (3 nodes × ~30s) × 14
node run-pipeline.mjs opencode     # ~ (3 nodes × ~70–100s) × 14
node score-compare.mjs             # scores both, prints the comparison tables
```

---

## Results

**Recommendation: DO NOT ADOPT.** The three-node search plan does not beat single-shot on either
model. It is a wash-to-worse at **3× the LLM cost**, and it introduces a new failure mode
(recall loss on ambiguous transcripts) that single-shot does not have.

**Anti-overfitting note:** the Design section above was fixed and written before any evaluation run,
and the run was scored **once**, after both models finished — there was **no** post-hoc prompt tuning
(zero iterations against the ground truth). Same 14 transcripts, same ground truth, same
mutation-proven scorer (`../extraction-snuggpro/score.mjs`), and the same two models as the committed
single-shot baseline (`../extraction-snuggpro/results/{codex,opencode}-score.json`). Cost: 3 LLM
calls per transcript (plan + locate + decide), ~43–61 s/transcript on codex and ~56–108 s on
opencode, vs single-shot's 1 call / ~30 s.

### codex (gpt-5.6) — pipeline 14/14 vs single-shot baseline

| metric                         | baseline   | search-plan | delta |
| ------------------------------ | ---------- | ----------- | ----- |
| hard hallucination             | 1 (0.5%)   | **2 (1%)**  | +1 ✗  |
| miss                           | 1 (0.8%)   | **0**       | −1 ✓  |
| health hallucinated-pass       | 0          | **1**       | +1 ✗  |
| both-non-null accuracy         | 118 (100%) | 119 (100%)  | +1 ✓  |
| enum member / band / span rate | 100%       | 100%        | 0     |
| miss-trade (fields dropped)    | —          | none        | ✓     |

Net wash, arguably worse: it fixed the one miss but added a hard hallucination **and** invented a
`passed` on a safety test that was not passed — the most dangerous error class in this product.

### opencode (glm-5.2) — pipeline 13/14 scored vs baseline

| metric                      | baseline   | search-plan           | delta |
| --------------------------- | ---------- | --------------------- | ----- |
| hard hallucination          | 2 (1%)     | 2 (1%)                | 0     |
| miss                        | 0 (0%)     | **4 (3.4%)**          | +4 ✗  |
| both-non-null accuracy      | 119 (100%) | 113 (100%)            | −6 ✗  |
| health hallucinated-pass    | 0          | **1**                 | +1 ✗  |
| enum member accuracy        | 75 (100%)  | 70 (100%)             | −5 ✗  |
| miss-trade (fields dropped) | —          | **5 (transcript 11)** | ✗     |

(One opencode transcript's DECIDE output failed the scorer's shape check → 13/14 scored; it does not
change the direction.) Clearly worse: +4 misses, dropped fields, a hallucinated safety pass.

### The failure mode — recall loss on ambiguity

Both models' damage concentrates on **`11-ambiguous-attic`** (the self-contradictory, last-value-wins
case). The PLAN stage must commit to which fields are "addressed" **before** the DECIDE stage sees any
values; on a contradictory transcript it mis-plans, and a field left off the agenda is **permanently
dropped** (opencode nulled equipment, fuel, insulation type, the spoken R-value, and a health test
that single-shot caught). Single-shot, seeing the whole transcript at once, resolves the contradiction
correctly. This is the structural cost of decomposition: it converts one model's judgment into a
plan-then-fill pipeline whose first stage can silently exclude a field.

### What this tells us

The residual extraction errors are **not** in the strategy — single-shot with a good prompt is at the
floor (0.5–1% hallucination, 100% verbatim spans). Task 4 already located the real damage in
**transcription** (mangled brand names) and **cross-context bleed** (a value from the wrong house /
system). Neither is helped by planning; both point the next effort at **segmentation** (chunk the
dictation by room/system before extracting) and the **deterministic manufacturer-snapper** — not at a
multi-call pipeline. Money better spent there than on 3× inference for a negative result.
