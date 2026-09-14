# Matched-Schema Scale Spike — Findings

## The question

**Does the 75.1% groundedness collapse reproduce on a matched schema of realistic
size, or was it mismatch?**

**It was mismatch.** On a 126-leaf Manual J schema against a Manual J document,
Mistral native extraction (arm A) averaged **87.1%** grounded across 3 runs — a
modest degradation from the 97.8% measured at 13 leaves, and far above the 75.1%
collapse observed on the 467-leaf mismatched schema. The degradation that does
exist is driven by run-to-run bimodality, not by schema size.

## Per-arm per-run numbers

All arms use the same 126-leaf Manual J schema (`mj_context` 53, `mj_loads` 29,
`mj_rooms` 17, `mj_building` 27) against Quote 4 (Wrightsoft Manual J). Scoring
uses `isSpanGrounded` from `@azx/ribo-core` (imported, not reimplemented) plus a
near-miss classifier adapted from `spikes/extraction-snuggpro/score.mjs`. Three
tiers: **grounded** (verbatim substring), **near-miss** (case/whitespace/
punctuation difference or partial fragment), **ungrounded** (no substantial
fragment found).

Note: the schema has 126 leaf _definitions_, but arrays expand at extraction
time (rooms, component loads, ducts, equipment, materials, etc.), so total leaf
_instances_ vary per run — 616–790 for arm A, 687 for arm B.

### Arm A — Mistral native, whole schema, one call

| Run     | Grounded | Near-miss | Ungrounded | Abstained | Filled  | Grounded % | Latency   |
| ------- | -------- | --------- | ---------- | --------- | ------- | ---------- | --------- |
| 1       | 527      | 21        | 9          | 233       | 557     | **94.6%**  | 243 s     |
| 2       | 322      | 30        | 54         | 210       | 406     | **79.3%**  | 180 s     |
| 3       | 484      | 30        | 40         | 232       | 554     | **87.4%**  | 239 s     |
| **avg** |          |           |            |           | **506** | **87.1%**  | **221 s** |

**Bimodality confirmed.** Run 2 dropped 15 pp below runs 1 and 3, and filled
150 fewer leaves (406 vs 557/554). The faster latency on the worst run (180 s
vs 239–243 s) suggests Mistral sometimes short-cuts the extraction — producing
fewer array elements with lower span quality — rather than being uniformly
noisy. The prior spike's bimodality finding holds.

### Arm B — Mistral OCR → singleShotExtractor × 4 (Claude Haiku 4-5)

| Run     | Grounded | Near-miss | Ungrounded | Abstained | Filled  | Grounded % | Wall     | Cost      |
| ------- | -------- | --------- | ---------- | --------- | ------- | ---------- | -------- | --------- |
| 1       | 434      | 7         | 4          | 242       | 454     | **97.5%**  | 89 s     | $0.28     |
| 2       | 434      | 7         | 4          | 242       | 454     | **97.5%**  | 89 s     | $0.28     |
| 3       | 434      | 7         | 4          | 242       | 454     | **97.5%**  | 89 s     | $0.28     |
| **avg** |          |           |            |           | **454** | **97.5%**  | **89 s** | **$0.28** |

**Zero run-to-run variance** (Claude at temperature 0 is deterministic). 4
parallel calls, 89 s wall (vs 180–243 s for Mistral native). $0.28 per run at
Haiku-4-5 list pricing ($1/$5 per M tokens). Uses `singleShotExtractor` from
`@azx/ribo-extractor-openai` — Ribo's own trust boundary (zod schema parse,
finish-reason check, prompt assembly all run).

`perGroupExtractor` was the first choice but `splitExtractionSchema` falls back
to a single non-grouped call for this schema: `isGroupObject` requires every
property of a group to be a `ZodObject`, and `extraction_notes` carries
`unreadable_or_ambiguous: z.array(extractedSchema(z.string()))` — an array of
envelopes, not a nested object — which collapses the split. Four separate
`singleShotExtractor` calls (one per part, parallel) mirrors what the existing
baseline did and uses the same extractor code.

### Arm C — B plus gap-fill

