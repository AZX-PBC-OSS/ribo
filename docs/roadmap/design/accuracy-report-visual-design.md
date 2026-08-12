# Extraction accuracy report — design spec v2

Supersedes `accuracy-report-spec.md`. v1 is kept for the diff; where v2 says "unchanged",
v1 is the authority.

Two notes before the spec:

- **The `dataviz` skill is not present in this workspace** (available: decks, docs,
  prototypes, fliers, wireframes, animation, 3D, maps, exports). Same as last time — the
  reasoning below is mine and stated inline so you can audit it.
- **Nocturne is bound to this project but deliberately not applied.** This page ships into a
  public VitePress docs site and must inherit the _reader's_ theme, light or dark. Painting
  Nocturne's dark ground onto one page of someone else's docs site would make it look
  broken in light mode. The page takes all colour from VitePress custom properties; the only
  Nocturne principles carried over are the ones that are theme-agnostic: flush-left
  asymmetric layout, dense spacing, hairline rules over boxes, colour as a mark rather than
  a flood, and outlined rather than filled controls.

---

## 0. What changed from v1, in one table

| v1                                           | v2                                                                                        | Why                                                                  |
| -------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| No scripting at all                          | Vanilla JS, progressive enhancement, no framework                                         | v1 over-read "no Vue" as "no interactivity"                          |
| Two expert readers                           | Newcomer is **primary**; experts second                                                   | New brief                                                            |
| Page opened on a run header                  | Page opens on a **worked example**, then the finding                                      | A newcomer can't read a rate before they know what a slot is         |
| Bucket names were jargon (`absent`, `fault`) | Plain-English bucket names, verdict IDs kept alongside                                    | Teach at point of use                                                |
| Aggregates, then grid, then problems         | **Finding first** — `11-ambiguous-attic` and the 5 fabrications named in the first screen | The story was there but the reader had to derive it                  |
| Row labels were dotted paths                 | Row labels are **plain English first**, path second, statically in the DOM                | A hover tooltip fails on touch, on keyboard, and in print            |
| Sparkline at n=1                             | **No sparkline below n=3**; a stated sentence instead                                     | A dot on a dashed line reads as debris                               |
| Cell → anchor jump to Problems               | Cell → **inspector panel under the grid** (JS); anchor jump is the no-JS fallback         | Jumping loses your place in a 51-row grid                            |
| —                                            | **CSS-only** "problems only" filter (radio + `:has()`)                                    | Needs no JS at all, so it isn't an enhancement — it's the base layer |

Kept exactly as v1, unchanged and non-negotiable: inverted ink, `correct`/`correct-null`
distinct, no green, no gauges/dials/donuts/progress bars/composite score, every number with
its denominator, colour never the only signal, schema row order stable across runs, VitePress
light + dark, body never scrolls horizontally.

---

## 1. Layout, top to bottom

```
┌───────────────────────────────────────────────────────────────────────┐
│ 1  Title + one-sentence what-this-is                                  │
│ 2  WORKED EXAMPLE — 3 rows: transcript line → what the model wrote    │
│    → verdict in plain words. Teaches the whole page in ~120 words.    │
│    No aggregate number appears above this point.                      │
├───────────────────────────────────────────────────────────────────────┤
│ 3  THE FINDING — two prose claims, each with its number:              │
│      • 5 slots were filled with something the transcript doesn't say  │
│      • 12 health-safety checks were dropped, all in one transcript    │
│        (11-ambiguous-attic)                                           │
│    + run stamp (2026-08-12 00:20Z · codex-cli · gates cleared 8/8)    │
├───────────────────────────────────────────────────────────────────────┤
│ 4  Rates — 3 cards, value · denominator · history line                │
├───────────────────────────────────────────────────────────────────────┤
│ 5  Gates (8) + shape conformance                                      │
├───────────────────────────────────────────────────────────────────────┤
│ 6  Legend / how to read — plain names, counts, verdict IDs            │
├───────────────────────────────────────────────────────────────────────┤
│ 7  Grid — filter control, 51 × 14 field, margins                      │
│    └ inspector panel, sticky under the grid                           │
├───────────────────────────────────────────────────────────────────────┤
│ 8  Problems — 23 entries in full (also the inspector's data source)   │
├───────────────────────────────────────────────────────────────────────┤
│ 9  Method + limits                                                    │
└───────────────────────────────────────────────────────────────────────┘
```

### Why the worked example goes first

A newcomer's first question is not "how accurate is it" — it's "accurate at _what_". Three
concrete rows answer that in less time than a definition would, and they establish the three
outcomes that the rest of the page counts. It also front-loads the honesty: the reader sees a
real failure before they see a 0.8%, so the small number lands as a measurement rather than
as reassurance.

Hard rule: **no aggregate number appears above the worked example.** A percentage read before
you know its unit is noise at best and a claim at worst.

### Why the finding goes second

The run's actual story is a single-column collapse (12 health checks dropped in
`11-ambiguous-attic`) and 5 fabrications. In v1 both facts were _derivable_ from the grid and
the margins, which is not the same as being _told_. Two sentences with numbers in them, above
the fold, is what a manager needs and is all they need. Each links to the evidence.

### Why terms are defined inline and there is no glossary

A glossary at the bottom is read by nobody who needed it. Every term appears the first time
inside a `<dfn>` with its definition in the same sentence: "a **slot** — one field on one
transcript, 51 × 14 = 714 of them". The technical verdict IDs (`correct-null`,
`health-miss`, `hallucination-soft`) appear only in the legend and in problem entries, always
next to their plain-English bucket, never as the only name for a thing.

---

## 2. Buckets: plain names, same five groups

The v1 partition was right; only the labels change. The plain name is what the reader sees;
the verdict ID is what the engineer greps.

| Plain name (shown)  | Verdict IDs (also shown, smaller)                                                                                         | Count | Ink                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----- | --------------------------------- |
| **Nothing to find** | `correct-null`                                                                                                            | 523   | none — cell is page background    |
| **Found it**        | `correct`                                                                                                                 | 168   | solid neutral square, 40% of cell |
| **Not counted**     | `miss-excused`, `sanctioned`, `unscorable`                                                                                | 5     | hollow dotted ring                |
| **Missed it**       | `miss`, `health-miss`, `health-clean-dropped`                                                                             | 13    | **yellow**, 45° stripes           |
| **Made it up**      | `hallucination`, `hallucination-soft`, `wrong`, `health-wrong`, `health-hallucinated-pass`, `health-hallucinated-problem` | 5     | **red**, full fill + drawn ✕      |

523 + 168 + 5 + 13 + 5 = **714** ✓ — needing attention: **23**

"Made it up" covers both fabrication (3, ground truth was null) and contradiction (2, the
transcript said something else). Justification unchanged from v1 and reinforced by the new
brief: to the auditor whose report this becomes, a number nobody said and a number someone
said differently are the same harm. The distinction is one word inside each problem entry
(`hallucination` vs `wrong`), which is where a distinction that doesn't change the response
belongs.

`correct` vs `correct-null` — encoding unchanged (ink vs no ink), and the plain names now
carry it too: "Found it" versus "Nothing to find". A degenerate all-null extractor still
renders as a completely blank grid, which is the whole point.

---

## 3. Colour system

Tokens, mappings and contrast unchanged from v1 §5. Restated with measured figures.

### 3.1 Mapped to VitePress

| Token             | Value (both themes)       | Used for                                        |
| ----------------- | ------------------------- | ----------------------------------------------- |
| `--ar-bg`         | `var(--vp-c-bg)`          | ground, sticky label backing, inspector backing |
| `--ar-text`       | `var(--vp-c-text-1)`      | body text                                       |
| `--ar-text-2`     | `var(--vp-c-text-2)`      | headers, denominators, notes                    |
| `--ar-rule`       | `var(--vp-c-divider)`     | section rules, card borders                     |
| `--ar-brand`      | `var(--vp-c-brand-1)`     | links, focus rings, filter control state        |
| `--ar-fault-fill` | `var(--vp-c-red-soft)`    | "made it up" cell fill, TRIPPED chip            |
| `--ar-fault-ink`  | `var(--vp-c-red-1)`       | ✕ strokes, TRIPPED word, bucket heading         |
| `--ar-fault-edge` | `var(--vp-c-red-2)`       | cell perimeter                                  |
| `--ar-short-fill` | `var(--vp-c-yellow-soft)` | "missed it" cell fill                           |
| `--ar-short-ink`  | `var(--vp-c-yellow-1)`    | stripes, bucket heading                         |
| `--ar-short-edge` | `var(--vp-c-yellow-2)`    | cell perimeter                                  |

`--vp-c-green-*` is referenced **nowhere.**

The `-soft` tints are low-alpha composites over `--vp-c-bg` in both themes, so `--ar-text` on
top of them stays above 4.5:1 — which is why text never sits on `-1`, `-2` or `-3`. `-1` is
VitePress's accessible-on-background strong tone, re-tuned per theme, so it is the only tone
used for strokes and for coloured words.

### 3.2 Tokens VitePress doesn't provide, with measured contrast

| Token           | Light     | vs `#ffffff` | Dark      | vs `#1b1b1f` | Used for                            |
| --------------- | --------- | ------------ | --------- | ------------ | ----------------------------------- |
| `--ar-ink`      | `#3c4148` | **10.3 : 1** | `#c3c8ce` | **10.2 : 1** | "Found it" square                   |
| `--ar-ink-soft` | `#6a7076` | **5.0 : 1**  | `#8b9198` | **5.4 : 1**  | "Not counted" ring; margin numerals |

Both far exceed the 3:1 a graphical object needs. `--ar-ink` is pushed to ~10:1 on purpose:
the density-as-coverage reading in §2 only works if the 168 squares are unambiguous _marks_
rather than a grey haze. `--ar-ink-soft` at ~5:1 is clearly the weaker of the pair — the
hierarchy "Not counted" needs — while still passing AA for the margin numerals it also
carries. The two-step gap between them is perceptual, not just numeric, so the two neutral
states never trade places between themes.

Derived, one definition each because their source already flips:

```
--ar-grid-line : color-mix(in srgb, var(--vp-c-divider) 60%, transparent)
--ar-zero      : color-mix(in srgb, var(--vp-c-text-3) 55%, transparent)
```

---

## 4. Non-colour redundant encoding

Unchanged from v1. Three channels per bucket; any one suffices.

| Bucket          | Fill extent | Texture (CSS-drawn, no font glyphs) | Border              | Words                                                         |
| --------------- | ----------- | ----------------------------------- | ------------------- | ------------------------------------------------------------- |
| Nothing to find | 0%          | —                                   | grid hairline       | blank + stated convention; `—` in row margin if the whole row |
| Found it        | 40% square  | flat                                | none                | `correct` in sr-text                                          |
| Not counted     | 0%, hollow  | 1.5px dotted ring                   | dotted              | verdict ID in sr-text                                         |
| Missed it       | 100%        | 45° stripes, 3px pitch              | 1px solid           | verdict ID + entry in Problems                                |
| Made it up      | 100%        | drawn ✕, two 1.5px diagonals        | 1px solid perimeter | verdict ID + entry in Problems                                |

