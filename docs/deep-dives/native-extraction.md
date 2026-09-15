# Native Extraction: Measured

Mistral Document AI can return structured output in the same call as its OCR: `document_annotation`,
a strict JSON schema filled against the pages it just read. That is Ribo's whole post-parser
pipeline in one request — flatten and extract collapsed into one endpoint. If it works, Ribo's
extractor is redundant; if it doesn't, a Document AI package is a transcriber and nothing more.
This page is the measurement behind [Comparison](/guide/comparison)'s "What we measured" section,
and it took three rounds to get the comparison right. Short answer: **flatten-then-extract won or
tied every quality measure in all three rounds.** Native's one genuine win is a round trip.

::: warning What this page does and does not measure
Like everything in this section, this is about citation fidelity and cross-arm agreement — not
extraction accuracy. The numbers below are groundedness (is the quoted span really in the text) and
adjudicated disagreement counts, on one vendor, one document family (Manual J load-calculation
reports), one schema shape, two to five runs per arm. None of it says how often either arm's
**values** are correct; see [Extraction: Measured](/deep-dives/accuracy) for why that number does
not exist yet.
:::

The numbers were also revised once, against ourselves: the first two rounds gave the flattened arm
better prompts than the native arm, and a fair-fight re-run supersedes them. Where the scorer
changed between rounds, the absolute figures are not comparable across rounds — each section says
which scorer it used. The **gap** between arms is comparable throughout.

## Round 1: same OCR, who extracts?

Two real Manual J reports of different kinds — a 24-page Wrightsoft report with a per-room loads
table, and a 15-page CoolCalc report with per-room detail pages and no shared table. Real customer
documents (named preparers, addresses); no raw text is published. One enveloped Manual J schema —
`{ value, confidence, sourceSpan }` per leaf — handed to both arms:

- **Native** — one Mistral `ocr` call with
  `document_annotation_format: { type: "json_schema", strict: true }` and Ribo's extraction rules in
  `document_annotation_prompt`.
- **Flattened** — the same Mistral OCR call for markdown, then Ribo's `singleShotExtractor` over
  Claude Haiku 4.5 with Ribo's standard instructions plus the pinned span wording.

Five runs per arm per document, 20 model calls plus 10 shared OCR calls. The OCR is held constant,
so the only difference is who extracts.

| measure                                             | winner                                                        |
| --------------------------------------------------- | ------------------------------------------------------------- |
| Agreement across arms (consistency, not quality)    | tie-ish — 91.2% of 742 fields                                 |
| Adjudicated disagreements (all 65, against the PDF) | **flattened, 19–0 decisive**                                  |
| Groundedness (`spanGroundedness`)                   | **flattened, 100% vs 97.8%**                                  |
| Null behaviour                                      | **flattened — never invented a value; native over-filled 58** |
| Cost / latency                                      | **native — one round trip, ~15–20% faster**                   |

The details worth keeping:

- **The 19 decisive rows, all flattened's:** native read a sensible-only column where the TOTALS row
  said otherwise (4); emitted zone-summary rows as extra rooms, duplicating per-room rows (12); and
  abstained on equipment fields the document states that flattened found with grounded spans (3).
- **The 46 ambiguous rows are not native fabrications.** On CoolCalc, native put a real per-room
  `CFM: N` figure into both a heating-airflow and a cooling-airflow field; every span is verbatim
  document text, but one CFM figure cannot honestly populate two fields, and the conservative
  reading — flattened's null — is the one Ribo's contract prefers.
- **Native's 15 ungrounded spans are all one shape:** label+value concatenations like
  `"Heating BTUH: 26,219"` quoted across a markdown table's cell-separating pipe, so the string is
  not a contiguous substring. The values are right; the spans are mechanically unverifiable.
- **Native does not save the OCR call.** `document_annotation` is billed and executed on top of the
  same page processing, and the markdown is still wanted for span-checking. The saving is one
  network round trip and the Claude tokens — 41.6 s against 49.5 s on the 24-page report, 22.7 s
  against 26.5 s on the 15-page one.

