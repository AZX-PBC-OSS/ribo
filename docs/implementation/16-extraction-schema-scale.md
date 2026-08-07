# 16 — Extraction schema scale: why "just pass the whole spec" doesn't fit

**Status:** Research findings, no code changed. Read-only static analysis: OpenAI's published
structured-output limits against our own property/enum counts. **Contains no Snugg Pro vendor
material** — no endpoint names, no wire tokens, no enum member lists. For the field-by-field
mapping against the real spec, see
[17 — Snugg Pro field reconciliation](17-snuggpro-field-reconciliation.md).

## The one thing to take away

**Taking the whole Snugg Pro spec as one extraction schema is closed on hard limits, not on
quality.** The combined job-data schema (`allJobData`, the union of every field the API can return
for a job) is **~1,326 leaves**, which after this repo's provenance-enveloping (every leaf becomes
a `{value, confidence, sourceSpan}` triple) is **~5,360 properties** against OpenAI's documented
**5,000-property cap**, and **~1,490 enum values** against the documented **1,000-value cap**. Both
limits are blown independently — this is not "it would extract badly," it is "the API rejects the
request before extraction is even attempted." The `basedata` subset (the pure capture/write
endpoint, closest to what an auditor actually dictates) does fit — **~1,201 enveloped properties**,
comfortably under both caps — but it is **~9× the current 34-leaf pilot's property count**, sitting
in the neighborhood where external benchmarks report schemas collapsing to invalid JSON. Recorded
here so this option is not re-proposed without re-deriving these numbers.

---

## 1. OpenAI's documented structured-output limits (as of 2026-08-06)

Fetched and quoted directly from `https://developers.openai.com/api/docs/guides/structured-outputs`
(the canonical URL as of this writing; the older `platform.openai.com/docs/guides/structured-outputs`
301-redirects here):

- **"A schema may have up to 5000 object properties total, with up to 10 levels of nesting."**
- **"In a schema, total string length of all property names, definition names, enum values, and
  const values cannot exceed 120,000 characters."**
- **"A schema may have up to 1000 enum values across all enum properties. For a single enum
  property with string values, the total string length of all enum values cannot exceed 15,000
  characters when there are more than 250 enum values [in that single property]."**
- **"Root objects must not be `anyOf` and must be an object."**
- Composition keywords are unsupported everywhere: `allOf`, `not`, `dependentRequired`,
  `dependentSchemas`, `if`, `then`, `else`.
- All fields must be `required`; `additionalProperties: false` is required to opt in.

Older/community sources (forum threads, third-party guides) report a smaller, older limit set —
100 properties, 5 levels of nesting, 15,000-char total string length, 500 enum values. These read
as a prior generation of the same limits, since raised; the figures above are what's live today and
are what this document uses.

**Binding ceiling for "the whole spec":** total properties (5,000) and total enum values (1,000).
Nesting depth (10) and total string length (120,000 chars) don't bind first at this spec's scale
(§2).

### A discrepancy worth an engineer's re-check, not treated as settled here

The same OpenAI page's "Supported properties" section — for a normal, **non-fine-tuned** model —
lists `pattern`, `format` (`date-time`, `time`, `date`, `duration`, `email`, `hostname`, `ipv4`,
`ipv6`, `uuid`), `multipleOf`, `maximum`, `exclusiveMaximum`, `minimum`, `exclusiveMinimum`,
`minItems`, `maxItems` as things you **can** use. The "additionally not supported" carve-out is
scoped specifically to **fine-tuned models**.

That is a live conflict with this repo's own code. `packages/ribo-core/src/provenance.ts` states as
fact (its rule 2 comment): "OpenAI strict mode rejects the `minimum`/`maximum`/`pattern` that
`.min()`/`.max()`/`.regex()` emit" — and that belief is why `confidence` is a bare `z.number()`
rather than `z.number().min(0).max(1)`. `enveloped.ts`'s `isSupportedLeaf` allowlists
`ZodEnum | ZodLiteral | ZodString | ZodNumber | ZodBoolean` by **kind**, not by
constraint-free-ness — a documented, known gap (`z.number().min(0)` is still `instanceof
z.ZodNumber` and passes silently, still emitting the forbidden keyword). The actual downstream
gate is `ribo-adapter-snuggpro/src/extraction-shape.test.ts`'s `assertStrictModeCompatible`,
confirmed by direct read to be a static, local, no-network recursive check — it asserts
`minimum`/`maximum`/`pattern` are absent, every object is closed, and every key is required. It
runs against a frozen fixture and a faked, non-network `ChatClient`. **It never calls the OpenAI
API** — it encodes the team's belief about the constraint, not a live-verified rejection.