Drawn with `linear-gradient` and `border`, never text characters: no font dependency, no
tofu, correct at 18–20px, and survives a print driver dropping background colours because
gradients print as image data and the 1px borders are the fallback. Greyscale: the
yellow/red pair may converge, so it is separated by texture (stripes vs cross) and by the
words in every other appearance.

New in v2 — the **filter control is itself a redundant encoding**: "Only the 23 that need
attention" collapses the grid to 11 rows, so a reader who can see no colour at all can still
get the exception set as a shape, not just as a list.

---

## 5. HTML

Root: `<div class="ar">`. VitePress compiles markdown as a Vue SFC, so no double braces
appear anywhere below; add `v-pre` to the root if you later paste copy that might contain
them.

### 5.1 Title + worked example

```html
<div class="ar">
  <header class="ar-intro">
    <p class="ar-kicker">Extraction accuracy</p>
    <h1 class="ar-title">How well the model fills in the audit form</h1>
    <p class="ar-lede">
      An energy auditor talks through a house. We transcribe it, and a language model reads the
      transcript and fills in a structured form of 51 fields. This page reports what it got right
      and wrong across 14 transcripts, checked field by field against a form a human filled in from
      the same recording.
    </p>
  </header>

  <section class="ar-example" aria-labelledby="eg-h">
    <h2 class="ar-h" id="eg-h">Three real slots, to show what is being counted</h2>
    <p class="ar-sub">
      A <dfn class="ar-dfn">slot</dfn> is one field on one transcript. 51 fields &times; 14
      transcripts = 714 slots. Every slot gets one of these outcomes.
    </p>

    <ol class="ar-eg-list">
      <li class="ar-eg ar-eg-ok">
        <p class="ar-eg-said">
          <span class="ar-eg-lbl">The auditor said</span>
          <q>about twelve inches of blown cellulose up in the attic</q>
        </p>
        <p class="ar-eg-wrote">
          <span class="ar-eg-lbl">The model wrote</span>
          <span class="ar-eg-field">Attic insulation type</span>
          <code>cellulose</code>
        </p>
        <p class="ar-eg-verdict">
          <span class="ar-c ar-captured ar-eg-swatch" aria-hidden="true"></span>
          <b>Found it.</b> Stated in the recording, captured correctly. 168 slots went this way.
        </p>
      </li>

      <li class="ar-eg ar-eg-short">
        <p class="ar-eg-said">
          <span class="ar-eg-lbl">The auditor said</span>
          <q>you could feel it rolling back out at the draft hood</q>
        </p>
        <p class="ar-eg-wrote">
          <span class="ar-eg-lbl">The model wrote</span>
          <span class="ar-eg-field">Combustion spillage</span>
          <code class="ar-p-null">blank</code>
        </p>
        <p class="ar-eg-verdict">
          <span class="ar-c ar-short ar-eg-swatch" aria-hidden="true"></span>
          <b>Missed it.</b> A safety observation, described in ordinary words rather than the
          form&rsquo;s term, and left blank. 13 slots went this way.
        </p>
      </li>

      <li class="ar-eg ar-eg-fault">
        <p class="ar-eg-said">
          <span class="ar-eg-lbl">The auditor said</span> <q>&hellip;the old one downstairs</q>
          <span class="ar-eg-note">and nothing else about its age</span>
        </p>
        <p class="ar-eg-wrote">
          <span class="ar-eg-lbl">The model wrote</span>
          <span class="ar-eg-field">Furnace age, years</span>
          <code>18</code>
        </p>
        <p class="ar-eg-verdict">
          <span class="ar-c ar-fault ar-eg-swatch" aria-hidden="true"></span>
          <b>Made it up.</b> A plausible number that nobody said. This is the outcome that matters
          most, and it happened 5 times.
        </p>
      </li>
    </ol>

    <p class="ar-sub">
      There is a fourth, much commoner outcome: the auditor never mentioned a field and the model
      correctly left it blank &mdash; <b>nothing to find</b>, 523 slots. It counts as correct, but
      it is weaker evidence than <b>found it</b>, so this page never mixes the two. A model that
      returned an entirely blank form would score 523 of those and would show up here as a
      completely empty grid.
    </p>
  </section>
</div>
```

### 5.2 The finding

```html
<section class="ar-finding" aria-labelledby="find-h">
  <h2 class="ar-h" id="find-h">What this run found</h2>

  <ol class="ar-claims">
    <li class="ar-claim ar-claim-fault">
      <p class="ar-claim-n">5</p>
      <p class="ar-claim-t">slots hold something the recording doesn&rsquo;t say.</p>
      <p class="ar-claim-d">
        Three are inventions where the auditor said nothing at all; two contradict what was said.
        All five are listed in full, with the transcript wording, under
        <a href="#problems">Problems</a>.
      </p>
    </li>

    <li class="ar-claim ar-claim-short">
      <p class="ar-claim-n">12</p>
      <p class="ar-claim-t">
        health-and-safety checks were dropped &mdash; all of them from the same transcript.
      </p>
      <p class="ar-claim-d">
        Every one is in <code>11-ambiguous-attic</code>, a recording where the auditor talks about
        the attic and the combustion appliances in the same breath. This is a single-transcript
        failure, not a spread-out weakness: it appears in the grid as one column of marks.
        <a href="#coverage-h">See the column</a>.
      </p>
    </li>
  </ol>

  <p class="ar-caveat">
    Neither number is a threshold. Nobody has set an acceptable rate for either, and this page does
    not imply one. The eight automated stop-checks below all read zero, which means no known failure
    <em>mechanism</em> fired &mdash; it does not mean the run is good enough for any particular use.
  </p>

  <dl class="ar-meta">
    <dt>Run captured</dt>
    <dd><time datetime="2026-08-12T00:20Z">2026-08-12 00:20 UTC</time></dd>
    <dt>Backend</dt>
    <dd><code>codex-cli</code></dd>
    <dt>Stop-checks</dt>
    <dd>8 of 8 clear</dd>
    <dt>Corpus</dt>
    <dd>14 transcripts &middot; 51 fields &middot; 714 slots</dd>
  </dl>
</section>
```

### 5.3 Rates — with the v2 history line

```html
<section class="ar-rates" aria-label="Rates">
  <div class="ar-card">
    <h3 class="ar-k">Made-up rate</h3>
    <p class="ar-v">0.8<span class="ar-u">%</span></p>
    <p class="ar-d">3 of 398 slots the auditor never mentioned</p>
    <p class="ar-def">
      Of every slot where the correct answer was &ldquo;blank&rdquo;, how often did the model write
      something anyway.
    </p>
    <p class="ar-hist ar-hist-none">Run 1 of 1 &mdash; no history to compare against yet</p>
  </div>

  <div class="ar-card">
    <h3 class="ar-k">Miss rate</h3>
    <p class="ar-v">0.8<span class="ar-u">%</span></p>
    <p class="ar-d">1 of 130 slots the auditor did state</p>
    <p class="ar-def">
      Of every slot with something to find, how often the model left it blank. The 12 dropped health
      checks are <b>not</b> in this figure &mdash; they are counted separately,
      <a href="#problems">below</a>, so a safety failure can never be diluted by a large form.
    </p>
    <p class="ar-hist ar-hist-none">Run 1 of 1 &mdash; no history to compare against yet</p>
  </div>

  <div class="ar-card">
    <h3 class="ar-k">Fixed-choice accuracy</h3>
    <p class="ar-v">100<span class="ar-u">%</span></p>
    <p class="ar-d">94 of 94 slots</p>
    <p class="ar-def">
      Some fields accept only a fixed list of answers &mdash; fuel type, for instance. Every one of
      those was a member of the list, and the right member.
    </p>
    <p class="ar-hist ar-hist-none">Run 1 of 1 &mdash; no history to compare against yet</p>
  </div>
</section>
```

### 5.4 Gates + shape conformance

Structure and all eight rows unchanged from v1 §6.3, with the heading and one sentence
rewritten for the newcomer:

```html
<section class="ar-gates" aria-label="Stop-checks">
  <h2 class="ar-h">Stop-checks</h2>
  <p class="ar-sub">
    Eight specific failures we refuse to ship, whatever the rates say. Each is a count, and any
    count above zero stops the release. They are not a score and they do not add up to one &mdash;
    they are eight independent tripwires for mistakes bad enough to be worth naming.
  </p>

  <ul class="ar-gate-list">
    <li class="ar-gate is-clear">
      <span class="ar-gate-n">fuelDropped</span
      ><span class="ar-gate-p">a stated heating fuel went missing</span
      ><span class="ar-gate-c">0</span><span class="ar-gate-s">clear</span>
    </li>
    <li class="ar-gate is-clear">
      <span class="ar-gate-n">fuelInvented</span
      ><span class="ar-gate-p">a heating fuel nobody named</span><span class="ar-gate-c">0</span
      ><span class="ar-gate-s">clear</span>
    </li>
    <li class="ar-gate is-clear">
      <span class="ar-gate-n">hallucinatedPass</span
      ><span class="ar-gate-p">a safety check marked passed without being discussed</span
      ><span class="ar-gate-c">0</span><span class="ar-gate-s">clear</span>
    </li>
    <li class="ar-gate is-clear">
      <span class="ar-gate-n">rvalueConversion</span
      ><span class="ar-gate-p">insulation depth converted to the wrong unit</span
      ><span class="ar-gate-c">0</span><span class="ar-gate-s">clear</span>
    </li>
    <li class="ar-gate is-clear">
      <span class="ar-gate-n">enumWrongMember</span
      ><span class="ar-gate-p">a fixed-choice field given the wrong option</span
      ><span class="ar-gate-c">0</span><span class="ar-gate-s">clear</span>
    </li>
    <li class="ar-gate is-clear">
      <span class="ar-gate-n">enumInvalid</span
      ><span class="ar-gate-p">a fixed-choice field given an option that doesn&rsquo;t exist</span
      ><span class="ar-gate-c">0</span><span class="ar-gate-s">clear</span>
    </li>
    <li class="ar-gate is-clear">
      <span class="ar-gate-n">spanFabricated</span
      ><span class="ar-gate-p">a quote cited that isn&rsquo;t in the transcript</span
      ><span class="ar-gate-c">0</span><span class="ar-gate-s">clear</span>
    </li>
    <li class="ar-gate is-clear">
      <span class="ar-gate-n">spanMissing</span
      ><span class="ar-gate-p">a value given with no quote to back it</span
      ><span class="ar-gate-c">0</span><span class="ar-gate-s">clear</span>
    </li>
  </ul>

  <h2 class="ar-h">Did the output parse</h2>
  <ul class="ar-shape">
    <li>
      <span class="ar-shape-n">Valid form on the first attempt</span
      ><span class="ar-shape-c">14</span>
    </li>
    <li>
      <span class="ar-shape-n">Needed a retry</span><span class="ar-shape-c ar-is-zero">0</span>
    </li>
    <li>
      <span class="ar-shape-n">Never produced a valid form</span
      ><span class="ar-shape-c ar-is-zero">0</span>
    </li>
  </ul>
  <p class="ar-sub">
    All 14 responses were well-formed on the first try, so nothing below was measured on a repaired
    output.
  </p>
</section>
```