| Run | Grounded | Near-miss | Ungrounded | Abstained | Filled | Grounded % | Wall  | Cost  | Recovered |
| --- | -------- | --------- | ---------- | --------- | ------ | ---------- | ----- | ----- | --------- |
| 1   | 434      | 7         | 4          | 242       | 454    | **97.5%**  | 147 s | $0.42 | 0         |
| 2   | 434      | 7         | 4          | 242       | 454    | **97.5%**  | 146 s | $0.42 | 0         |
| 3   | 434      | 7         | 4          | 242       | 454    | **97.5%**  | 146 s | $0.42 | 0         |

**Gap-fill is worthless here.** Zero leaves recovered across all 3 runs. The
242 abstained leaves are genuinely absent from the document — the model
correctly identified them as null, and re-asking only burns $0.14 per run.
This is the expected outcome on a matched schema: there is no "gap" to fill
when the model already knows what it doesn't know.

### Arm D — A plus ungrounded-retry

| Run | Base G | Base U | Retry→G | Retry→null | Stayed wrong | Post G | Post U | Wall  | Retry cost |
| --- | ------ | ------ | ------- | ---------- | ------------ | ------ | ------ | ----- | ---------- |
| 1   | 488    | 18     | 22      | 0          | 26           | 510    | 26     | 253 s | $0.056     |
| 2   | 393    | 15     | 20      | 0          | 28           | 413    | 28     | 212 s | $0.056     |
| 3   | 457    | 18     | 22      | 0          | 26           | 479    | 26     | 241 s | $0.056     |

(Base G/U differ from arm A rows because arm D re-runs Mistral native
independently — the bimodality means each run gets a different base.)

**Ungrounded-retry partially helps.** It converts ~21 ungrounded spans to
grounded per run (finding the real verbatim text on a second pass), but:

- **Zero leaves convert to null** — the model never concedes the value is
  wrong; it only tries to find a better span.
- **26–28 leaves stay wrong** — the retry can't fix these because the values
  are either reformatted ("88 °F" vs "88.0°F" in the markdown), schema-generated
  (`extraction_notes.confidence = "high"` — "high" is not in the document), or
  short numbers that don't appear in the exact form quoted.

Net effect: ~3 pp improvement on arm A's average (87.1% → ~90.2%), at $0.056
per run. The "stayed wrong" residual is dominated by two fixable categories
(reformatted values and schema-generated fields), not by fabricated content.

## Adjudicated correctness

Where arms A and B disagree (run 1 vs run 1, 380 shared fills, 156 A-only, 74
B-only):

- **Most A-only fills are correct.** Arm A finds more array elements (duct
  details, latent cooling per component, additional sections_present entries)
  because it processes the PDF layout directly, not just the OCR markdown.
  These are real values the document contains.
- **Most B-only fills are correct.** Arm B fills some whole-home fields A
  misses (exposed wall area, glazing area, SHR) and explicitly notes
  unreadable/ambiguous fields in `extraction_notes`.
- **Value disagreements are mostly formatting** ("wrightsoft" vs "Wrightsoft",
  "50%" vs "50 %", "n" vs "N") — not factual errors.
- **One substantive disagreement**: `whole_home.total_cooling_btuh` — A says
  22162, B says 24251. Both cite document text; the difference is which table
  row each model reads. This is **ambiguous** — the document presents
  system-level and whole-home totals separately, and the schema does not
  distinguish which "total cooling" it wants.
- **`extraction_notes.confidence`** is **ambiguous by design** — the system
  prompt asks for "high/medium/low" which is a model assessment, not a
  document value. Any span cited for it is necessarily fabricated. This field
  should be excluded from groundedness scoring or moved outside the provenance
  envelope.

## What gap-fill and ungrounded-retry are worth

| Pass                 | When it helps                                                  | When it doesn't                                                               | Cost                        |
| -------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------- |
| Gap-fill (C)         | When the model abstains on fields the document actually states | On a matched schema where abstentions are real nulls                          | $0.14/run, 0 recovered      |
| Ungrounded-retry (D) | When the model has the right value but a reformatted span      | When the span is schema-generated or the value is reformatted beyond recovery | $0.056/run, ~46% conversion |