Either the documented limit was relaxed after `provenance.ts` was written, or that comment
describes empirically observed behavior on a specific model/SDK path the current docs no longer
state as a blanket rule. **This needs a five-minute engineer re-check against the real API, not a
doc-only resolution** — if the constraint is stale, our schema (and every schema this repo
generates going forward) is more restricted than it needs to be, for no reason. Not re-verified
here: no LLM calls were made for this pass.

---

## 2. Scale: how big is "the whole spec," concretely

Walked the live spec programmatically (`https://app.snuggpro.com/apidocs/swagger.json`, Swagger
2.0, 91 paths / 117 operations / 61 named definitions), dereferencing `$ref` and breaking cycles,
rather than relying on a summarized read.

| schema scope                                                                  |                           raw scalar leaves | raw total properties | max nesting depth (pre-envelope) | distinct enum properties | total enum values |
| ----------------------------------------------------------------------------- | ------------------------------------------: | -------------------: | -------------------------------: | -----------------------: | ----------------: |
| `allJobData` (the combined "whole job" schema)                                |                                   **1,326** |                1,382 |                                7 |                      305 |         **1,490** |
| `basedata` (the capture/write endpoint, closest to "auditor-fillable fields") |                                         300 |                  301 |                                3 |                       99 |               440 |
| current committed pilot (`SnuggFieldsSchema` / `snuggValuesSchema`)           | 34 (23 scalar/enum + 11-test health matrix) |                  ~35 |                                2 |                        — |                 — |

Applying the envelope transform exactly as `enveloped()`/`extractedSchema()` define it — every
container property stays 1 property, every leaf becomes 4 (its own key + `value` + `confidence` +
`sourceSpan`), and every envelope adds one nesting level:

| schema scope                     | enveloped total properties | enveloped max depth | vs. 5,000-property limit                                | vs. 1,000-enum limit                                                |
| -------------------------------- | -------------------------: | ------------------: | ------------------------------------------------------- | ------------------------------------------------------------------- |
| `allJobData` ("the whole spec")  |                  **5,360** |                   8 | **OVER by 360 — literally rejected**, not just degraded | **OVER by 490** (1,490 vs. 1,000) — a second, independent rejection |
| `basedata` (capture-only subset) |                  **1,201** |                   4 | under (24% of budget)                                   | under (44% of budget)                                               |
| current 34-leaf pilot            |                   ~102–140 |                   3 | under (~2–3% of budget)                                 | small, well under budget                                            |

**This is the concrete answer to "is it even possible."** Taking "the entire schema" literally —
`allJobData`, the union of everything the API can return for a job — produces an enveloped
extraction schema the OpenAI API will **flatly reject at request time**, on two independent
documented limits simultaneously, before any question of extraction quality even arises. That is
not a "degrades badly" finding; it is a "does not parse" finding.

A scoped-down subset — `basedata` alone — fits comfortably under both limits with real headroom.
So "derive from the full OpenAPI spec" is infeasible as literally stated; "derive from one
well-chosen sub-schema of the spec" is structurally feasible (passes the API's static acceptance
checks) at up to roughly **8–9× the current pilot's leaf count**. Nothing here says it would
extract well at that size — see §4, and the baseline in §5 that any such attempt would need to
beat.

---

## 3. What a Swagger-derived schema would need transformed away

A Swagger 2.0-derived schema, unmodified, contains every shape this repo's own code already treats
as forbidden or unsupported, plus more the 34-leaf hand-picked schema never had to confront. Scanned
the live spec's 61 definitions for exactly the keywords `enveloped()`/`provenance.ts` already gate
on:

| keyword     | occurrences across all 61 definitions |
| ----------- | ------------------------------------: |
| `minimum`   |                                   273 |
| `maximum`   |                                   276 |
| `maxLength` |                                   105 |
| `minLength` |                                     0 |
| `pattern`   |                                     0 |

In order of how much of the document each touches:

1. **`minimum`/`maximum` on numeric fields (549 occurrences combined).** These are the exact
   keywords `provenance.ts` says strict mode rejects and the existing test gate checks for (see the
   discrepancy flagged in §1 — this is exactly the population that discrepancy is about). Every one
   would need stripping, or its numeric zod schema replaced with a bare `z.number()` — the same move
   this repo already makes for `confidence`.