Caveats: two documents, one schema, one adjudicator (us), and a **prompt asymmetry** — flattened ran
Ribo's mature instruction set while native ran a compressed version in `document_annotation_prompt`.
That asymmetry is round 3's subject.

## A vendor-API claim, corrected

Round 1 originally reported that Mistral links each table out as `[tbl-N.md](tbl-N.md)` and ships
the content in `pages[].tables[]`, with the harness hydrating it back into the markdown.
Re-measured directly against both documents, with and without an annotation request: **zero
placeholders, tables already inline (585 and 108 pipe-table lines), `pages[].tables` always empty.**
The hydration loop never executed, so the results were unaffected either way — both arms scored
against complete markdown — but the API claim was wrong, and a "first run read as 52% fabrication"
story that had been attached to it is unverified. Neither claim should be carried into a Mistral
transcriber package.

## Round 2: a matched schema at 126 fields

An earlier, mismatched run — a 467-field Snugg Pro schema against a Manual J document — had seen
native groundedness collapse to 75.1%. Was that schema size or schema mismatch? **It was mismatch.**
A 126-leaf Manual J schema written for the same Wrightsoft document (616–790 leaf instances per run
as arrays expand), scored with `isSpanGrounded` plus a near-miss classifier — a looser scorer than
`spanGroundedness`, so this round's absolute figures are not comparable to round 3's; the gap is:

| arm                                    | runs | grounded %                     | latency   | note                         |
| -------------------------------------- | ---: | ------------------------------ | --------- | ---------------------------- |
| Native, whole schema, one call         |    3 | 94.6 / 79.3 / 87.4 — avg 87.1% | 180–243 s | bimodal                      |
| Flatten-then-extract, 4 parallel calls |    3 | 97.5 ×3                        | 89 s wall | $0.28/run, zero variance     |
| Flatten + gap-fill re-ask              |    3 | 97.5 ×3                        | +58 s     | 0 leaves recovered           |
| Native + ungrounded-retry              |    3 | ~90.2% post-retry              | 212–253 s | ~46% of ungrounded converted |

- **Bimodality confirmed.** The worst native run dropped 15 pp below the others and filled 150
  fewer leaves — and its latency was the _shortest_, suggesting the model sometimes short-cuts the
  extraction rather than being uniformly noisy.
- **Gap-fill is worthless on a matched schema.** Zero leaves recovered across three runs: the 242
  abstained leaves are genuinely absent from the document, and re-asking only burned $0.14 per run.
  Gap-fill's value is on mismatched schemas, where abstentions lie.
- **Ungrounded-retry is real but bounded.** It converts about half the ungrounded spans to verbatim
  ones, never concedes a value to null, and leaves 26–28 wrong per run — dominated by reformatted
  values and schema-generated fields, not fabricated content.

Adjudicating where the arms disagree found most fills correct on both sides, value disagreements
mostly formatting ("wrightsoft" vs "Wrightsoft", "50%" vs "50 %"), and one substantive disagreement:
`total_cooling_btuh` — 22,162 vs 24,251, which table row is "the" total is ambiguous in the document.
It also found a schema flaw that matters for scoring: `extraction_notes.confidence` asks for a model
assessment ("high/medium/low"), not a document fact, so any span cited for it is **fabricated by
construction** — ~4 ungrounded leaves per run in every arm, worth ~0.5 pp against both. Round 3
scores with and without it.

Caveats: one document; the Mistral API reports no token counts, so latency is the only cost proxy
for native; the Azure AI Foundry Anthropic endpoint does not enforce `response_format: json_schema`
(the schema rode in the system prompt, and the harness retried non-conforming shapes up to three
times); Mistral's temperature is not configurable through this endpoint.

## Round 3: the fair fight

Rounds 1 and 2 were unfair in the same direction: flattened ran mature, pinned instructions while
native got a compressed prompt. A prior probe had measured the prompt effect on Mistral directly —
pinning the span instruction collapsed a bimodal 31/93/31/98% verbatim rate to a stable 95.8% on a
simpler task — so parity was worth giving. The re-run gives **both arms the same pinned span
instruction**, five runs each, and switches scoring to `spanGroundedness`, which is stricter than
round 2's classifier: absolute numbers drop ~5.5 pp from round 2 and are not comparable to it; the
gap is.