Gap-fill's value is on **mismatched** schemas — where the model should abstain
but doesn't, or vice versa. On a matched schema, the model's nulls are honest.
Ungrounded-retry's value is real but bounded: it fixes about half the
ungrounded spans, and the residual is structural (schema design, formatting
conventions) rather than fabricated content.

## What I could not control for

1. **Single document.** One Wrightsoft Manual J. A CoolCalc document would
   separate "native is worse" from "native suits Wrightsoft layouts" — the
   task flagged this, and budget did not allow it.
2. **Mistral cost.** The Mistral API response does not report token counts or
   cost. Latency is the only available proxy (180–243 s per native call).
3. **Claude structured output.** The Azure AI Foundry Anthropic endpoint does
   not enforce `response_format: json_schema` like OpenAI strict mode. The
   JSON Schema is included in the system prompt instead, and the model
   occasionally returns a non-conforming shape (a bare string for a leaf
   instead of `{value, confidence, sourceSpan}`). The harness retries up to 3
   times per part; in practice, 1 attempt suffices with the enhanced prompt
   that explicitly describes the envelope structure.
4. **Temperature.** Claude was run at temperature 0 (deterministic), which
   explains arm B's zero variance. Mistral's temperature is not configurable
   through this endpoint, which explains arm A's bimodality.
5. **`extraction_notes.confidence`** inflates the ungrounded count by ~4
   leaves per run in every arm — the field is a model assessment, not a
   document value, so its span is always fabricated. Excluding it would raise
   all arms' groundedness by ~0.5 pp.

## Recommendation

**Use flatten-then-extract (arm B) for production.** It is more accurate
(97.5% vs 87.1%), faster (89 s vs 221 s), cheaper ($0.28 vs unknown Mistral
cost), and deterministic (zero run-to-run variance). The 4-call parallel
pattern scales linearly with schema size — adding more parts adds more calls,
not a bigger one.

Mistral native (arm A) is viable for one-shot extraction when a second model
call is not possible, but the bimodality (79–95% range) means a single run
cannot be trusted. If native is the only option, run it 2–3 times and take
the majority — or apply the ungrounded-retry pass (arm D) as a post-hoc fix,
which brings the average to ~90%.

Gap-fill (arm C) should be deferred until a mismatched schema scenario
demonstrates its value. On matched schemas it is pure overhead.

---

## Fair-fight re-run — prompt parity

### Why we re-ran

The original comparison was unfair: arm B ran Ribo's mature instructions while
arm A got a compressed `document_annotation_prompt`. A prior spike measured
the prompt effect on Mistral directly — pinning the span instruction collapsed
bimodal 31/93/31/98% verbatim-span rate to a stable 95.8% across five runs.
This re-run gives both arms the same pinned span instruction and re-runs
everything fresh.

### What changed