2. **The `$ref`/definition graph must be fully dereferenced and its cycles broken.** The spec is
   built almost entirely from `$ref` composition. Strict mode does support `$ref`/recursive schemas
   in principle, but a generator still has to pick a canonicalization strategy (inline everything,
   or keep `$ref` and pull every referenced definition to the top level) and verify the result is
   still a single closed, non-`anyOf` root object — Swagger 2.0's `$ref` graph was never designed
   with "strict-mode single-schema" as a target shape.
3. **Every leaf must become required + nullable, and every object must gain
   `additionalProperties: false`.** Swagger 2.0 has no first-class `nullable`; a field's presence in
   `required` is its only closed-ness signal, used sparingly and inconsistently across the 61
   definitions (most fields are optional-by-omission — the opposite of what strict mode demands). A
   generator has to invert this stance for every field, not fix a handful of edge cases — the same
   rewrite `enveloped()` already does for the 34-field patch schema, but blind, on 10–40× more
   fields, with no per-field human judgment about whether "nullable" is even semantically sound.
4. **Arrays.** `enveloped()` throws today on any array/record/union field (`enveloped.ts`, the
   allowlist's `throw` branch). The spec has array-typed fields (collection endpoints, line-item
   lists, ticket/file collections) that would hit this throw immediately — a full-schema generator
   cannot reuse `enveloped()` unmodified; it needs new array-handling semantics (min/maxItems? a
   fixed-size tuple? drop them entirely?) before it can process the real spec at all.
5. **Honorable mention: `maxLength` (105 occurrences)** sits on the same not-yet-confirmed-safe list
   as `minimum`/`maximum` per the §1 discrepancy — same treatment until that's re-checked.

---

## 4. What the anti-hallucination rule costs at scale

`provenance.ts`'s rule: every key required and nullable, no `.optional()`, so the model must emit an
explicit `null` for "not mentioned" — an omitted key is indistinguishable from a field the model
never considered.

