# Mistral-native vs flatten-then-extract: is native extraction any good?

**Date:** 2026-09-11
**Status:** Complete. Spike committed; raw outputs gitignored.

## The question

Ribo's pipeline today flattens a document to text, then extracts. Mistral
Document AI's OCR endpoint can do both in one call (`pages[].markdown` +
`document_annotation` against a strict JSON schema). A previous spike proved
the native path is _shaped_ right. This spike asks the question that spike
did not: **on the same documents and the same schema, does native extract
more accurate field values than flatten-then-extract?**

Short answer: **no.** Flatten-then-extract won or tied every quality measure.
Native's one genuine win is the round-trip count. A Mistral package is a
transcriber, not an extractor.

## Design

- **Corpus:** two Manual J reports of different kinds — a 24-page
  **Wrightsoft** report (`Quote 4`) with a per-room loads table, and a
  15-page **CoolCalc** report (`Quote 6`) with per-room "Room Detail" pages
  and no shared room table. Two different vendors, two different layouts.
  Both are real customer documents (named preparers, addresses) — no raw
  document text is committed.
- **Schema:** one Manual J schema (`rooms[]` × 6 leaves + `house` × 7
  leaves), built with `enveloped(valuesSchema, { provenance: {} })` from
  `@azx/ribo-core` and converted with `z.toJSONSchema`, so both arms were
  handed the identical enveloped shape (`{ value, confidence, sourceSpan }`
  per leaf).
- **Native arm:** one Mistral `ocr` call with
  `document_annotation_format: { type: "json_schema", strict: true }` and a
  `document_annotation_prompt` carrying Ribo's extraction rules.
- **Flattened arm:** one Mistral OCR call (no annotation) for markdown, then
  `singleShotExtractor` from `@azx/ribo-extractor-openai` over
  **claude-haiku-4-5** with Ribo's standard instructions plus the pinned
  span wording from the prompt-vs-granularity spike. Using Mistral for the
  text in both arms holds OCR constant — what differs is only who extracts.
- **5 runs per arm per document** (the earlier spike saw run-to-run
  bimodality). 20 model calls total, plus 10 shared OCR calls.
- **A claimed OCR bug that does not reproduce — corrected 2026-09-11.** This
  spike originally reported that Mistral links each table out as
  `[tbl-N.md](tbl-N.md)` and ships the content in `pages[].tables[]`, and that
  `lib.mjs` hydrates it back. Re-measured directly against both documents this
  spike used, with and without `document_annotation_format`:

  | document              | `[tbl-` placeholders | inline pipe-table lines | `pages[].tables` |
  | --------------------- | -------------------- | ----------------------- | ---------------- |
  | Wrightsoft, plain OCR | 0                    | 585                     | 0                |
  | Wrightsoft, annotated | 0                    | 585                     | 0                |
  | CoolCalc, plain OCR   | 0                    | 108                     | 0                |

  The markdown already carries its tables inline, `pages[].tables` is always
  empty, and the hydration loop in `lib.mjs` therefore never executes. **The
  results below are unaffected** — both arms scored against complete markdown
  either way, because the no-op changed nothing. But the API claim is wrong,
  and the "first run read as 52% fabrication" story behind it is unverified.
  Do not carry either into a Mistral transcriber package.

## The five measures

### 1. Agreement (consistency, not quality)

| Document   | Fields compared | Agree   | Rate      |
| ---------- | --------------- | ------- | --------- |
| Wrightsoft | 467             | 448     | 95.9%     |
| CoolCalc   | 275             | 229     | 83.3%     |
| **Total**  | **742**         | **677** | **91.2%** |

### 2. Adjudicated quality (the measurement that matters)

All **65** disagreements were adjudicated against the source PDF's own text
layer (pdfplumber), cross-checked against the Mistral markdown the models
saw. Method and the two judgment calls are documented in `adjudicate.mjs`.

| Verdict                                                                                                                                                                                                                            | Count | Correct arm   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------- |
| Wrightsoft `totalCoolingLoad`: native read the sensible-only column (22162), flattened read the TOTALS row Sen+Lat (24251)                                                                                                         | 4     | **flattened** |
| Native emitted zone-summary rows (Level 1/2 ODU) as extra rooms, duplicating per-room rows                                                                                                                                         | 12    | **flattened** |
| Native abstained on `heatingEquipmentManufacturer`/`Model`/`hvacSystemType` that the document states; flattened found them with grounded spans                                                                                     | 3     | **flattened** |
| CoolCalc `CFM: N` — native put a real per-room number into `coolingAvf`/`heatingAvf`; the doc states one undifferentiated CFM per room, so the value is real but the field attribution is ambiguous; flattened uniformly abstained | 46    | ambiguous     |

