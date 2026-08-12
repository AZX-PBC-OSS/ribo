# Accuracy report — visual design

**Date:** 2026-08-11
**Status:** Approved, implemented by the plan's Task 6
**Applies to:** the generated `docs/deep-dives/accuracy.md`

The rendering half of
[`extraction-accuracy-report-design.md`](./extraction-accuracy-report-design.md). That
document decides _what is persisted_; this one decides _how it is read_.

This records the durable reasoning only. The stylesheet lives in
`scripts/accuracy-page.css` and the markup is emitted by `scripts/generate-accuracy-page.mjs`
— deliberately not duplicated here, so there is one copy of each to keep correct.

**The page is generated, not rendered by a component.** The parent design said "VitePress
data loader", but a loader only supplies data — rendering it inside a VitePress markdown
page needs `v-html` and a `<script setup>` block, i.e. Vue, in a repo with zero `.vue` files
and no custom theme. Since the report needs no client-side behaviour at all (`<details>` is
the only interactivity), the page is generated whole instead, exactly as `docs:api` already
generates `docs/reference/` with TypeDoc. `docs:accuracy` runs ahead of both `docs:dev` and
`docs:build`, and the output is gitignored so it can never drift from the run records it is
built from.

**One hard constraint the generator must respect:** nothing emitted inside `<div class="ar">`
may be a blank or whitespace-only line. markdown-it ends an HTML block at the first blank
line, after which indented lines become code blocks and the enclosing tags never match —
surfacing as a Vue "Element is missing end tag" error pointing at a tag that is perfectly
balanced, hundreds of lines from the real cause. `assertNoBlankLines` enforces this at the
point of violation rather than leaving the build to fail confusingly.

## 1. The two readers

| Reader                     | First question                                    | Answered by                                               |
| -------------------------- | ------------------------------------------------- | --------------------------------------------------------- |
| Stakeholder                | "Is this good enough to ship?"                    | Run header, rate row, gates — above the fold, no clicking |
| Engineer mid-prompt-change | "Which fields moved, and what did the model say?" | Coverage field (shape), problems section (substance)      |

Order follows: **verdict → gates → shape → substance.** A stakeholder can stop after the
third block. An engineer never reads the grid cell by cell, because the problems section
already contains every cell worth reading.

Editorial rule throughout: **every number is stated with its denominator, and nothing
implies a target that does not exist.** No gauges, dials, donuts, progress bars, or
composite "score". `passed: true` renders as _gates cleared_, with the gate list directly
beneath it, because that is all it means.

## 2. The reduction: 14 verdicts → 5 buckets, 2 of which carry colour

Buckets are cut on **what the reader must do next** — the only axis that survives
compression to five levels. Counts are from the first real run (`codex-cli`, 2026-08-12).

| Bucket        | Verdicts                                                                                                                  | Count | Ink                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------- | ----- | --------------------------------- |
| **absent**    | `correct-null`                                                                                                            | 523   | none — cell is page background    |
| **captured**  | `correct`                                                                                                                 | 168   | neutral solid square, 40% of cell |
| **excused**   | `miss-excused`, `sanctioned`, `unscorable`                                                                                | 5     | neutral dotted ring, hollow       |
| **shortfall** | `miss`, `health-miss`, `health-clean-dropped`                                                                             | 13    | yellow, 45° stripes               |
| **fault**     | `hallucination`, `hallucination-soft`, `wrong`, `health-wrong`, `health-hallucinated-pass`, `health-hallucinated-problem` | 5     | red, full fill + drawn ✕          |

523 + 168 + 5 + 13 + 5 = **714** ✓ — exceptions (non-absent, non-captured) = **23**.

- **fault** — the model _asserted something untrue_. Fabricating a value and getting a
  stated value wrong are the same class of harm downstream: a number reaches a report that
  nobody said. `hallucination-soft` belongs here because softly fabricated is still
  fabricated; the softness is a detail, and details live in the problems text.
- **shortfall** — the model _failed to say something true_. Under-extraction. Different
  remedy, different risk, so kept apart from fault — collapsing them would let a cautious
  model that emits nothing look identical to a confabulating one.
- **excused** — already accounted for by the harness. Must be _visible_ (so denominators
  are auditable) and _chromatically silent_ (so they do not read as findings).

The bucket is the **colour**; the verdict is the **word**. Verdict names are never replaced
by bucket names anywhere a reader might act on them — they appear in each cell's
screen-reader text, in the problems entry title, and in the legend.

## 3. `correct` vs `correct-null` — ink versus no ink