Tripped variant and the `n/a` backend variant: unchanged from v1 §6.3.

### 5.5 Legend

As v1 §6.4, with plain names leading and verdict IDs demoted:

```html
<section class="ar-legend" aria-label="How to read the grid">
  <h2 class="ar-h">How to read the grid</h2>
  <p class="ar-sub">
    One square per slot: 51 fields down, 14 transcripts across. Most squares are empty, and that is
    the design &mdash; the commonest outcome draws nothing, so the marks you can see are the ones
    worth looking at.
  </p>

  <dl class="ar-legend-list">
    <div class="ar-legend-row">
      <dt><span class="ar-c ar-absent" aria-hidden="true"></span></dt>
      <dd>
        <b>Nothing to find</b> <span class="ar-n">523 slots</span>
        <span class="ar-legend-note"
          >Never mentioned, correctly left blank. Drawn as nothing, so an extractor that returned an
          empty form would show up as an empty grid instead of a page of confirmation.</span
        >
        <span class="ar-legend-v">correct-null</span>
      </dd>
    </div>

    <div class="ar-legend-row">
      <dt><span class="ar-c ar-captured" aria-hidden="true"></span></dt>
      <dd>
        <b>Found it</b> <span class="ar-n">168 slots</span>
        <span class="ar-legend-note"
          >Stated and captured correctly. How much ink you see is how much the model actually picked
          up.</span
        >
        <span class="ar-legend-v">correct</span>
      </dd>
    </div>

    <div class="ar-legend-row">
      <dt><span class="ar-c ar-excused" aria-hidden="true"></span></dt>
      <dd>
        <b>Not counted</b> <span class="ar-n">5 slots</span>
        <span class="ar-legend-note"
          >The recording is too unclear to say what the right answer was, so these are excluded from
          the rates. Shown anyway, with a reason each, so the exclusions can be checked.</span
        >
        <span class="ar-legend-v">miss-excused &middot; sanctioned &middot; unscorable</span>
      </dd>
    </div>

    <div class="ar-legend-row">
      <dt><span class="ar-c ar-short" aria-hidden="true"></span></dt>
      <dd>
        <b>Missed it</b> <span class="ar-n">13 slots</span>
        <span class="ar-legend-note"
          >Said in the recording, left blank on the form. 12 of the 13 are health-and-safety fields
          in one transcript.</span
        >
        <span class="ar-legend-v">miss &middot; health-miss &middot; health-clean-dropped</span>
      </dd>
    </div>

    <div class="ar-legend-row">
      <dt><span class="ar-c ar-fault" aria-hidden="true"></span></dt>
      <dd>
        <b>Made it up</b> <span class="ar-n">5 slots</span>
        <span class="ar-legend-note"
          >Something on the form that the recording doesn&rsquo;t support &mdash; invented, or
          different from what was said.</span
        >
        <span class="ar-legend-v"
          >hallucination &middot; hallucination-soft &middot; wrong &middot; health-wrong &middot;
          health-hallucinated-pass &middot; health-hallucinated-problem</span
        >
      </dd>
    </div>
  </dl>
  <p class="ar-sub">
    Colour is never the only difference: empty, solid, dotted ring, striped, crossed. The page reads
    the same in greyscale and in print.
  </p>
</section>
```

### 5.6 Grid — filter, field, inspector

Field names are given plain-English first. Leaf paths, transcript names beyond
`11-ambiguous-attic`, and per-cell strings are illustrative — substitute the run manifest's
real values; counts, verdicts and totals are real.

```html
<section aria-labelledby="coverage-h">
  <h2 class="ar-h" id="coverage-h">Every slot</h2>
  <p class="ar-sub">
    Rows are in form order and never re-sorted, so any two runs of this page can be compared square
    for square.
  </p>

  <fieldset class="ar-filter">
    <legend class="ar-sr">Which slots to show</legend>
    <input class="ar-sr ar-filter-in" type="radio" name="ar-view" id="ar-view-all" checked />
    <label class="ar-filter-opt" for="ar-view-all">All 714</label>
    <input class="ar-sr ar-filter-in" type="radio" name="ar-view" id="ar-view-flag" />
    <label class="ar-filter-opt" for="ar-view-flag">Only the 23 worth reading</label>
  </fieldset>

  <div class="ar-scroll" tabindex="0" role="group" aria-label="Slot grid, scrollable sideways">
    <table class="ar-grid" id="ar-grid">
      <caption class="ar-sr">
        Outcome for each of 51 form fields on each of 14 transcripts. Empty squares are
        &ldquo;nothing to find&rdquo;. Per-row totals are in the two right-hand columns; the
        Problems section lists every non-empty outcome in full.
      </caption>

      <thead>
        <tr>
          <th class="ar-corner" scope="col">Form field</th>
          <th class="ar-ch" scope="col"><span>01</span></th>
          <th class="ar-ch" scope="col"><span>02</span></th>
          <th class="ar-ch" scope="col"><span>03</span></th>
          <th class="ar-ch" scope="col"><span>04</span></th>
          <th class="ar-ch" scope="col"><span>05</span></th>
          <th class="ar-ch" scope="col"><span>06</span></th>
          <th class="ar-ch" scope="col"><span>07</span></th>
          <th class="ar-ch" scope="col"><span>08</span></th>
          <th class="ar-ch" scope="col"><span>09</span></th>
          <th class="ar-ch" scope="col"><span>10</span></th>
          <th class="ar-ch ar-ch-hot" scope="col" title="11-ambiguous-attic"><span>11</span></th>
          <th class="ar-ch" scope="col"><span>12</span></th>
          <th class="ar-ch" scope="col"><span>13</span></th>
          <th class="ar-ch" scope="col"><span>14</span></th>
          <th class="ar-mh" scope="col">found</th>
          <th class="ar-mh" scope="col">flags</th>
        </tr>
      </thead>

      <tbody class="ar-group">
        <tr>
          <th class="ar-gh" colspan="17" scope="colgroup">Building shell</th>
        </tr>

        <tr class="ar-row ar-row-flag">
          <th class="ar-rh" scope="row">
            <span class="ar-rh-en">Attic insulation R-value</span>
            <code class="ar-rh-id">envelope.attic.rValue</code>
          </th>
          <td class="ar-c ar-captured"><span class="ar-sr">found it</span></td>
          <td class="ar-c ar-captured"><span class="ar-sr">found it</span></td>
          <td class="ar-c ar-absent"></td>
          <td class="ar-c ar-captured"><span class="ar-sr">found it</span></td>
          <td class="ar-c ar-absent"></td>
          <td class="ar-c ar-captured"><span class="ar-sr">found it</span></td>
          <td class="ar-c ar-fault">
            <a href="#p-04" data-ar-p="p-04"><span class="ar-sr">made it up &mdash; wrong</span></a>
          </td>
          <td class="ar-c ar-captured"><span class="ar-sr">found it</span></td>
          <td class="ar-c ar-absent"></td>
          <td class="ar-c ar-captured"><span class="ar-sr">found it</span></td>
          <td class="ar-c ar-absent"></td>
          <td class="ar-c ar-captured"><span class="ar-sr">found it</span></td>
          <td class="ar-c ar-absent"></td>
          <td class="ar-c ar-captured"><span class="ar-sr">found it</span></td>
          <td class="ar-m">8</td>
          <td class="ar-m ar-m-hot">1</td>
        </tr>

        <tr class="ar-row">
          <th class="ar-rh" scope="row">
            <span class="ar-rh-en">Attic insulation material</span>
            <code class="ar-rh-id">envelope.attic.insulationType</code>
          </th>
          <td class="ar-c ar-captured"><span class="ar-sr">found it</span></td>
          <td class="ar-c ar-absent"></td>
          <td class="ar-c ar-absent"></td>
          <td class="ar-c ar-captured"><span class="ar-sr">found it</span></td>
          <td class="ar-c ar-absent"></td>
          <td class="ar-c ar-captured"><span class="ar-sr">found it</span></td>
          <td class="ar-c ar-absent"></td>
          <td class="ar-c ar-captured"><span class="ar-sr">found it</span></td>
          <td class="ar-c ar-absent"></td>
          <td class="ar-c ar-absent"></td>
          <td class="ar-c ar-absent"></td>
          <td class="ar-c ar-captured"><span class="ar-sr">found it</span></td>
          <td class="ar-c ar-absent"></td>
          <td class="ar-c ar-absent"></td>
          <td class="ar-m">5</td>
          <td class="ar-m">&middot;</td>
        </tr>

        <tr class="ar-row">
          <th class="ar-rh" scope="row">
            <span class="ar-rh-en">Blower-door leakage, CFM50</span>
            <code class="ar-rh-id">envelope.blowerDoor.cfm50</code>
          </th>
          <td class="ar-c ar-absent"></td>
          <td class="ar-c ar-absent"></td>
          <td class="ar-c ar-absent"></td>
          <td class="ar-c ar-absent"></td>
          <td class="ar-c ar-absent"></td>
          <td class="ar-c ar-absent"></td>
          <td class="ar-c ar-absent"></td>
          <td class="ar-c ar-absent"></td>
          <td class="ar-c ar-absent"></td>
          <td class="ar-c ar-absent"></td>
          <td class="ar-c ar-absent"></td>
          <td class="ar-c ar-absent"></td>
          <td class="ar-c ar-absent"></td>
          <td class="ar-c ar-absent"></td>
          <td class="ar-m ar-m-none" title="never mentioned in any transcript">&mdash;</td>
          <td class="ar-m">&middot;</td>
        </tr>
      </tbody>

      <tbody class="ar-group">
        <tr>
          <th class="ar-gh" colspan="17" scope="colgroup">Health and safety</th>
        </tr>

        <tr class="ar-row ar-row-flag">
          <th class="ar-rh" scope="row">
            <span class="ar-rh-en">Combustion spillage observed</span>
            <code class="ar-rh-id">health.combustion.spillage</code>
          </th>
          <td class="ar-c ar-absent"></td>
          <td class="ar-c ar-absent"></td>
          <td class="ar-c ar-absent"></td>
          <td class="ar-c ar-absent"></td>
          <td class="ar-c ar-captured"><span class="ar-sr">found it</span></td>
          <td class="ar-c ar-absent"></td>
          <td class="ar-c ar-absent"></td>
          <td class="ar-c ar-absent"></td>
          <td class="ar-c ar-absent"></td>
          <td class="ar-c ar-captured"><span class="ar-sr">found it</span></td>
          <td class="ar-c ar-short">
            <a href="#p-06" data-ar-p="p-06"
              ><span class="ar-sr">missed it &mdash; health-miss</span></a
            >
          </td>
          <td class="ar-c ar-absent"></td>
          <td class="ar-c ar-absent"></td>
          <td class="ar-c ar-absent"></td>
          <td class="ar-m">2</td>
          <td class="ar-m ar-m-hot">1</td>
        </tr>

        <tr class="ar-row ar-row-flag">
          <th class="ar-rh" scope="row">
            <span class="ar-rh-en">Carbon monoxide reading, ppm</span>
            <code class="ar-rh-id">health.co.readingPpm</code>
          </th>
          <td class="ar-c ar-absent"></td>
          <td class="ar-c ar-captured"><span class="ar-sr">found it</span></td>
          <td class="ar-c ar-absent"></td>
          <td class="ar-c ar-absent"></td>
          <td class="ar-c ar-absent"></td>
          <td class="ar-c ar-absent"></td>
          <td class="ar-c ar-absent"></td>
          <td class="ar-c ar-absent"></td>
          <td class="ar-c ar-absent"></td>
          <td class="ar-c ar-absent"></td>
          <td class="ar-c ar-short">
            <a href="#p-07" data-ar-p="p-07"
              ><span class="ar-sr">missed it &mdash; health-miss</span></a
            >
          </td>
          <td class="ar-c ar-absent"></td>
          <td class="ar-c ar-absent"></td>
          <td class="ar-c ar-absent"></td>
          <td class="ar-m">1</td>
          <td class="ar-m ar-m-hot">1</td>
        </tr>
      </tbody>

      <tfoot>
        <tr>
          <th class="ar-rh ar-foot" scope="row">flags per transcript</th>
          <td class="ar-m">&middot;</td>
          <td class="ar-m">&middot;</td>
          <td class="ar-m">2</td>
          <td class="ar-m">&middot;</td>
          <td class="ar-m">1</td>
          <td class="ar-m">&middot;</td>
          <td class="ar-m">2</td>
          <td class="ar-m">&middot;</td>
          <td class="ar-m">2</td>
          <td class="ar-m">&middot;</td>
          <td class="ar-m ar-m-hot">13</td>
          <td class="ar-m">2</td>
          <td class="ar-m">1</td>
          <td class="ar-m">&middot;</td>
          <td class="ar-m"></td>
          <td class="ar-m">23</td>
        </tr>
      </tfoot>
    </table>
  </div>

  <div class="ar-inspect" id="ar-inspect" hidden>
    <div class="ar-inspect-head">
      <p class="ar-inspect-t" id="ar-inspect-t"></p>
      <button class="ar-inspect-x" type="button" data-ar-close>Close</button>
    </div>
    <div class="ar-inspect-body" id="ar-inspect-body" aria-live="polite"></div>
  </div>

  <p class="ar-sub ar-inspect-hint">
    Marked squares open their full detail below the grid. Without JavaScript they jump to the same
    detail in <a href="#problems">Problems</a>.
  </p>
</section>
```