**Decisive disagreements: flattened 19, native 0.** The 46 ambiguous rows
are not native fabrications — every one of its `CFM: N` spans is verbatim
document text — but they are also not wins: a single "CFM" figure cannot
honestly populate a heating-airflow field and a cooling-airflow field, and
the conservative reading (flattened's null) is the one Ribo's contract
prefers.

### 3. Groundedness (`spanGroundedness`, imported from `@azx/ribo-core`)

| Arm       | Spans | Grounded | Near-miss | Ungrounded | Verbatim % |
| --------- | ----- | -------- | --------- | ---------- | ---------- |
| Native    | 690   | 675      | 0         | 15         | 97.8%      |
| Flattened | 635   | 635      | 0         | 0          | **100.0%** |

Native's 15 ungrounded spans are all the same shape: on CoolCalc house
totals it emitted `"Heating BTUH: 26,219"`-style label+value spans, but the
markdown is a table (`| Heating BTUH: | 26,219 |`) with a cell-separating
pipe, so the concatenation is not a contiguous substring. The values are
right; the spans are mechanically unverifiable. Native also emits many
bare-number spans (`"802"`, `"22162"`) that are grounded but carry almost no
context for a reviewer — counted as grounded here, worth noting as a
review-UX cost.

### 4. Null behaviour

- Flattened emitted a value where native emitted null **3** times — all
  adjudicated as real and correct (the equipment rows above). Flattened
  **never** emitted an invented value anywhere in the 742-leaf set.
- Native emitted a value where flattened emitted null **58** times: 46 are
  the ambiguous CoolCalc CFM rows (real text, debatable field), 12 are the
  duplicated zone-summary rows (real text, wrong granularity).
- Net: neither arm invents numbers. Flattened abstains exactly where the
  document is silent; native over-fills at the margins — the failure mode
  Ribo's "a wrong guess is worse than a null" rule cares about.

### 5. Cost and latency (per document, mean of 5)

| Arm       | Wrightsoft (24pp)                                                             | CoolCalc (15pp)                                           |
| --------- | ----------------------------------------------------------------------------- | --------------------------------------------------------- |
| Native    | **41.6s**, one call                                                           | **22.7s**, one call                                       |
| Flattened | 49.5s total (19.3s OCR + 30.2s Claude, 24.2k prompt / 5.2k completion tokens) | 26.5s total (7.6s OCR + 18.9s Claude, 9.3k / 2.5k tokens) |

Native is one round trip and ~15–20% faster wall-clock. It does **not** save
the OCR call: `document_annotation` is billed and executed on top of the
same page processing, and you still want the markdown back for span-checking,
so the savings are one network round trip and the Claude tokens, not the
OCR.

## What I could not control for

- **Sample size.** Two documents, both Manual J reports, one schema. This
  is a signal, not a result — it says nothing about quotes or floorplans,
  and nothing about whether a CoolCalc-tuned prompt would flip the CFM
  behaviour.
- **Prompt asymmetry.** The flattened arm ran Ribo's mature, pinned
  instruction set; the native arm ran a compressed version inside
  `document_annotation_prompt`. A better native prompt might close some of
  the gap (though not the OCR-table pipe-splitting, which is structural).
- **Model choice on the flattened arm.** claude-haiku-4-5 is Ribo's
  default-class extractor; a stronger model would only widen the gap.
- **Adjudicator.** One adjudicator (me), mechanical rules where possible.
  The two judgment calls (TOTALS-vs-sensible cooling; CFM attribution) are
  documented in `adjudicate.mjs` and both were decided against native —
  re-running with the opposite call on the CFM rows still leaves flattened
  ahead 19–0 on decisive rows.

## Verdict per measure

| Measure             | Winner                                      |
| ------------------- | ------------------------------------------- |
| Agreement           | tie-ish (consistency only)                  |
| Adjudicated quality | **flattened (19–0 decisive)**               |
| Groundedness        | **flattened (100% vs 97.8%)**               |
| Null behaviour      | **flattened (no over-fill)**                |
| Cost / latency      | **native (one round trip, ~15–20% faster)** |

## Recommendation

**Transcriber only.** A Mistral package should ship as a
`Transcriber<DocumentCapture>` behind the existing seam and no more. The
native extractor is not more accurate than Ribo's flatten-then-extract path —
it is slightly worse on value accuracy, mechanically worse on span
groundedness, and mildly prone to over-filling fields the document does not
clearly populate — and the one thing it wins (a round trip) is worth ~7s on
a 24-page document. That is not enough to carry a second extraction
strategy whose spans are harder to verify.

## Artifacts

- `run-experiment.mjs` — runner (OCR phase + two extraction arms)
- `retry-failed.mjs` — fills in flattened runs that failed schema validation
- `score.mjs` — agreement + groundedness comparison
- `adjudicate.mjs` — adjudication rules and per-arm correctness tally
- `lib.mjs` — shared transport (Mistral OCR with table hydration, Anthropic
  ChatClient, credentials)
- `results/` — **gitignored, contains real customer data.** Raw markdown,
  extractions, comparison rows, adjudication queue.