The instruction both arms received (adapted only for "page markdown you produce" vs "document text
provided to you"):

> A sourceSpan MUST be a contiguous substring copied character-for-character out of the [page
> markdown / document text]. It is pasted, not written.
>
> - If the value sits in a table, copy the ENTIRE table row verbatim, pipes and spacing included
> - If the value sits in running text, copy the exact phrase around it
> - NEVER build a span by joining a label to a value unless those characters appear adjacently
> - NEVER reformat, re-space, re-order, abbreviate or summarise a span
> - If you cannot find text you can copy exactly, set sourceSpan to null.
> - Before returning, re-read each sourceSpan and confirm it appears verbatim in the [markdown /
>   document text].

Same 126-leaf schema, same document, same OCR text. Excluding `extraction_notes.confidence` is the
honest headline — that field's span is fabricated by construction, and counting it penalises both
arms for a schema design issue rather than an extraction one:

| run | native, incl. conf | native, excl. conf | flattened, incl. conf | flattened, excl. conf |
| --: | -----------------: | -----------------: | --------------------: | --------------------: |
|   1 |              66.1% |              66.6% |                 92.5% |                 93.0% |
|   2 |              93.3% |              94.2% |                 91.8% |                 92.3% |
|   3 |              95.0% |              95.6% |                 92.1% |                 92.8% |
|   4 |              88.5% |              89.1% |                 91.8% |                 92.5% |
|   5 |              65.4% |              66.2% |                 92.0% |                 92.8% |
| avg |          **81.7%** |          **82.3%** |             **92.0%** |             **92.7%** |

**Prompt parity did not close the gap.** It is 10.3 pp, essentially unchanged from round 2's 10.4 pp.
If anything, native's bimodality widened — 65.4–95.0%, a 29.6 pp spread, against round 2's
79.3–94.6% — so the pinned instruction did not stabilise Mistral on a schema of this size; the 95.8%
stability came from a simpler task. Flatten-then-extract stayed near-deterministic (91.8–92.5%),
though no longer perfectly so even at temperature 0 — the endpoint has slight residual
non-determinism, and run 1 needed a successful retry after one part hit `finishReason: "length"`.

**Side finding — temperature is not a knob on that endpoint.** Passing `"temperature": 0` in the
request body returns HTTP 422 (`extra_forbidden`): the endpoint explicitly rejects the field. Native's
bimodality is therefore not a configuration artifact a caller could tune away. The contrast with
flatten-then-extract's near-determinism is a real finding, not a confound — and it is why the spread,
not the gap, is the headline: a single benchmark run would have reported whichever number it happened
to draw, and been confident about it.

On the same corpus, flatten-then-extract's ungrounded rate is also **Ribo's own number**: ~7.7% of
span-scorable leaves, or ~7.0% excluding the confidence field — about 26 of 370 checkable fields per
run. That count includes reformatted values that do not appear verbatim, not only invented ones;
[Comparison](/guide/comparison) publishes it with those caveats.

## What this doesn't settle

**Verdict first: a Document AI package is a transcriber, not an extractor.** Native is slightly
worse on value agreement, mechanically worse on span groundedness, prone to over-filling fields the
document does not clearly populate, and unstable run-to-run on a schema of realistic size — while
the one thing it wins, a round trip, was worth about 7 s on a 24-page document. If native is ever
the only option, a single run cannot be trusted: run two or three and take the majority, or apply an
ungrounded-retry pass, which brings the average to ~90% at best.

Everything above is one vendor, one document family, and — after round 1 — one document per round. A
CoolCalc document would separate "native is worse" from "native suits Wrightsoft layouts"; that
control was never run. Latency is the only cost signal for native. The adjudicator was one person,
deciding both judgment calls against native — though re-running round 1's adjudication with the
opposite call on the CFM rows still leaves flattened ahead 19–0. And none of it measures whether a
value is _correct_: grounding catches invention, not misreading; see
[Extraction: Measured](/deep-dives/accuracy).