**Emit rule for the remaining rows** — one `<tbody class="ar-group">` per form section, one
`<tr class="ar-row">` per field, `ar-row-flag` added when the row contains any non-`correct`,
non-`correct-null` cell (this class is what the CSS filter keys on), 14 `<td>`, then `found`
and `flags`:

| Verdict                                       | Cell                                                                                                                           |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `correct-null`                                | `<td class="ar-c ar-absent"></td>`                                                                                             |
| `correct`                                     | `<td class="ar-c ar-captured"><span class="ar-sr">found it</span></td>`                                                        |
| `miss-excused`, `sanctioned`, `unscorable`    | `<td class="ar-c ar-excused"><a href="#p-NN" data-ar-p="p-NN"><span class="ar-sr">not counted &mdash; VERDICT</span></a></td>` |
| `miss`, `health-miss`, `health-clean-dropped` | `<td class="ar-c ar-short"><a href="#p-NN" data-ar-p="p-NN"><span class="ar-sr">missed it &mdash; VERDICT</span></a></td>`     |
| the six made-up verdicts                      | `<td class="ar-c ar-fault"><a href="#p-NN" data-ar-p="p-NN"><span class="ar-sr">made it up &mdash; VERDICT</span></a></td>`    |

`found` = count of `correct` in the row, or `&mdash;` + `.ar-m-none` when zero.
`flags` = count of the other three buckets, `&middot;` when zero, `.ar-m-hot` when ≥1.

**Screen readers:** the 523 empty cells carry no text, on purpose — 714 announcements is not
access. The caption states the convention, the row margins give per-row totals, the row
header is the plain-English field name, and Problems is a complete non-visual path to every
non-trivial slot.

### 5.7 Problems — 23 entries

Structure unchanged from v1 §6.6 with plain-English titles added. Order: made it up (5) →
missed it (13) → not counted (5). Each `<details id="p-NN">` contains an `.ar-p-body` — which
is exactly what the inspector clones, so there is one copy of every string in the DOM.

```html
<section id="problems" aria-labelledby="problems-h">
  <h2 class="ar-h" id="problems-h">Problems &mdash; all 23</h2>
  <p class="ar-sub">
    Every slot that was not either &ldquo;found it&rdquo; or &ldquo;nothing to find&rdquo;, in full,
    with the transcript wording. Nothing is summarised away.
  </p>

  <h3 class="ar-bh ar-bh-fault">Made it up &mdash; 5</h3>

  <details class="ar-p ar-p-fault" id="p-01">
    <summary>
      <span class="ar-p-v">hallucination</span>
      <span class="ar-p-leaf">Furnace age, years</span>
      <span class="ar-p-t">05-ranch-1962</span>
    </summary>
    <dl class="ar-p-body">
      <dt>Correct answer</dt>
      <dd class="ar-p-null">blank &mdash; never discussed</dd>
      <dt>Model wrote</dt>
      <dd><code>18</code></dd>
      <dt>Quote given</dt>
      <dd class="ar-p-null">none</dd>
      <dt>Quote problem</dt>
      <dd>invented value, no supporting quote offered</dd>
      <dt>What happened</dt>
      <dd>
        The transcript calls it only &ldquo;the old one downstairs&rdquo;. An age was supplied
        anyway.
      </dd>
      <dt>Field</dt>
      <dd><code>hvac.heating.ageYears</code></dd>
    </dl>
  </details>

  <details class="ar-p ar-p-fault" id="p-02">
    <summary>
      <span class="ar-p-v">hallucination</span>
      <span class="ar-p-leaf">Water heater capacity, gallons</span>
      <span class="ar-p-t">09-split-level</span>
    </summary>
    <dl class="ar-p-body">
      <dt>Correct answer</dt>
      <dd class="ar-p-null">blank &mdash; never discussed</dd>
      <dt>Model wrote</dt>
      <dd><code>50</code></dd>
      <dt>Quote given</dt>
      <dd class="ar-p-null">none</dd>
      <dt>Quote problem</dt>
      <dd>invented value, no supporting quote offered</dd>
      <dt>What happened</dt>
      <dd>A common default filled in where capacity never came up.</dd>
      <dt>Field</dt>
      <dd><code>dhw.tank.gallons</code></dd>
    </dl>
  </details>

  <details class="ar-p ar-p-fault" id="p-03">
    <summary>
      <span class="ar-p-v">hallucination-soft</span>
      <span class="ar-p-leaf">Window glazing</span>
      <span class="ar-p-t">11-ambiguous-attic</span>
    </summary>
    <dl class="ar-p-body">
      <dt>Correct answer</dt>
      <dd class="ar-p-null">blank &mdash; never discussed</dd>
      <dt>Model wrote</dt>
      <dd><code>double</code></dd>
      <dt>Quote given</dt>
      <dd><q>the windows are pretty tired</q></dd>
      <dt>Quote problem</dt>
      <dd>the quote is real but does not support the value</dd>
      <dt>What happened</dt>
      <dd>
        Glazing inferred from a remark about condition. Marked &ldquo;soft&rdquo; because a real
        quote was cited &mdash; but it is still a value nobody stated, and it counts the same way.
      </dd>
      <dt>Field</dt>
      <dd><code>envelope.windows.glazing</code></dd>
    </dl>
  </details>

  <details class="ar-p ar-p-fault" id="p-04">
    <summary>
      <span class="ar-p-v">wrong</span>
      <span class="ar-p-leaf">Attic insulation R-value</span>
      <span class="ar-p-t">07-cape-cod</span>
    </summary>
    <dl class="ar-p-body">
      <dt>Correct answer</dt>
      <dd><code>38</code></dd>
      <dt>Model wrote</dt>
      <dd><code>30</code></dd>
      <dt>Quote given</dt>
      <dd><q>about twelve inches of blown cellulose up there</q></dd>
      <dt>Quote problem</dt>
      <dd class="ar-p-null">none &mdash; the right quote</dd>
      <dt>What happened</dt>
      <dd>
        Right quote, wrong arithmetic converting depth to R-value. The
        <code>rvalueConversion</code> stop-check did not fire: it catches wrong <em>units</em>, not
        wrong maths inside the right unit. Worth fixing in that check.
      </dd>
      <dt>Field</dt>
      <dd><code>envelope.attic.rValue</code></dd>
    </dl>
  </details>

  <details class="ar-p ar-p-fault" id="p-05">
    <summary>
      <span class="ar-p-v">wrong</span>
      <span class="ar-p-leaf">Cooling equipment type</span>
      <span class="ar-p-t">13-townhouse</span>
    </summary>
    <dl class="ar-p-body">
      <dt>Correct answer</dt>
      <dd><code>heat-pump</code></dd>
      <dt>Model wrote</dt>
      <dd><code>central-ac</code></dd>
      <dt>Quote given</dt>
      <dd><q>same unit does the heating too, in the shoulder months</q></dd>
      <dt>Quote problem</dt>
      <dd class="ar-p-null">none &mdash; the right quote</dd>
      <dt>What happened</dt>
      <dd>
        Both answers are on the allowed list, so neither fixed-choice stop-check fired. This is why
        94/94 on fixed choices is not the same as 94/94 correct: a valid option can still be the
        wrong one.
      </dd>
      <dt>Field</dt>
      <dd><code>hvac.cooling.type</code></dd>
    </dl>
  </details>

  <h3 class="ar-bh ar-bh-short">Missed it &mdash; 13</h3>
  <p class="ar-sub">
    Twelve of these are health-and-safety fields in <code>11-ambiguous-attic</code>, and they are
    counted separately from the headline miss rate so that a safety failure cannot be averaged away
    against 700 ordinary slots.
  </p>

  <details class="ar-p ar-p-short" id="p-06">
    <summary>
      <span class="ar-p-v">health-miss</span>
      <span class="ar-p-leaf">Combustion spillage observed</span>
      <span class="ar-p-t">11-ambiguous-attic</span>
    </summary>
    <dl class="ar-p-body">
      <dt>Correct answer</dt>
      <dd><code>observed</code></dd>
      <dt>Model wrote</dt>
      <dd class="ar-p-null">blank</dd>
      <dt>Quote given</dt>
      <dd><q>you could feel it rolling back out at the draft hood</q></dd>
      <dt>Quote problem</dt>
      <dd>quote found, value not extracted from it</dd>
      <dt>What happened</dt>
      <dd>
        Backdrafting described in plain language rather than the form&rsquo;s term. The auditor is
        mid-sentence about attic access when he says it.
      </dd>
      <dt>Field</dt>
      <dd><code>health.combustion.spillage</code></dd>
    </dl>
  </details>
</section>
```