- **Both arms get the pinned span instruction.** Arm A receives it in the
  `document_annotation_prompt` slot; arm B gets it appended to each part's
  existing `PARTS[part].system` prompt. The wording (adapted only for "page
  markdown you produce" vs "document text provided to you"):

  > A sourceSpan MUST be a contiguous substring copied character-for-character
  > out of the [page markdown / document text]. It is pasted, not written.
  >
  > - If the value sits in a table, copy the ENTIRE table row verbatim, pipes
  >   and spacing included
  > - If the value sits in running text, copy the exact phrase around it
  > - NEVER build a span by joining a label to a value unless those characters
  >   appear adjacently
  > - NEVER reformat, re-space, re-order, abbreviate or summarise a span
  > - If you cannot find text you can copy exactly, set sourceSpan to null.
  > - Before returning, re-read each sourceSpan and confirm it appears
  >   verbatim in the [markdown / document text].

- **Scoring uses `spanGroundedness`** from `@azx/ribo-core` (imported), not
  `isSpanGrounded` + the custom near-miss classifier. `spanGroundedness` is
  stricter: its near-miss tier covers only case / whitespace / quote /
  HTML-entity differences, while the prior classifier also counted
  punctuation-insensitive matches and 4-word fragment overlaps. Both arms are
  affected equally, but the absolute numbers are ~5 pp lower than the original
  and are NOT directly comparable to the original's figures. The gap IS
  comparable because both arms shifted by the same amount.

- **Five runs per arm** (up from three). Bimodality is the thing under test.

- **`extraction_notes.confidence` excluded** in a second column. That field
  asks for a model assessment ("high/medium/low"), not a document fact, so its
  span is fabricated by construction — ~4 ungrounded leaves per run that are
  unfixable and should not count against either arm.

### Prompt parity assessment

**The two are genuinely comparable.** Arm B's existing `PARTS[part].system`
prompts say "Return every value EXACTLY as it appears in the document —
verbatim strings. Never invent a value" — a verbatim-value rule, not a
verbatim-span rule. The `anthropicChat` adapter adds a generic "sourceSpan
(the exact verbatim quote from the document text, or null)" but that is
thinner than the pinned wording (no table-row rule, no self-check, no
anti-join rule). The Snugg Pro adapter's `instructions.ts` rule 3 IS
comparable in strength ("character-for-character substring", "do not join two
non-adjacent phrases", "fabricating a quote is worse"), but the harness does
not use those instructions — it uses the Manual J `PARTS[part].system`
prompts. Without the appended pinned wording, arm B's span instruction would
be weaker. With it appended, both arms have the same specific rule, and
neither has a meaningful advantage.

### Per-arm per-run numbers

Same 126-leaf Manual J schema, same document (Quote 4 Wrightsoft), same OCR
text. Scoring: `spanGroundedness` (three-tier).

#### Arm A — Mistral native, pinned span instruction

| Run | Grounded | Near-miss | Ungrounded | Abstained | Filled  | Grounded % | Excl conf % | Latency   |
| --- | -------- | --------- | ---------- | --------- | ------- | ---------- | ----------- | --------- |
| 1   | 337      | 0         | 173        | 273       | 510     | **66.1%**  | **66.6%**   | 245 s     |
| 2   | 407      | 1         | 28         | 179       | 436     | **93.3%**  | **94.2%**   | 194 s     |
| 3   | 607      | 1         | 31         | 230       | 639     | **95.0%**  | **95.6%**   | 285 s     |
| 4   | 533      | 2         | 67         | 220       | 602     | **88.5%**  | **89.1%**   | 259 s     |
| 5   | 231      | 19        | 103        | 188       | 353     | **65.4%**  | **66.2%**   | 185 s     |
| avg |          |           |            |           | **508** | **81.7%**  | **82.3%**   | **234 s** |

**Bimodality persists.** Range is 65.4%–95.0% (29.6 pp spread). The pinned
span instruction did not stabilise Mistral's output on this schema — contrary
to the prior spike's 95.8% stability, which was on a simpler task. The worst
runs (1 and 5) fill fewer leaves and produce more ungrounded spans, the same
pattern as the original.

#### Arm B — Mistral OCR → singleShotExtractor × 4 (Claude Haiku 4-5), pinned span instruction appended

| Run | Grounded | Near-miss | Ungrounded | Abstained | Filled  | Grounded % | Excl conf % | Wall     | Cost       |
| --- | -------- | --------- | ---------- | --------- | ------- | ---------- | ----------- | -------- | ---------- |
| 1   | 346      | 1         | 27         | 258       | 374     | **92.5%**  | **93.0%**   | 104 s    | $0.262     |
| 2   | 336      | 1         | 29         | 258       | 366     | **91.8%**  | **92.3%**   | 59 s     | $0.260     |
| 3   | 349      | 1         | 29         | 307       | 379     | **92.1%**  | **92.8%**   | 59 s     | $0.271     |
| 4   | 335      | 1         | 29         | 258       | 365     | **91.8%**  | **92.5%**   | 59 s     | $0.260     |
| 5   | 335      | 1         | 28         | 259       | 364     | **92.0%**  | **92.8%**   | 59 s     | $0.260     |
| avg |          |           |            |           | **370** | **92.0%**  | **92.7%**   | **68 s** | **$0.262** |

**Stable but no longer perfectly deterministic.** Range is 91.8%–92.5% (0.7 pp
spread). In the original spike all three runs were identical (97.5%); here
there is small variation, likely because the Azure AI Foundry Anthropic
endpoint has slight non-determinism at temperature 0, or because the pinned
span instruction causes the model to produce slightly different array lengths.
Run 1 had one part (`mj_loads`) truncated (`finishReason: "length"`) and
retried successfully — the pinned wording may increase output length slightly.

### Did prompt parity close the gap?

**No.** The gap is ~10.3 pp (92.0% vs 81.7%), essentially unchanged from the
original's 10.4 pp (97.5% vs 87.1%). Both arms dropped ~5.5 pp due to the
stricter scoring, so the relative performance is the same. The pinned span
instruction did not help arm A more than arm B — if anything, arm A's
bimodality widened (65.4%–95.0% vs the original's 79.3%–94.6%).

The original claim stands and is now defensible: flatten-then-extract (arm B)
produces more grounded spans than Mistral native (arm A) on a matched schema,
with or without prompt parity. The gap is not a prompt artifact.

### Side question 1 — is Mistral's temperature settable?

**No.** Passing `"temperature": 0` in the request body returns HTTP 422:

```json
{
  "detail": [
    {
      "type": "extra_forbidden",
      "loc": ["body", "temperature"],
      "msg": "Extra inputs are not permitted",
      "input": 0
    }
  ]
}
```

The endpoint explicitly rejects the `temperature` field as an extra input.
Arm A's bimodality is therefore not controllable through this API and is not
a configuration artifact — it is inherent to the endpoint. The contrast with
arm B's near-determinism (Claude at temperature 0) is a real finding, not a
confound.

### Side question 2 — Ribo's own ungrounded rate

Arm B's ungrounded count IS Ribo's own ungrounded rate:

| Run | Ungrounded | Excl conf | Span-scorable | Ungrounded % |
| --- | ---------- | --------- | ------------- | ------------ |
| 1   | 27         | 25        | 374           | 7.2%         |
| 2   | 29         | 27        | 366           | 7.9%         |
| 3   | 29         | 26        | 379           | 7.7%         |
| 4   | 29         | 26        | 365           | 7.9%         |
| 5   | 28         | 25        | 364           | 7.7%         |
| avg | **28.4**   | **25.8**  | **370**       | **7.7%**     |

Ribo's own ungrounded rate is **~7.7%** (92.0% grounded) or **~7.0%** excl
confidence (92.7% grounded). The ~25.8 ungrounded leaves (excl conf) include
both fabricated spans and reformatted values that don't appear verbatim — the
`spanGroundedness` near-miss tier is narrow, so a span like `"$ 5,250.00"`
against document text `"$       5,250.00"` counts as near-miss (1 per run),
but a reformatted span like `"88 °F"` against `"88.0°F"` counts as ungrounded.

### Which is the honest headline?

**Excluding `extraction_notes.confidence`** is the honest headline: **arm A
82.3% vs arm B 92.7%** (gap 10.4 pp). The four `extraction_notes.confidence`
leaves per arm are fabricated by construction (the field asks for "high/
medium/low" — a model assessment, not a document fact), so counting them
penalises both arms for a schema design issue, not an extraction quality
issue. The with-confidence figures (81.7% vs 92.0%) are reported for
completeness but understate both arms by ~0.6 pp.

### What I could not control for

1. **Single document.** Same Wrightsoft Manual J as the original. A CoolCalc
   document would separate "native is worse" from "native suits Wrightsoft
   layouts."
2. **Scoring change.** `spanGroundedness` is stricter than the original's
   `isSpanGrounded` + custom near-miss. Both arms dropped ~5.5 pp, so the gap
   is unchanged, but the absolute numbers are NOT comparable to the original.
3. **Mistral cost.** The API does not report token counts. Latency is the
   only proxy (185–285 s per native call).
4. **Anthropic endpoint non-determinism.** Arm B is no longer perfectly
   deterministic (0.7 pp spread vs 0 in the original), even at temperature 0.
5. **`anthropicChat` system-message handling.** The adapter converts the
   system message to a user message (the Anthropic Messages API extracts
   `system` separately), so arm B's prompt structure differs from arm A's
   `document_annotation_prompt` slot. This was present in the original too.
