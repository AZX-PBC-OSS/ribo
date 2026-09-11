# Prompt vs granularity: does prompt pinning rescue per-cell citations?

**Date:** 2026-09-11
**Status:** Complete. Spike committed.

## The question

Ribo's group-provenance-granularity feature rests on one measurement:
`claude-haiku-4-5` fabricated **37% of per-cell citations** on a Manual J (17 of 46),
while **14 of 14** per-row spans came back verbatim. The design concluded that a row
span is _inherently_ easier for a model to quote than a cell span, and added a
`"leaf" | "row" | "none"` granularity knob on that basis.

A separate Mistral spike suggested the 37% may be a **prompt artifact**, not a
property of cell-vs-row citation: per-cell span fidelity was bimodal (31% or 95%
depending on the run) against Mistral Document AI, and pinning the span instruction
collapsed the bimodality to a stable 95.8%.

**This experiment asks: does the same prompt pinning rescue per-cell citations for a
Claude model, run through Ribo's own extraction code?**

## Design

### 2×2 factorial, 5 runs per cell

|                                       | Current wording | Pinned wording |
| ------------------------------------- | --------------- | -------------- |
| **Leaf granularity** (per-cell spans) | Arm A           | Arm B          |
| **Row granularity** (per-row spans)   | Arm C           | Arm D          |