Entries `p-07` … `p-17` are the remaining eleven `health-miss`, all in
`11-ambiguous-attic`: CO reading, moisture observed, asbestos suspected, knob-and-tube
present, gas leak observed, flue condition, CAZ depressurisation, dryer venting, ambient CO,
appliance venting, smoke-alarm presence. Then `p-18` is the single ordinary `miss`:

```html
  <details class="ar-p ar-p-short" id="p-18">
    <summary>
      <span class="ar-p-v">miss</span>
      <span class="ar-p-leaf">Water heater fuel</span>
      <span class="ar-p-t">12-farmhouse</span>
    </summary>
    <dl class="ar-p-body">
      <dt>Correct answer</dt><dd><code>propane</code></dd>
      <dt>Model wrote</dt><dd class="ar-p-null">blank</dd>
      <dt>Quote given</dt><dd><q>the water heater runs off the tank out back</q></dd>
      <dt>Quote problem</dt><dd>quote found, value not extracted from it</dd>
      <dt>What happened</dt><dd>Fuel implied, not named. <code>fuelDropped</code> did not fire
        because that check only counts fuels dropped from an explicit statement.</dd>
      <dt>Field</dt><dd><code>dhw.fuel</code></dd>
    </dl>
  </details>

  <h3 class="ar-bh ar-bh-exc">Not counted &mdash; 5</h3>
  <p class="ar-sub">Excluded from every rate above. Each one says why, because an unexplained
  exclusion is indistinguishable from a hidden failure.</p>

  <details class="ar-p ar-p-exc" id="p-19">
    <summary>
      <span class="ar-p-v">miss-excused</span>
      <span class="ar-p-leaf">Rim joist R-value</span>
      <span class="ar-p-t">03-bungalow</span>
    </summary>
    <dl class="ar-p-body">
      <dt>Correct answer</dt><dd><code>10</code>, but see below</dd>
      <dt>Model wrote</dt><dd class="ar-p-null">blank</dd>
      <dt>Quote given</dt><dd><q>[inaudible] the rim, maybe an inch of foam</q></dd>
      <dt>Quote problem</dt><dd>quote cut off by a transcription gap</dd>
      <dt>Why not counted</dt><dd>The audio does not support a definite right answer, so
        scoring this either way would be scoring the transcription, not the model. Removed
        from the miss-rate denominator.</dd>
      <dt>Field</dt><dd><code>envelope.rimJoist.rValue</code></dd>
    </dl>
  </details>
</section>
```

`p-20` … `p-23`: three more `miss-excused` and the single `sanctioned`, same shape, each with
a **Why not counted** row.

### 5.8 Method and limits

```html
<section class="ar-method" aria-labelledby="method-h">
  <h2 class="ar-h" id="method-h">How these numbers were worked out</h2>
  <dl class="ar-method-list">
    <dt>Made-up rate</dt>
    <dd>3 &divide; 398. The 398 is every slot whose correct answer was blank. The 3 are the
      inventions among them. The 2 contradictions are not in this rate &mdash; they had a
      stated answer, so they belong to a different denominator; all 5 are in Problems.</dd>
    <dt>Miss rate</dt>
    <dd>1 &divide; 130. The 130 is every non-health slot with something to find, after
      removing the 5 not-counted slots. The 12 health misses are reported on their own and
      never folded in, by design.</dd>
    <dt>Fixed-choice accuracy</dt>
    <dd>94 &divide; 94: fixed-choice slots with a stated answer, where the model picked the
      right member of the list.</dd>
    <dt>Why the stop-checks can pass while a rate is non-zero</dt>
    <dd>The checks test named failure mechanisms; the rates count outcomes.
      <a href="#p-04">p-04</a> and <a href="#p-18">p-18</a> are both real cases in this run,
      and both are arguments for widening a check.</dd>
    <dt>What this does not tell you</dt>
    <dd>14 transcripts, all from one region and one auditor&rsquo;s vocabulary. These are
      measurements of this corpus. They are a floor observed under these conditions &mdash;
      not a bound, not a forecast, and not a threshold anyone has agreed to.</dd>
  </dl>
</section>
</div><!-- /.ar -->
```

---

## 6. CSS

Leak rules unchanged from v1 §7.1 and still binding: every selector starts with `.ar`; any
selector competing with `.vp-doc` includes the element name so it outranks `.vp-doc table`
(0-1-1) regardless of load order; no `!important`; all custom properties `--ar-`-prefixed;
no `@font-face`, no `url()`, no `@import`.