At 34 leaves this costs one JSON object with 34 required `{value, confidence, sourceSpan}` triples
per call, most legitimately non-null on a full-walkthrough transcript (the schema was hand-picked to
match what auditors typically dictate). At `basedata` scale (300 leaves) — or `allJobData` scale
(1,326 leaves, which per §2 can't even be submitted) — the same rule forces the model to emit a
`null` triple for every field the spec covers that a single-room, single-system dictation never
touches. For a spec covering attics, walls, windows, doors, HVAC, DHW, PV, ducts, health/safety,
financing, incentives, work orders, and utility accounts, that's the large majority of the 300+
fields on almost every real transcript.

Using the repo's own numbers as the baseline unit: single-shot today is 1 call, ~30 s wall-clock
(per `spikes/extraction-search-plan/README.md`), producing roughly 100–140 output JSON properties
per response for 34 enveloped leaves. At `basedata` scale (1,201 enveloped properties — ~8.6× the
current pilot's property count), output tokens scale roughly linearly with property count because
every leaf, null or not, costs a full `"field": {"value": ..., "confidence": ..., "sourceSpan":
null}` — a rough order-of-magnitude estimate is **~8–9× today's output tokens** for a single call,
essentially all `null` padding on a room-scoped dictation. At `allJobData` scale this is moot: the
call cannot be made at all.

**This was not measured** — no LLM calls were made for this pass — it is a structural estimate from
the property-count ratio, not a benchmarked number. But the direction is unambiguous: cost and
latency scale with total schema size under this rule regardless of how much the auditor actually
said, because the rule requires touching every field every time.

**The rule doesn't need rethinking in principle at this scale — its economics do.** The rule stays
coherent (an omitted key is still indistinguishable from an unconsidered one, at any field count),
but its cost stops being a rounding error once most calls spend most of their output tokens
asserting "not mentioned" across sections of the schema (PV, financing, work orders) wholly
irrelevant to what the auditor said. The natural mitigation — partition the schema by section, only
invoke sections relevant to what was actually said — is exactly the multi-call decomposition
`spikes/extraction-search-plan/` already measured as a net loss at the **current, much smaller**
schema size (see §5): a wash-to-worse at 3× the LLM cost. That is reason to expect real difficulty
if pursued at 9× the field count, not a free path.

---

## 5. The baseline any new approach must beat

### `spikes/extraction-snuggpro/` — single-shot baseline (the floor)

Scored via `score.mjs` (mutation-proven per the search-plan spike's description) over 14
transcripts, on the real `SnuggFieldsSchema` (23 scalar/enum fields + the 11-test health matrix = 34
leaves). Figures pulled directly from `results/codex-score.json` / `results/opencode-score.json`:

- **codex (gpt-5.6):** hard hallucination **1/204 (≈0.5%)**; miss **1/120 (≈0.8%)**; both-non-null
  correct **118/118 (100%)**; enum accuracy **75/75 (100%)**; band mapping **8/8 (100%)**; spans
  verbatim **163/163 (100%)**; health matrix state accuracy **28/28 (100%)**, 0 hallucinated passes.
- **opencode (glm-5.2):** hard hallucination **2/205 (≈1%)**; miss **0/119 (0%)**; both-non-null
  correct **119/119 (100%)**; enum accuracy **75/75 (100%)**; band mapping **8/8 (100%)**; spans
  verbatim **186/186 (100%)**; health matrix state accuracy **28/28 (100%)**, 0 hallucinated passes,
  but 1 hallucinated-problem.
- Confidence does not discriminate hallucinated from correct extractions in either run (mean
  ~0.65–0.73 on hallucinated vs. ~0.97–1.0 on correct) — consistent with `provenance.ts`'s own
  warning against wiring review to it.

### `spikes/extraction-search-plan/` — the one alternative already tried, and its verdict

A 3-stage plan→locate→decide pipeline (3 LLM calls/transcript, ~43–108 s vs. baseline's 1 call/~30 s)
against the same 14 transcripts, same scorer, same ground truth. **Recommendation: DO NOT ADOPT** —
"a wash-to-worse at 3× the LLM cost," introducing a new failure mode (recall loss on ambiguous
transcripts) the baseline doesn't have:

- codex: hard hallucination 1→2 (worse), miss 1→0 (better), but +1 hallucinated health "pass" — net
  wash, arguably worse.
- opencode: miss 0→4 (much worse), 5 fields dropped on one transcript, enum accuracy 75→70, +1
  hallucinated-pass. Clearly worse.

The report's own conclusion: single-shot with a good prompt is already at the floor; neither
transcription errors nor cross-context bleed is helped by planning — both point the next effort at
segmentation and a deterministic manufacturer-snapper, not a multi-call pipeline.

**Reuse `spikes/extraction-snuggpro/score.mjs` untouched** to measure any future full-schema or
larger-schema attempt against these numbers — same convention both existing spikes already follow.

---

## Summary of what would have to be true to attempt this

1. **"The entire spec" (`allJobData`, ~1,326 leaves) is not feasible at all** — it fails two
   independent OpenAI structured-output hard limits simultaneously once enveloped. The API would
   reject the request outright, before any extraction-quality question arises.
2. **A scoped subset (`basedata`, ~300 leaves → 1,201 enveloped properties) is structurally
   acceptable** to the API, but is ~9× the current pilot's property count and would cost an
   unmeasured but structurally-implied ~8–9× more output tokens per call — mostly forced `null`
   padding.
3. **The transforms a generator would need, beyond what `enveloped()` already does:** strip/rewrite
   549 `minimum`/`maximum` occurrences (pending the §1 re-check); dereference and flatten the `$ref`
   graph while breaking cycles; invert Swagger 2.0's "optional by omission" default into "every leaf
   required and nullable"; and add array-handling semantics `enveloped()` doesn't have today.
4. **The anti-hallucination rule's principle survives; its economics don't, unmitigated** — and the
   obvious mitigation (partition by section) is exactly the decomposition already measured as a net
   loss at a much smaller scale.
5. **The bar to beat, precisely:** codex — 0.5% hard hallucination, 0.8% miss, 100% both-non-null,
   100% enum accuracy, 100% verbatim spans; opencode — 1% hard hallucination, 0% miss, 100%
   both-non-null, 100% enum accuracy, 100% verbatim spans. Reuse `score.mjs` untouched to measure any
   new attempt.

---

## Sources

- `https://developers.openai.com/api/docs/guides/structured-outputs` — OpenAI's structured-output
  limits and supported/unsupported keyword lists, quoted in §1. Fetched 2026-08-06; not re-verified
  by a live API call.
- `packages/ribo-core/src/provenance.ts`, `packages/ribo-core/src/enveloped.ts` — this repo's own
  strict-mode-compatibility rules and their known, documented gap.
- `packages/ribo-adapter-snuggpro/src/extraction-shape.test.ts` — the static, no-network gate that
  actually enforces strict-mode compatibility today.
- `https://app.snuggpro.com/apidocs/swagger.json` — the public, unauthenticated Snugg Pro OpenAPI
  spec used to compute the property/enum counts in §2–§3. See
  [17](17-snuggpro-field-reconciliation.md) for how this repo's field set maps onto it, and for the
  discussion of pinning a snapshot of this file for codegen (R1.7).
- `spikes/extraction-snuggpro/`, `spikes/extraction-search-plan/` — the measured baseline and the one
  alternative already tried, cited in §5.