- **Model:** `claude-haiku-4-5` via Azure AI Foundry's Anthropic endpoint
  (`x-api-key` auth, `tool_use` for structured output — the Anthropic equivalent of
  OpenAI's `response_format: json_schema`).
- **Extractor:** `singleShotExtractor` from `@azx/ribo-extractor-openai`, imported
  from the built `dist/`. One call per run, the full schema in one
  `response_format`.
- **Schema:** `enveloped(valuesSchema, { provenance })` from `@azx/ribo-core`, where
  `valuesSchema` has a `rooms` array (6 leaves: name, area, heatingLoad, coolingLoad,
  heatingAvf, coolingAvf) and a `house` group (3 leaves: totalHeatingLoad,
  totalCoolingLoad, totalArea). Leaf arms produce 87 spans (14 rooms × 6 + 3 house);
  row arms produce 17 spans (14 room rows + 3 house leaves, house stays at `"leaf"`).
- **Document:** `Quote 4 - Manual J (Wrightsoft) - Final.pdf` — 24 pages, 14 rooms
  across two IDU zones, total heating load 34,334 Btuh. Text extracted with
  **pdfplumber** (Python), saved as `transcript.txt` (32,256 chars). The model sees
  the same text that `spanGroundedness` checks against.
- **Scoring:** `spanGroundedness(span, transcript)` from `@azx/ribo-core` — the exact
  exported function. Three tiers: `grounded` (verbatim substring), `near-miss`
  (case/whitespace/quote-insensitive match), `ungrounded` (text not in the document).
- **Arm A** uses Ribo's current prompt wording (adapted from
  `packages/ribo-adapter-snuggpro/src/instructions.ts` for document extraction —
  same rule 3: "character-for-character substring", "if you paste the span into a
  find-in-page, it must match").
- **Arm B** adds the pinned span instruction from the Mistral spike: "A sourceSpan
  MUST be a contiguous substring copied character-for-character out of the page text.
  If the value sits in a table, copy the ENTIRE table row verbatim, pipes and spacing
  included. NEVER build a span by joining a label to a value unless those characters
  appear adjacently. If you cannot find text you can copy exactly, set sourceSpan to
  null."
- **Arms C and D** use `"row"` granularity: `enveloped(valuesSchema, { provenance:
{ rooms: "row" } })` — each room gets one `sourceSpan` for the whole row.

### What I chose and why

- **singleShotExtractor** (not perGroup): the schema fits in one call (12 nullable
  unions for leaf, 7 for row — well under the 16 cap). One call per run keeps the
  prompt intact and the comparison clean.
- **No few-shot examples:** avoids the contamination risk the existing spike
  documented (a transcript identical to a few-shot example inflates scores).
- **5 runs per arm:** the Mistral bimodality only appeared across runs; one run per
  arm proves nothing. 20 total calls, claude-haiku-4-5 is cheap.
- **House group at `"leaf"` in all arms:** the row/leaf comparison is about the
  `rooms` table. Keeping `house` at `"leaf"` in the row arms isolates the variable.
- **pdfplumber, not Ribo's `ribo-transcriber-pdfjs`:** the PDF transcriber runs in a
  browser context (needs a Worker). pdfplumber is a simpler CLI extraction and
  produces clean text for the room tables. The transcript format affects what the
  model sees and what `spanGroundedness` checks against — this is a known caveat.

## Results

### Per-run breakdown

| Arm               | Run | Grounded | Near-miss | Ungrounded | Total | Verbatim %      |
| ----------------- | --- | -------- | --------- | ---------- | ----- | --------------- |
| A — leaf, current | 1   | 85       | 0         | 2          | 87    | 97.7%           |
| A — leaf, current | 2   | 87       | 0         | 0          | 87    | 100.0%          |
| A — leaf, current | 3   | 87       | 0         | 0          | 87    | 100.0%          |
| A — leaf, current | 4   | 87       | 0         | 0          | 87    | 100.0%          |
| A — leaf, current | 5   | 87       | 0         | 0          | 87    | 100.0%          |
| B — leaf, pinned  | 1   | 87       | 0         | 0          | 87    | 100.0%          |
| B — leaf, pinned  | 2   | —        | —         | —          | —     | (network error) |
| B — leaf, pinned  | 3   | 87       | 0         | 0          | 87    | 100.0%          |
| B — leaf, pinned  | 4   | 87       | 0         | 0          | 87    | 100.0%          |
| B — leaf, pinned  | 5   | 87       | 0         | 0          | 87    | 100.0%          |
| C — row, current  | 1   | 17       | 0         | 0          | 17    | 100.0%          |
| C — row, current  | 2   | 17       | 0         | 0          | 17    | 100.0%          |
| C — row, current  | 3   | 17       | 0         | 0          | 17    | 100.0%          |
| C — row, current  | 4   | 16       | 0         | 1          | 17    | 94.1%           |
| C — row, current  | 5   | 17       | 0         | 0          | 17    | 100.0%          |
| D — row, pinned   | 1   | 17       | 0         | 0          | 17    | 100.0%          |
| D — row, pinned   | 2   | 17       | 0         | 0          | 17    | 100.0%          |
| D — row, pinned   | 3   | 17       | 0         | 0          | 17    | 100.0%          |
| D — row, pinned   | 4   | 17       | 0         | 0          | 17    | 100.0%          |
| D — row, pinned   | 5   | 17       | 0         | 0          | 17    | 100.0%          |

### Per-arm aggregates

| Arm               | Grounded | Total | Verbatim % | Per-run rates            |
| ----------------- | -------- | ----- | ---------- | ------------------------ |
| A — leaf, current | 433      | 435   | 99.5%      | 97.7, 100, 100, 100, 100 |
| B — leaf, pinned  | 348      | 348   | 100.0%     | 100, 100, 100, 100       |
| C — row, current  | 84       | 85    | 98.8%      | 100, 100, 100, 94.1, 100 |
| D — row, pinned   | 85       | 85    | 100.0%     | 100, 100, 100, 100, 100  |

### The ungrounded spans

Only 3 ungrounded spans occurred across all 20 runs, and all were on the `house`
totals — never on the room table:

- **A run 1, `house.totalHeatingLoad`:** `"TOTALS 1515 34334 22162"` — the model
  joined the `TOTALS` label with `22162` (the Entire House cooling value), but the
  actual transcript line is `TOTALS 1515 34334 24251 1400 1400`. A label-to-value
  join across rows.
- **A run 1, `house.totalCoolingLoad`:** same fabricated span.
- **C run 4, `house.totalHeatingLoad`:** `"Heating Summary\nStructure 34334 Btuh"`
  — text that appears nowhere in the document. A synthesized label.

The room-table spans (both leaf and row) were **perfect across all 20 runs** — zero
ungrounded, zero near-miss.

## Findings

### The hypothesis fails

**B does not beat A by a wide margin.** Arm A (leaf, current wording) is already at
**99.5%** verbatim (433/435). Arm B (leaf, pinned wording) is at **100.0%**
(348/348). The difference is 2 spans out of 783 — not a wide margin. The hypothesis
predicted B would dramatically rescue per-cell citations; there was nothing to
rescue.

**No bimodality.** The Mistral spike found 31% or 95% depending on the run — two
distinct modes. Here, Arm A's per-run rates are 97.7%, 100%, 100%, 100%, 100%. One
run had a minor deviation (2 ungrounded spans on house totals), not a separate mode.
The distribution is unimodal and concentrated at the top.

**The row-vs-leaf gap does not survive pinning — because it was never there.** Leaf
(A) at 99.5% is slightly _better_ than row (C) at 98.8%. Both are near-perfect. The
architectural conclusion that "a row span is inherently easier for a model to quote
than a cell span" is not supported by this measurement.

### What this can and cannot show

**Cannot show:** that the original 37% was a prompt artifact. Too many variables
differ:

- **Different document** (this is a different Wrightsoft Manual J).
- **Different schema** (87 spans vs 46; 6 leaves per room vs a different set).
- **Different extraction mechanism** (Anthropic `tool_use` with structured output
  vs whatever the original measurement used — possibly free-text JSON completion).
- **Possibly different model build** (`claude-haiku-4-5` may have been updated
  since the original measurement).
- **Adapted instructions** (I adapted Ribo's dictation-focused wording for document
  extraction, keeping the key verbatim-span rule but changing the context. The
  original measurement may have used the raw Snugg Pro instructions verbatim, which
  speak of "the auditor's dictation" — confusing when applied to a document.)

A difference in absolute numbers is expected and is **not** the finding.

**Can show:** that when a Claude model is given clear verbatim-span instructions
(even without the pinned table-row wording) and run through Ribo's own extraction
code with structured output, per-cell citation fidelity is near-perfect on a Manual J
report. The 37% fabrication rate is not reproduced. The bimodality is not reproduced.
The row-vs-leaf gap is not reproduced.

## Recommendation

The architectural decision (the `"leaf" | "row" | "none"` knob) is not wrong — it
has independent justifications:

- **Token budget:** 603 per-cell citations vs 67 per-row citations for a 67-row
  table. That is a real cost regardless of fidelity.
- **Reviewer UX:** a reviewer does not click through 603 citations. A row span is
  the right unit for a wide table.
- **Partitioning:** row/none leaves cost 1 nullable union each (vs 2 for enveloped),
  so a 15-leaf row group fits in one call instead of two.

But the **empirical basis** for the decision — "row is inherently easier to quote,
cell fabrication is 37%" — is not reproduced when the prompt is well-worded and the
model uses structured output. The decision should be re-grounded on the token-budget
and reviewer-experience arguments, not on the fabrication-rate comparison.

If the original 37% is reproducible at all, reproducing it would require matching its
exact setup: same document, same schema, same prompt wording, same extraction
mechanism. Until that is done, the 37% should be cited as a historical measurement
under specific conditions, not as a general property of cell-level citation.

## Files

- `run-experiment.mjs` — the harness (imports from `dist/`, scores with
  `spanGroundedness`)
- `transcript.txt` — **not committed.** pdfplumber extraction of the Manual J PDF. The
  corpus is real customer work (named contractor, named preparer), so it is gitignored
  rather than published. Regenerate it with pdfplumber against
  `Quote 4 - Manual J (Wrightsoft) - Final.pdf` to re-run the harness. The committed
  `results/` quote room-table rows and totals only, and carry no personal data.
- `results/` — per-run raw extraction JSON + score JSON + `summary.json`