```css
/* ---- tokens ------------------------------------------------------------- */
:root {
  --ar-bg: var(--vp-c-bg);
  --ar-text: var(--vp-c-text-1);
  --ar-text-2: var(--vp-c-text-2);
  --ar-rule: var(--vp-c-divider);
  --ar-brand: var(--vp-c-brand-1);

  --ar-fault-fill: var(--vp-c-red-soft);
  --ar-fault-ink: var(--vp-c-red-1);
  --ar-fault-edge: var(--vp-c-red-2);
  --ar-short-fill: var(--vp-c-yellow-soft);
  --ar-short-ink: var(--vp-c-yellow-1);
  --ar-short-edge: var(--vp-c-yellow-2);

  --ar-ink: #3c4148;
  --ar-ink-soft: #6a7076;

  --ar-grid-line: color-mix(in srgb, var(--vp-c-divider) 60%, transparent);
  --ar-zero: color-mix(in srgb, var(--vp-c-text-3) 55%, transparent);

  --ar-cell: 20px;
  --ar-label: 17rem;
}
html.dark {
  --ar-ink: #c3c8ce;
  --ar-ink-soft: #8b9198;
}

/* ---- root & guards ------------------------------------------------------ */
.ar {
  max-width: 100%;
  color: var(--ar-text);
  font-variant-numeric: tabular-nums;
}
.ar * {
  min-width: 0;
}
.ar .ar-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}
.ar .ar-h {
  font-size: 1.05rem;
  font-weight: 600;
  margin: 2.75rem 0 0.25rem;
  letter-spacing: 0.01em;
}
.ar .ar-sub {
  font-size: 0.8125rem;
  color: var(--ar-text-2);
  margin: 0.25rem 0 1rem;
  max-width: 62ch;
  text-wrap: pretty;
}
.ar .ar-n {
  color: var(--ar-text-2);
  font-size: 0.8125rem;
}
.ar .ar-dfn {
  font-style: normal;
  font-weight: 600;
  color: var(--ar-text);
}
.ar a {
  color: var(--ar-brand);
  text-decoration: none;
}
.ar a:hover {
  text-decoration: underline;
}
.ar a:focus-visible,
.ar button:focus-visible,
.ar .ar-filter-in:focus-visible + .ar-filter-opt {
  outline: 2px solid var(--ar-brand);
  outline-offset: 2px;
  border-radius: 2px;
}

/* ---- 1 intro ------------------------------------------------------------ */
.ar .ar-intro {
  border-top: 2px solid var(--ar-text);
  padding-top: 0.875rem;
}
.ar .ar-kicker {
  font-size: 0.6875rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--ar-text-2);
  margin: 0;
}
.ar .ar-title {
  font-size: 1.75rem;
  font-weight: 600;
  line-height: 1.15;
  letter-spacing: -0.02em;
  margin: 0.25rem 0 0;
  max-width: 34ch;
}
.ar .ar-lede {
  font-size: 0.9375rem;
  line-height: 1.55;
  margin: 0.75rem 0 0;
  max-width: 62ch;
  text-wrap: pretty;
}

/* ---- 2 worked example --------------------------------------------------- */
.ar .ar-eg-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: grid;
  gap: 1px;
  background: var(--ar-rule);
  border: 1px solid var(--ar-rule);
}
.ar .ar-eg {
  background: var(--ar-bg);
  padding: 0.75rem 0.875rem;
  display: grid;
  gap: 0.3125rem;
}
.ar .ar-eg p {
  margin: 0;
  font-size: 0.8125rem;
}
.ar .ar-eg-lbl {
  display: inline-block;
  min-width: 8.5rem;
  font-size: 0.6875rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ar-text-2);
}
.ar .ar-eg-said q {
  color: var(--ar-text);
}
.ar .ar-eg-field {
  font-weight: 600;
  margin-right: 0.375rem;
}
.ar .ar-eg-note {
  color: var(--ar-text-2);
  font-style: italic;
}
.ar .ar-eg-verdict {
  border-top: 1px dotted var(--ar-rule);
  padding-top: 0.375rem;
  color: var(--ar-text-2);
}
.ar .ar-eg-verdict b {
  color: var(--ar-text);
}
.ar .ar-eg-swatch {
  display: inline-block;
  vertical-align: -0.2em;
  margin-right: 0.375rem;
  border: 1px solid var(--ar-grid-line);
}

/* ---- 3 finding --------------------------------------------------------- */
.ar .ar-claims {
  list-style: none;
  padding: 0;
  margin: 0;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(19rem, 1fr));
  gap: 1.25rem;
}
.ar .ar-claim {
  padding-left: 0.875rem;
  border-left: 3px solid var(--ar-rule);
}
.ar .ar-claim-fault {
  border-left-color: var(--ar-fault-ink);
}
.ar .ar-claim-short {
  border-left-color: var(--ar-short-ink);
}
.ar .ar-claim-n {
  font-size: 2.75rem;
  line-height: 1;
  font-weight: 500;
  letter-spacing: -0.03em;
  margin: 0;
}
.ar .ar-claim-t {
  font-size: 1rem;
  line-height: 1.35;
  margin: 0.25rem 0 0;
  max-width: 30ch;
  text-wrap: pretty;
}
.ar .ar-claim-d {
  font-size: 0.8125rem;
  color: var(--ar-text-2);
  margin: 0.4375rem 0 0;
  max-width: 44ch;
  text-wrap: pretty;
}
.ar .ar-caveat {
  margin: 1.25rem 0 0;
  padding-left: 0.75rem;
  border-left: 1px solid var(--ar-rule);
  font-size: 0.8125rem;
  color: var(--ar-text-2);
  max-width: 64ch;
  text-wrap: pretty;
}
.ar .ar-meta {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.125rem 0.75rem;
  margin: 1.25rem 0 0;
  font-size: 0.75rem;
}
.ar .ar-meta dt {
  color: var(--ar-text-2);
}
.ar .ar-meta dd {
  margin: 0;
}

/* ---- 4 rates ----------------------------------------------------------- */
.ar .ar-rates {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
  gap: 1px;
  background: var(--ar-rule);
  border: 1px solid var(--ar-rule);
}
.ar .ar-card {
  background: var(--ar-bg);
  padding: 0.875rem 1rem 1rem;
}
.ar .ar-card .ar-k {
  font-size: 0.6875rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--ar-text-2);
  margin: 0;
}
.ar .ar-v {
  font-size: 2.25rem;
  line-height: 1.05;
  font-weight: 500;
  margin: 0.25rem 0 0;
  letter-spacing: -0.02em;
}
.ar .ar-v .ar-u {
  font-size: 1rem;
  font-weight: 400;
  color: var(--ar-text-2);
  margin-left: 0.0625rem;
}
.ar .ar-d {
  font-size: 0.75rem;
  color: var(--ar-text-2);
  margin: 0.1875rem 0 0;
}
.ar .ar-def {
  font-size: 0.75rem;
  line-height: 1.45;
  color: var(--ar-text-2);
  margin: 0.5rem 0 0;
  text-wrap: pretty;
}

/* history line — the v1 sparkline is gone below n=3 */
.ar .ar-hist {
  font-size: 0.6875rem;
  color: var(--ar-text-2);
  margin: 0.75rem 0 0;
  padding-top: 0.4375rem;
  border-top: 1px solid var(--ar-rule);
}
.ar .ar-hist-none {
  font-style: italic;
}
.ar .ar-spark {
  display: block;
  overflow: visible;
  color: var(--ar-text-2);
  margin: 0.5rem 0 0.1875rem;
}
.ar .ar-spark-base {
  stroke: var(--ar-rule);
  stroke-width: 1;
  stroke-dasharray: 2 3;
}
.ar .ar-spark-line {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.25;
  stroke-linejoin: round;
  stroke-linecap: round;
}
.ar .ar-spark-dot {
  fill: currentColor;
}
.ar .ar-spark-dot-past {
  fill: var(--ar-rule);
}

/* ---- 5 gates ----------------------------------------------------------- */
.ar .ar-gate-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(20rem, 1fr));
  gap: 1px;
  background: var(--ar-rule);
  border: 1px solid var(--ar-rule);
}
.ar .ar-gate {
  background: var(--ar-bg);
  display: grid;
  grid-template-columns: 1fr auto auto;
  align-items: baseline;
  column-gap: 0.625rem;
  padding: 0.4375rem 0.625rem 0.4375rem 0.875rem;
  font-size: 0.8125rem;
}
.ar .ar-gate-n {
  font-family: var(--vp-font-family-mono, ui-monospace, monospace);
  font-size: 0.6875rem;
}
.ar .ar-gate-p {
  grid-column: 1;
  font-size: 0.75rem;
  color: var(--ar-text-2);
  text-wrap: pretty;
}
.ar .ar-gate-c {
  grid-row: 1;
  font-weight: 600;
}
.ar .ar-gate-s {
  grid-row: 1;
  font-size: 0.6875rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.ar .ar-gate.is-clear {
  box-shadow: inset 0.1875rem 0 0 var(--ar-rule);
}
.ar .ar-gate.is-clear .ar-gate-c {
  color: var(--ar-zero);
  font-weight: 400;
}
.ar .ar-gate.is-clear .ar-gate-s {
  color: var(--ar-text-2);
}
.ar .ar-gate.is-tripped {
  background: var(--ar-fault-fill);
  box-shadow: inset 0.1875rem 0 0 var(--ar-fault-ink);
}
.ar .ar-gate.is-tripped .ar-gate-c,
.ar .ar-gate.is-tripped .ar-gate-s {
  color: var(--ar-fault-ink);
  font-weight: 700;
}
.ar .ar-shape {
  list-style: none;
  padding: 0;
  margin: 0;
  max-width: 26rem;
}
.ar .ar-shape li {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.3125rem 0;
  border-bottom: 1px solid var(--ar-rule);
  font-size: 0.8125rem;
}
.ar .ar-shape-c {
  font-weight: 600;
}
.ar .ar-shape .ar-is-zero {
  color: var(--ar-zero);
  font-weight: 400;
}
.ar .ar-shape .ar-na .ar-shape-c {
  color: var(--ar-text-2);
  font-style: italic;
  font-weight: 400;
}

/* ---- 6 legend ---------------------------------------------------------- */
.ar .ar-legend-list {
  margin: 0;
}
.ar .ar-legend-row {
  display: grid;
  grid-template-columns: var(--ar-cell) 1fr;
  gap: 0.75rem;
  padding: 0.5rem 0;
  border-top: 1px solid var(--ar-rule);
}
.ar .ar-legend-row dt {
  padding-top: 0.1875rem;
}
.ar .ar-legend-row dd {
  margin: 0;
  font-size: 0.8125rem;
  display: grid;
  gap: 0.1875rem;
}
.ar .ar-legend-row dt .ar-c {
  display: block;
  border: 1px solid var(--ar-grid-line);
}
.ar .ar-legend-note {
  color: var(--ar-text-2);
  max-width: 58ch;
  text-wrap: pretty;
}
.ar .ar-legend-v {
  font-family: var(--vp-font-family-mono, ui-monospace, monospace);
  font-size: 0.625rem;
  color: var(--ar-text-2);
}

/* ---- 7 filter (CSS only) ----------------------------------------------- */
.ar .ar-filter {
  border: 0;
  padding: 0;
  margin: 0 0 0.625rem;
  display: flex;
  gap: 0.375rem;
  flex-wrap: wrap;
}
.ar .ar-filter-opt {
  font-size: 0.75rem;
  padding: 0.25rem 0.625rem;
  cursor: pointer;
  border: 1px solid var(--ar-rule);
  border-radius: 2px;
  color: var(--ar-text-2);
}
.ar .ar-filter-opt:hover {
  color: var(--ar-text);
  border-color: var(--ar-text-2);
}
.ar .ar-filter-in:checked + .ar-filter-opt {
  color: var(--ar-brand);
  border-color: var(--ar-brand);
  box-shadow: inset 0 -2px 0 var(--ar-brand);
}
.ar:has(#ar-view-flag:checked) table.ar-grid tr.ar-row:not(.ar-row-flag) {
  display: none;
}
.ar:has(#ar-view-flag:checked) table.ar-grid tbody.ar-group:not(:has(.ar-row-flag)) {
  display: none;
}

/* ---- 7 grid ------------------------------------------------------------ */
.ar .ar-scroll {
  overflow-x: auto;
  overscroll-behavior-x: contain;
  max-width: 100%;
  border: 1px solid var(--ar-rule);
}
.ar .ar-scroll:focus-visible {
  outline: 2px solid var(--ar-brand);
  outline-offset: -2px;
}
.ar table.ar-grid {
  border-collapse: separate;
  border-spacing: 0;
  margin: 0;
  width: auto;
  min-width: 100%;
  display: table;
  font-size: 0.6875rem;
  background: var(--ar-bg);
}
.ar table.ar-grid caption {
  caption-side: top;
}
.ar table.ar-grid th,
.ar table.ar-grid td {
  border: 0;
  padding: 0;
  background: none;
  font-weight: 400;
}

.ar table.ar-grid .ar-corner,
.ar table.ar-grid .ar-rh {
  position: sticky;
  left: 0;
  z-index: 2;
  background: var(--ar-bg);
  width: var(--ar-label);
  min-width: var(--ar-label);
  max-width: var(--ar-label);
  text-align: left;
  padding: 0.25rem 0.625rem;
  border-right: 1px solid var(--ar-rule);
  border-bottom: 1px solid var(--ar-grid-line);
}
.ar table.ar-grid .ar-rh-en {
  display: block;
  font-size: 0.75rem;
  color: var(--ar-text);
  line-height: 1.25;
}
.ar table.ar-grid .ar-rh-id {
  display: block;
  font-size: 0.625rem;
  color: var(--ar-text-2);
  background: none;
  padding: 0;
  line-height: 1.2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ar table.ar-grid thead th {
  position: sticky;
  top: 0;
  z-index: 3;
  background: var(--ar-bg);
  border-bottom: 1px solid var(--ar-rule);
  height: 2.25rem;
  vertical-align: bottom;
  color: var(--ar-text-2);
}
.ar table.ar-grid .ar-corner {
  z-index: 4;
  vertical-align: bottom;
}
.ar table.ar-grid .ar-ch {
  width: var(--ar-cell);
  min-width: var(--ar-cell);
  text-align: center;
}
.ar table.ar-grid .ar-ch span {
  display: block;
  padding-bottom: 0.25rem;
}
.ar table.ar-grid .ar-ch-hot span {
  color: var(--ar-text);
  font-weight: 700;
  box-shadow: inset 0 -2px 0 var(--ar-short-ink);
}
.ar table.ar-grid .ar-mh {
  width: 3rem;
  text-align: right;
  padding: 0 0.375rem 0.25rem;
  font-size: 0.625rem;
  letter-spacing: 0.04em;
}
.ar table.ar-grid .ar-gh {
  position: sticky;
  left: 0;
  z-index: 2;
  background: var(--ar-bg);
  text-align: left;
  padding: 0.875rem 0.625rem 0.1875rem;
  font-size: 0.625rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--ar-text-2);
  border-bottom: 1px solid var(--ar-rule);
}

.ar table.ar-grid td.ar-c,
.ar .ar-c {
  width: var(--ar-cell);
  height: var(--ar-cell);
  box-sizing: border-box;
  position: relative;
  padding: 0;
  border-right: 1px solid var(--ar-grid-line);
  border-bottom: 1px solid var(--ar-grid-line);
}
.ar .ar-c a {
  position: absolute;
  inset: 0;
  display: block;
}
.ar .ar-c a:focus-visible {
  outline: 2px solid var(--ar-brand);
  outline-offset: 1px;
}
.ar .ar-absent {
  background: none;
}
.ar .ar-captured::before {
  content: "";
  position: absolute;
  inset: 30%;
  background: var(--ar-ink);
}
.ar .ar-excused::before {
  content: "";
  position: absolute;
  inset: 18%;
  border: 1.5px dotted var(--ar-ink-soft);
  border-radius: 50%;
}
.ar .ar-short {
  background:
    repeating-linear-gradient(45deg, var(--ar-short-ink) 0 1px, transparent 1px 3px),
    var(--ar-short-fill);
  box-shadow: inset 0 0 0 1px var(--ar-short-edge);
}
.ar .ar-fault {
  background:
    linear-gradient(
      to bottom right,
      transparent calc(50% - 0.8px),
      var(--ar-fault-ink) calc(50% - 0.8px) calc(50% + 0.8px),
      transparent calc(50% + 0.8px)
    ),
    linear-gradient(
      to bottom left,
      transparent calc(50% - 0.8px),
      var(--ar-fault-ink) calc(50% - 0.8px) calc(50% + 0.8px),
      transparent calc(50% + 0.8px)
    ),
    var(--ar-fault-fill);
  box-shadow: inset 0 0 0 1px var(--ar-fault-edge);
}
/* JS-selected cell — a ring, not a colour change */
.ar .ar-c.is-sel::after {
  content: "";
  position: absolute;
  inset: -2px;
  border: 2px solid var(--ar-brand);
  pointer-events: none;
}

.ar table.ar-grid .ar-m {
  text-align: right;
  padding: 0 0.375rem;
  color: var(--ar-ink-soft);
  border-bottom: 1px solid var(--ar-grid-line);
  white-space: nowrap;
}
.ar table.ar-grid .ar-m-hot {
  color: var(--ar-text);
  font-weight: 600;
}
.ar table.ar-grid .ar-m-none {
  color: var(--ar-zero);
}
.ar table.ar-grid tfoot .ar-m,
.ar table.ar-grid tfoot .ar-foot {
  border-top: 1px solid var(--ar-rule);
  border-bottom: 0;
  padding-top: 0.3125rem;
}
.ar table.ar-grid tfoot .ar-foot {
  font-size: 0.625rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ar-text-2);
}

/* ---- 7 inspector ------------------------------------------------------- */
.ar .ar-inspect {
  position: sticky;
  bottom: 0;
  z-index: 5;
  background: var(--ar-bg);
  border: 1px solid var(--ar-rule);
  border-top-width: 3px;
  border-top-color: var(--ar-brand);
  margin-top: -1px;
}
.ar .ar-inspect[hidden] {
  display: none;
}
.ar .ar-inspect-head {
  display: flex;
  align-items: baseline;
  gap: 1rem;
  padding: 0.4375rem 0.75rem;
  border-bottom: 1px solid var(--ar-rule);
}
.ar .ar-inspect-t {
  margin: 0;
  font-size: 0.8125rem;
  font-weight: 600;
}
.ar .ar-inspect-t .ar-p-v {
  font-weight: 700;
  margin-right: 0.5rem;
}
.ar .ar-inspect-x {
  margin-left: auto;
  background: none;
  border: 1px solid var(--ar-rule);
  border-radius: 2px;
  color: var(--ar-text-2);
  font-size: 0.6875rem;
  padding: 0.125rem 0.5rem;
  cursor: pointer;
}
.ar .ar-inspect-x:hover {
  color: var(--ar-text);
  border-color: var(--ar-text-2);
}
.ar .ar-inspect-body .ar-p-body {
  border-top: 0;
  padding: 0.5rem 0.75rem 0.75rem;
}
.ar .ar-inspect-hint {
  margin-top: 0.5rem;
}

/* ---- 8 problems -------------------------------------------------------- */
.ar .ar-bh {
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  margin: 1.75rem 0 0.5rem;
}
.ar .ar-bh-fault {
  color: var(--ar-fault-ink);
}
.ar .ar-bh-short {
  color: var(--ar-short-ink);
}
.ar .ar-bh-exc {
  color: var(--ar-text-2);
}
.ar details.ar-p {
  border: 1px solid var(--ar-rule);
  border-left-width: 3px;
  margin: 0 0 1px;
  background: var(--ar-bg);
}
.ar details.ar-p-fault {
  border-left-color: var(--ar-fault-ink);
}
.ar details.ar-p-short {
  border-left-color: var(--ar-short-ink);
}
.ar details.ar-p-exc {
  border-left-color: var(--ar-ink-soft);
  border-left-style: dotted;
}
.ar details.ar-p > summary {
  cursor: pointer;
  list-style: none;
  padding: 0.4375rem 0.75rem;
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.5rem;
  font-size: 0.8125rem;
}
.ar details.ar-p > summary::-webkit-details-marker {
  display: none;
}
.ar details.ar-p > summary::before {
  content: "+";
  color: var(--ar-text-2);
  width: 0.75rem;
}
.ar details.ar-p[open] > summary::before {
  content: "\2212";
}
.ar details.ar-p > summary:hover {
  background: color-mix(in srgb, var(--ar-text) 4%, transparent);
}
.ar details.ar-p > summary:focus-visible {
  outline: 2px solid var(--ar-brand);
  outline-offset: -2px;
}
.ar details.ar-p.is-cited {
  box-shadow: inset 0 0 0 2px var(--ar-brand);
}
.ar .ar-p-v {
  font-family: var(--vp-font-family-mono, ui-monospace, monospace);
  font-size: 0.625rem;
  font-weight: 700;
  letter-spacing: 0.02em;
}
.ar .ar-p-fault .ar-p-v {
  color: var(--ar-fault-ink);
}
.ar .ar-p-short .ar-p-v {
  color: var(--ar-short-ink);
}
.ar .ar-p-exc .ar-p-v {
  color: var(--ar-text-2);
}
.ar .ar-p-leaf {
  font-size: 0.8125rem;
  font-weight: 600;
}
.ar .ar-p-t {
  font-size: 0.6875rem;
  color: var(--ar-text-2);
  margin-left: auto;
  font-family: var(--vp-font-family-mono, ui-monospace, monospace);
}
.ar .ar-p-body {
  display: grid;
  grid-template-columns: 8.5rem 1fr;
  gap: 0.1875rem 0.75rem;
  margin: 0;
  padding: 0.3125rem 0.75rem 0.75rem 1.5rem;
  font-size: 0.8125rem;
  border-top: 1px solid var(--ar-rule);
}
.ar .ar-p-body dt {
  color: var(--ar-text-2);
  font-size: 0.75rem;
  padding-top: 0.0625rem;
}
.ar .ar-p-body dd {
  margin: 0;
  text-wrap: pretty;
}
.ar .ar-p-body dd code {
  font-size: 0.75rem;
}
.ar .ar-p-body .ar-p-null {
  color: var(--ar-text-2);
  font-style: italic;
}
.ar .ar-p-body q {
  color: var(--ar-text-2);
}

/* ---- 9 method ---------------------------------------------------------- */
.ar .ar-method-list {
  display: grid;
  grid-template-columns: 14rem 1fr;
  gap: 0.4375rem 0.75rem;
  margin: 0;
  font-size: 0.8125rem;
}
.ar .ar-method-list dt {
  color: var(--ar-text-2);
  text-wrap: pretty;
}
.ar .ar-method-list dd {
  margin: 0;
  max-width: 64ch;
  text-wrap: pretty;
}

/* ---- narrow ------------------------------------------------------------ */
@media (max-width: 560px) {
  .ar {
    --ar-label: 11rem;
    --ar-cell: 18px;
  }
  .ar .ar-title {
    font-size: 1.375rem;
  }
  .ar table.ar-grid .ar-rh-id {
    display: none;
  }
  .ar .ar-eg-lbl {
    display: block;
    min-width: 0;
  }
  .ar .ar-p-body,
  .ar .ar-method-list,
  .ar .ar-meta {
    grid-template-columns: 1fr;
  }
  .ar .ar-p-body dt {
    margin-top: 0.375rem;
  }
  .ar .ar-inspect {
    position: static;
  }
}

/* ---- reduced motion ---------------------------------------------------- */
@media (prefers-reduced-motion: reduce) {
  .ar * {
    transition: none;
    animation: none;
  }
}

/* ---- print ------------------------------------------------------------- */
@media print {
  .ar .ar-scroll {
    overflow: visible;
    border-color: #000;
  }
  .ar .ar-filter,
  .ar .ar-inspect,
  .ar .ar-inspect-hint {
    display: none;
  }
  .ar details.ar-p {
    break-inside: avoid;
  }
  .ar details.ar-p > summary::before {
    content: "";
  }
  .ar .ar-c {
    print-color-adjust: exact;
    -webkit-print-color-adjust: exact;
  }
  .ar .ar-short,
  .ar .ar-fault {
    box-shadow: none;
    outline: 1px solid #000;
    outline-offset: -1px;
  }
  .ar table.ar-grid .ar-rh-id {
    display: block;
  }
}
```