Separated on the strongest channel available:

- `correct-null` (523) draws **nothing**. The cell is page background inside the hairline.
- `correct` (168) draws a solid neutral square at 40% of the cell.

Three consequences, all intended:

1. **A degenerate all-null extraction renders as a completely empty grid.** It cannot be
   mistaken for success at any zoom, from any distance, in greyscale, on a phone.
   Conflating the two verdicts would have rendered it as a full field of confirmation —
   flattering precisely the failure the harness's miss guard exists to catch.
2. Ink density _is_ coverage, read pre-attentively.
3. An entirely blank row is legible as its own fact — a leaf no transcript ever mentions —
   and is marked `—` in the row margin. A schema observation the grid surfaces for free.

## 4. Solving the 73%-one-verdict problem

523 of 714 cells share one verdict. A conventional heatmap of that is a uniform wash with
23 meaningful pixels. Four moves, in order of contribution:

1. **Invert the ink.** The majority verdict is the _absence_ of a mark. 523 cells stop
   competing for attention; the foreground becomes the 191 that carry information. This is
   the difference between "find the red in a red-ish wash" and "find the marks on a mostly
   blank page." This is the whole solve; the rest is refinement.
2. **Escalate on three channels, not hue.** Severity raises fill _extent_ (none → 40% →
   hollow ring → 100% striped → 100% solid + border + ✕), ink _weight_, and _texture_. A
   fault cell is the only thing that fills a cell edge to edge with a surrounding border,
   so it breaks the grid's rhythm geometrically and is findable in peripheral vision.
3. **Group the rows.** 51 undifferentiated rows is a wall. One `<tbody>` per schema
   subtree, with a group label row. Our real groups are `basedata` (7), `hvac` (12),
   `attic` (5), `wall` (4), `window` (3), `dhw` (6), `health` (14) — 51 total. This gives
   vertical landmarks and lets a reader say "the health block is where the misses are,"
   which for the first run is literally true: 12 of 13 shortfalls are `health-miss`.
4. **Totals in the margins.** Two right-hand columns per row (`cap` = captured, `flag` =
   exceptions) and a footer row of per-transcript exception counts. The margins are the
   fast path; the cells exist to show _pattern_ — is a fault isolated, a whole row, or a
   whole column?

**Row order is schema order, always.** No sorting by severity, no collapsing clean rows.
Both would make each run's grid a different shape and destroy run-to-run diffability —
the artifact's main value to the engineer reader.

## 5. Non-colour redundant encoding

Every bucket carries **three** channels; any one alone suffices.

| Bucket    | Fill extent        | Texture / glyph         | Border              | Text                               |
| --------- | ------------------ | ----------------------- | ------------------- | ---------------------------------- |
| absent    | 0%                 | —                       | hairline only       | blank; row margin `—` if whole row |
| captured  | 40% centred square | flat                    | none                | sr-text `correct`                  |
| excused   | 0% (hollow)        | 1.5px dotted ring       | dotted              | sr-text verdict                    |
| shortfall | 100%               | 45° stripes, 3px pitch  | 1px solid           | sr-text verdict                    |
| fault     | 100%               | drawn ✕ (two diagonals) | 1px solid perimeter | sr-text verdict + anchor           |

Glyphs are drawn with `linear-gradient` and `border`, never font characters — no font
dependency, no tofu, correct at 20px, and they survive a print driver dropping background
colours, because gradients print as image data and the 1px borders are the fallback.

**Greyscale:** yellow-soft and red-soft may converge, so the pair is separated by texture
(stripes vs ✕), never by hue alone.

**Screen readers:** the 523 absent cells carry no text on purpose — 714 announcements is a
denial of service, not access. The caption states the blank convention, the margins give
per-row totals, and the problems section is a _complete_ non-visual path to every
non-trivial cell, not a summary.

## 6. Colour system

All tokens are `--ar-` prefixed, defined on `:root`, redefined under `html.dark`. Nothing
else in the docs site reads them.

Mapped straight to VitePress (no values of our own): `--ar-bg`, `--ar-text`, `--ar-text-2`,
`--ar-rule`, `--ar-brand`, and the `-soft` / `-1` / `-2` triples for red and yellow. Text is
only ever placed on a `-soft` tint, never on `-1`/`-2`/`-3`, because `-soft` is a low-alpha
tint over the theme background in both themes and keeps `--ar-text` above 4.5:1.

Two tokens VitePress does not provide:

| Token           | Light     | Dark      | Contrast on theme bg | Used for                        |
| --------------- | --------- | --------- | -------------------- | ------------------------------- |
| `--ar-ink`      | `#3c4148` | `#c3c8ce` | ≈9.6:1 / ≈10.2:1     | `captured` square               |
| `--ar-ink-soft` | `#6a7076` | `#8b9198` | ≈4.9:1 / ≈5.5:1      | `excused` ring, margin numerals |

`--ar-ink` sits far above the 3:1 a graphical object needs, chosen so the 168 captured
squares read as _ink_ rather than a grey wash — §3's density signal depends on it.
`--ar-ink-soft` is deliberately weaker (the hierarchy excused needs) while still clearing
AA for the numerals it also carries.

**`--vp-c-green-*` is referenced nowhere**, including the all-clear gate list. Green turns
a floor into a congratulation; correct extraction is the baseline and a cleared gate is
the absence of an alarm. It also means a single `TRIPPED` row in red is the only chromatic
event in that block, and unmissable.

## 7. Rates — the denominators, stated correctly

**This section corrects an error in the source spec**, which described the miss rate as
"13 shortfall cells over 316 scorable slots." That conflates the _shortfall bucket_ with
the _miss-rate numerator_; they are different quantities and there is no 316 in the data.
A page that misstates its own denominator is worse than no page.

What the scorer actually computes, and what the page must say:

| Rate          | Formula                            | First run            |
| ------------- | ---------------------------------- | -------------------- |
| Hallucination | `hallucinationHard / gtNull`       | 3 / 398 = 0.8%       |
| Miss          | `miss / (gtNonNull − missExcused)` | 1 / (134 − 4) = 0.8% |
| Enum accuracy | `enumCorrect / enumGtMember`       | 94 / 94 = 100%       |

The miss rate's numerator is `miss` **only**. The 12 `health-miss` cells are tracked
separately by the scorer as `hMiss` and are _not_ in it. The page must therefore state the
health shortfalls as their own figure rather than folding them into the headline miss rate,
and the method note must say so explicitly — otherwise the grid (13 striped cells) and the
headline (1 miss) appear to contradict each other, and a reader is right to distrust both.

## 8. Sparkline

`viewBox="0 0 132 34"`, plot box `x ∈ [4,128]`, `y ∈ [4,30]`. Stroke is `currentColor` from
`--ar-text-2` — the trend line carries **no semantic colour**, because a rate going up is
not automatically bad and a hue would assert that it is.

**Y domain is fixed, never autoscaled:** `yMax = max(2%, ceil(1.25 × maxValue))`, always
starting at 0. At 0.8% that gives a 0–2% domain, so a 0.8 → 0.9 wobble is a small step
rather than a cliff. Autoscaling is the most common way a sparkline lies about a
low-variance rate, and these are exactly that. For enum accuracy (a fraction near 1),
invert: `[max(0, min − 5pp), 100]`.

**The n=1 case is the default, not an edge case.** No `<polyline>` — a one-point polyline
renders as nothing in some engines and a zero-length stroke artifact in others, and both
read as broken. Emit the dashed baseline plus a single `r=2.5` dot at the **right** edge,
where "latest" always sits, so the point does not migrate as history accumulates. Caption
reads `1 run — no trend yet`: absence of a trend is _reported_, never implied by an empty
box. At `n=0`, emit no `<svg>` at all — an empty axis frame is the one thing that does look
broken.

## 9. Deliberately not done

- **A conventional heatmap** — at 73% one verdict it is a uniform field. Inverting the ink
  was the solve; a colour ramp reintroduces the problem.
- **A colour per verdict** — 14 hues are unlearnable, unprintable, and hostile to
  colour-blind readers.
- **Green anywhere**, including all-clear gates. See §6.
- **Gauges, dials, donuts, progress bars** for any rate — each implies a target; there
  isn't one.
- **Autoscaled sparkline axes** — 0.8 → 0.9 would look like a collapse.
- **Sorting the grid by severity or collapsing clean rows** — destroys diffability.
- **A hazard bar chart** — eight zeros is an empty frame, and `2` vs `0` invites reading a
  magnitude where only pass/fail exists.
- **Screen-reader text on all 714 cells** — 714 announcements is not access.
- **Any client-side scripting** — no filters, sorts, tooltips, or search. `title` is used
  nowhere as a primary channel, since it is unavailable on touch and to keyboard users.
- **Percentages in the grid margins** — a percentage of 14 is false precision.
- **A composite "total accuracy" score** — four rates with four different denominators do
  not average, and a single figure is exactly what invites shipping on a number nobody can
  decompose.