### 6.1 Why the filter is CSS, not JS

`:has()` plus a radio group does the whole thing: `ar-view-flag:checked` hides every
`tr.ar-row` without `.ar-row-flag` and every `tbody` containing none. No script, works with
JS disabled, survives VitePress's client-side navigation, and the state is in the DOM rather
than in a variable. This is why the filter is described as the base layer, not an
enhancement — it would be a mistake to spend JS on it.

Collapsing to the 11 flagged rows also keeps the columns aligned, so
`11-ambiguous-attic` stays visibly a column even in the filtered view — which is the whole
finding.

---

## 7. JavaScript

**File:** `docs/public/accuracy-report.js`, loaded from the page with
`<script src="/accuracy-report.js" defer></script>`. Same origin, no bundler, no CDN, no
dependency. Plain ES2015+, one IIFE, no globals, no framework.

**What it does — one job.** Clicking a marked square opens that slot's full detail in a
panel pinned under the grid, instead of scrolling you away to the Problems section. It also
gives the grid arrow-key navigation, because 191 tab stops is not navigation.

**What it does not do.** No rendering, no data, no templating. Every string it shows is
already in the DOM inside its `#p-NN` entry; the panel shows a clone. There is exactly one
copy of every fact on this page.

```js
(function () {
  "use strict";

  // Delegated from document, so VitePress client-side route changes need no re-binding.
  document.addEventListener("click", function (ev) {
    var close = ev.target.closest("[data-ar-close]");
    if (close) {
      hide(close.closest(".ar-inspect"));
      return;
    }

    var link = ev.target.closest(".ar-c a[data-ar-p]");
    if (!link) return;

    var root = link.closest(".ar");
    var panel = root && root.querySelector(".ar-inspect");
    var entry = root && root.querySelector("#" + link.dataset.arP);
    if (!panel || !entry) return; // fall through to the anchor jump

    ev.preventDefault();
    show(root, panel, entry, link.closest(".ar-c"));
  });

  document.addEventListener("keydown", function (ev) {
    var cell = ev.target.closest ? ev.target.closest(".ar-c") : null;

    if (ev.key === "Escape") {
      var open = document.querySelector(".ar .ar-inspect:not([hidden])");
      if (open) {
        hide(open);
        ev.preventDefault();
      }
      return;
    }
    if (!cell) return;

    var dir = { ArrowRight: [0, 1], ArrowLeft: [0, -1], ArrowDown: [1, 0], ArrowUp: [-1, 0] }[
      ev.key
    ];
    if (!dir) return;

    var row = cell.parentElement;
    var cells = Array.prototype.slice.call(row.querySelectorAll(".ar-c"));
    var x = cells.indexOf(cell);
    var next = null;

    if (dir[1]) {
      next = cells[x + dir[1]];
    } else {
      var rows = Array.prototype.slice.call(
        row.closest("table").querySelectorAll("tr.ar-row:not([hidden])"),
      );
      var y = rows.indexOf(row);
      var target = rows[y + dir[0]];
      if (target) next = target.querySelectorAll(".ar-c")[x];
    }
    if (!next) return;

    ev.preventDefault();
    focusCell(next);
  });

  function focusCell(cell) {
    var a = cell.querySelector("a[data-ar-p]");
    if (a) {
      a.focus();
      return;
    }
    cell.tabIndex = -1;
    cell.focus(); // empty squares are reachable but silent
  }

  function show(root, panel, entry, cell) {
    var body = entry.querySelector(".ar-p-body");
    var head = entry.querySelector("summary");
    if (!body || !head) return;

    panel.querySelector(".ar-inspect-t").innerHTML = head.innerHTML;
    var dest = panel.querySelector(".ar-inspect-body");
    dest.textContent = "";
    dest.appendChild(body.cloneNode(true));
    panel.hidden = false;

    root.querySelectorAll(".ar-c.is-sel").forEach(function (n) {
      n.classList.remove("is-sel");
    });
    if (cell) cell.classList.add("is-sel");

    root.querySelectorAll("details.ar-p.is-cited").forEach(function (n) {
      n.classList.remove("is-cited");
    });
    entry.classList.add("is-cited");
    entry.open = true; // so a later print or Ctrl-F finds it
  }

  function hide(panel) {
    if (!panel) return;
    panel.hidden = true;
    var root = panel.closest(".ar");
    if (!root) return;
    root.querySelectorAll(".ar-c.is-sel").forEach(function (n) {
      n.classList.remove("is-sel");
    });
    root.querySelectorAll("details.ar-p.is-cited").forEach(function (n) {
      n.classList.remove("is-cited");
    });
  }
})();
```

### 7.1 The no-JS fallback, stated explicitly

| Feature                  | With JS                                                                                    | Without JS                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Filter to the 23         | Radio + `:has()`                                                                           | **Identical** — no JS involved                                                                        |
| Cell → detail            | Panel opens under the grid; cell gains a focus ring; matching entry is opened and outlined | `<a href="#p-06">` jumps to the same entry in Problems, which is a real element with the same content |
| Grid keyboard navigation | Arrow keys walk the cells                                                                  | Tab reaches every marked cell in DOM order; empty cells are not tab stops                             |
| Escape / Close           | Closes the panel                                                                           | Nothing to close                                                                                      |
| Reading the whole report | —                                                                                          | **Everything.** All 714 slots, all 23 problem entries, all rates and gates are in the served HTML.    |

The panel is `hidden` in the served markup and only ever unhidden by script, so a no-JS
reader never sees an empty container. The `<a href>` is a real href, not a `#` placeholder,
so it works before the script loads, if the script 404s, and in a text browser.

### 7.2 Why not the other three interactions

- **Highlight one verdict class** — subsumed. With only 23 non-baseline cells and a filter
  that isolates them, a per-class highlight would be a second control doing a weaker version
  of the first one's job. The legend swatches already teach the classes.
- **Hover/tap a row label for the plain-English name** — rejected, and replaced by something
  better: the plain-English name is _printed in the row header_, statically, as the primary
  line, with the dotted path below it. A tooltip would have failed on touch, failed on
  keyboard, failed in print, and hidden the single thing a newcomer most needs.
- **Search/free-text filter** — rejected. 51 rows with named groups and browser Ctrl-F over
  fully-rendered text is already better than a bespoke search box, and a search box that
  silently misses `hidden` rows is worse than none.

---

## 8. The history line — what replaced the sparkline

v1 drew a sparkline at every n, including n=1, where a single dot on a dashed rule reads as
debris. v2 makes the threshold explicit:

| History length             | What renders                                                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **n = 1** (the usual case) | No graphic. One line of text: _"Run 1 of 1 — no history to compare against yet."_ Italic, above a hairline rule, in the same slot the sparkline will occupy. |
| **n = 2**                  | No graphic. _"Run 2 of 2 — previous 0.6%, now 0.8%."_ Two points is a comparison, not a trend, and a two-point line implies a slope.                         |
| **n ≥ 3**                  | Sparkline, spec below, plus the same sentence in words.                                                                                                      |

Why text rather than a "deliberate-looking" single mark: any mark in a plot frame is a claim
that there is something to see. There isn't. A sentence that says so is more informative,
takes less space, is readable by a screen reader without an `aria-label` workaround, prints,
and cannot be misread as a flat trend. It also means the card's layout does not change shape
when history arrives — the rule and the slot are already there.

**Sparkline spec at n ≥ 3** (unchanged from v1 §8 except the threshold):

- `viewBox="0 0 132 34"`, plot box `x ∈ [4,128]`, `y ∈ [4,30]`.
- Stroke is `currentColor` from `--ar-text-2`. **The trend line is never coloured** — a rate
  moving up is not automatically bad, and a hue would assert that it is.
- **Y domain is fixed, never autoscaled:** `yMax = max(2%, ceil(1.25 × max(series)))`, floor
  always 0. At 0.8% that is a 0–2% domain, so a 0.8 → 0.9 wobble is a small step rather than a
  cliff. Autoscaling to a low-variance rate is the commonest way a sparkline lies, and every
  rate on this page is low-variance.
- `x(i) = 4 + 124·i/(n−1)`; `y(v) = 30 − 26·(v/yMax)`. Round to one decimal at build.
- Dashed 1px baseline at `y=30.5` so it never reads as data. Latest point `r=2.5` filled;
  earlier points `r=1.5` in `--ar-rule` only when n ≤ 8.
- `aria-label` carries range and latest value; `.ar-hist` repeats them in visible text. The
  line is decoration over a caption that already says everything, which is why losing it to
  greyscale, to a screen reader, or to a print driver costs nothing.

```html
<svg
  class="ar-spark"
  viewBox="0 0 132 34"
  width="132"
  height="34"
  role="img"
  aria-label="Made-up rate over 6 runs, 0.6% to 0.8%, latest 0.8%"
>
  <line class="ar-spark-base" x1="4" y1="30.5" x2="128" y2="30.5" />
  <polyline
    class="ar-spark-line"
    points="4,22.2 28.8,22.2 53.6,19.6 78.4,24.8 103.2,19.6 128,19.6"
  />
  <circle class="ar-spark-dot-past" cx="4" cy="22.2" r="1.5" />
  <circle class="ar-spark-dot-past" cx="28.8" cy="22.2" r="1.5" />
  <circle class="ar-spark-dot-past" cx="53.6" cy="19.6" r="1.5" />
  <circle class="ar-spark-dot-past" cx="78.4" cy="24.8" r="1.5" />
  <circle class="ar-spark-dot-past" cx="103.2" cy="19.6" r="1.5" />
  <circle class="ar-spark-dot" cx="128" cy="19.6" r="2.5" />
</svg>
<p class="ar-hist">6 runs &middot; 0.6%&ndash;0.8% &middot; latest 0.8%</p>
```

---

## 9. What I deliberately did not do

**Applied Nocturne's palette.** It is bound to this project, but this page renders inside
someone else's docs site and must follow the reader's light/dark choice. Nocturne's
theme-independent principles are applied; its colours are not. Flagging it rather than
silently ignoring it.

**A conventional heatmap.** 73% one outcome would give a uniform field with 23 meaningful
pixels. Inverting the ink is the solve, and it is unchanged from v1.

**A colour per verdict.** 14 hues are unlearnable, unprintable, and hostile to colour-blind
readers. Five buckets, two of them chromatic, the precise verdict always in words.

**Green anywhere, including the 8-of-8 stop-checks.** Correct extraction is the baseline; a
cleared check is the absence of an alarm, not a win. Spending colour only on the 23 cells
that need it also means one red cell in a future run is the only chromatic event on the page.

**A gauge, dial, donut, or progress bar.** Each implies a target. There is none. Big numeral,
explicit denominator, one sentence of definition.

**A composite score.** Three rates with three different denominators do not average, and a
single number is exactly what invites shipping on a figure nobody can decompose.

**Folding the 12 health misses into the miss rate.** Doing so would take a
twelve-safety-check failure and report it as a fraction of a percent. They are counted, named
and located separately, and the miss-rate card says so where the number appears.

**Sorting the grid by severity, or hiding clean rows by default.** Row order is form order,
always, so two runs are comparable square for square — the artefact's main value to the
engineer. The filter makes hiding a _choice_ the reader makes, and the default is all 714.

**A hazard bar chart.** All eight counts are 0; a chart of eight zeros is an empty frame, and
a chart of 2-versus-0 invites reading magnitude into pass/fail.

**A single-bar stacked "shape conformance" chart.** 14/0/0 renders as one full bar, which
says nothing and looks like a completion meter. Three labelled counts, and `n/a` stated as
`n/a` with a note that a missing count is not a zero.

**Screen-reader text on all 714 cells.** 714 announcements is a denial of service, not
access. The caption states the convention, the row headers are plain English, the margins
give per-row totals, and Problems is a complete non-visual route to every non-trivial slot.

**A glossary.** Read by nobody who needed it. Terms are defined in the sentence that first
uses them, and the plain-English name is the primary label everywhere the technical ID also
appears.

**A tooltip for anything load-bearing.** No hover-only affordance carries information on this
page. Tooltips fail on touch, on keyboard, and in print; the two `title` attributes present
are duplicative hints, never the only source.

**A search box, a sort control, a verdict-class highlighter, or a "compare to previous run"
widget.** Each was considered and cut — reasoning in §7.2. Ctrl-F over fully-rendered text
beats a bespoke search that silently skips hidden rows.

**Client-side data.** The script ships no strings and no numbers. Everything it displays is
cloned from markup that was already served, so the JS-enabled and JS-disabled pages cannot
disagree about a fact.
