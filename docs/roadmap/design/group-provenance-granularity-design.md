# Group provenance granularity: let a wide table cite a row, not a cell

**Date:** 2026-09-10
**Status:** Built. Landed on `feat/group-provenance`.

## 1. Context

`enveloped()` (`packages/ribo-core/src/enveloped.ts`) wraps **every** leaf of a patch schema in
`{ value, confidence, sourceSpan }`. That is the right unit for a field a human verifies one at a
time — Snugg Pro's `health` matrix, where an auditor accepts the ambient-CO result and corrects the
gas-leak one, is exactly the case R1.5 built it for.

It is the wrong unit for a wide table. Running the real Abode corpus through `perGroupExtractor`
against the Helix gateway, a Manual J `componentLoads` table is up to 67 rows x 9 leaves:

| shape                           | nullable unions/row | calls              | JSON values | citations |
| ------------------------------- | ------------------- | ------------------ | ----------- | --------- |
| enveloped per leaf (before)     | 18                  | **2** (partitions) | 1,809       | **603**   |
| plain leaves, no provenance     | 9                   | 1                  | 603         | 0         |
| plain leaves + one span per row | 10                  | **1**              | 670         | **67**    |

603 verbatim citations for one table, none of which a reviewer will ever click through — and the
group partitions across two calls to deliver them. Two failures were observed getting there:
`rate_limited` on the rolling-hour burst cap at the default concurrency, then `finishReason:
"length"` truncating `componentLoads` part 1/2 at `maxTokens: 12000`.

Row-level provenance was then measured on the full 15-leaf room set (Wrightsoft, 24pp): **one call,
14 rooms, 36.7s, 14 row spans verbatim, 0 near-miss, 0 fabricated**, and the extracted heating loads
summed to 34,334 against the 34,334 the report prints for the whole house.

Two further findings shaped the decision:

- **A row span is easier for the model than a cell span.** It is one line of the transcript.
  `claude-haiku-4-5` fabricated 37% of _per-cell_ citations on a Manual J (17 of 46) and 18% on an
  invoice; row spans came back 14/14 verbatim. The unit of citation was fighting the model, not
  only the token budget.

  > **Addendum, 2026-09-11 — this bullet did not reproduce.** A 2x2 factorial (write-up in
  > `docs/deep-dives/provenance-measurement.md`), five runs per cell, put per-cell citation at 99.5% verbatim
  > and per-row at 98.8% — leaf marginally ahead of row, and no sign of the gap. That run differs
  > from this one in document, schema and extraction mechanism (`singleShotExtractor` with
  > Anthropic `tool_use`, against this one's `perGroupExtractor` through the Helix gateway), so it
  > does not refute the 37% so much as fail to find it. Read the figure as a measurement under the
  > conditions above, not as a property of cell-level citation. **The decision stands on the token
  > budget and reviewer-experience arguments**, which are independent of fabrication rate and are
  > unaffected.

- **A mixed schema was already achievable by hand.** A `rowSourceSpan` field declared on the row
  object, with a hand-built `extractionSchema`, works today — the measurement above is that. What
  was missing was the ability to **derive** it, which is the whole point of `enveloped()`.

## 2. Decision 1 — a group declares its granularity; the derivation implements it

**Decision:** `enveloped(valuesSchema, { provenance: { rooms: "row" } })`. Three granularities,
keyed by top-level group.

| granularity        | leaves                                              | span                     |
| ------------------ | --------------------------------------------------- | ------------------------ |
| `"leaf"` (default) | each wrapped in `{ value, confidence, sourceSpan }` | one per leaf             |
| `"row"`            | plain (`X.nullable()`)                              | one `sourceSpan` per row |
| `"none"`           | plain                                               | none                     |

**Why derived and not configured.** A hand-maintained mixed extraction schema already works. The
defect it carries is the one R1.5 exists to prevent: two schemas describing the same fields, free to
drift, with nothing to notice. Anything a caller has to keep in sync by hand would not have solved
the problem. So the granularity is an input to the single derivation, never a second schema.

**Why `"leaf"` must be byte-for-byte unchanged.** `ribo-adapter-snuggpro`'s
`extraction-shape.test.ts` pins the derivation against a frozen JSON Schema fixture. That fixture
passing untouched is the regression gate for this whole change, and it does.

**Why a row carries no `confidence`.** The model is not asked for one, `provenance.ts` records at
length that the number carries no discriminating signal (mean 0.996 on correct answers, 1.000 on
correct nulls, no computable gap), and every key added is a key the model spends tokens on.

**Why the span comes last in the row object.** Strict structured output emits properties in schema
order, so the model states the row's values and then quotes the line it read them off — the same
value-then-citation order `extractedSchema` puts a leaf's own span in.

**What counts as a row.** The group object for a singleton group; each array element for a
collection; each element of any array nested inside one, because a nested array is a repeated record
of its own. A nested plain object belongs to the row it sits in and gets no span. Every real grouped
schema in this repo is one object level deep per group, where all readings coincide — the rule
exists so the deeper case is decided rather than discovered.

**Fails loudly.** A granularity naming a group the values schema does not have throws at schema
build time, as does `"row"` on a top-level leaf (there is no row object to hang the span on) and a
row group that already declares a `sourceSpan` field. Each is otherwise silent: an unknown key is a
typo that leaves the group at `"leaf"`, producing a schema several times the size the caller asked
for and hundreds of citations nobody wanted, with nothing to say so.

## 3. Decision 2 — partition on nullable unions, not on leaves

**Decision:** `MAX_ENVELOPED_LEAVES_PER_GROUP = 8` becomes `MAX_NULLABLE_UNIONS_PER_CALL = 16`, and
`splitExtractionSchema` weighs each property by the nullable unions it costs.

**Why this is the whole point, not a detail.** The Anthropic family caps a response schema at 16
nullable unions. An enveloped leaf costs two (`value` and `sourceSpan`, both `X.nullable()`), so
while every leaf was enveloped, "8 leaves" and "16 unions" were the same rule and counting leaves
was harmless. A `"row"` or `"none"` leaf costs **one**. A 15-leaf row group plus its row span is 16
unions and fits in a single call — and a leaf count of 8 would still split it in two, buying exactly
nothing from the coarser provenance. This is the difference between the measured 1 call and the
measured 2.

**Nothing moves for an existing schema.** Verified empirically against the real Snugg extraction
schema by running the old algorithm and the new one side by side: 66 pieces before, 66 after, zero
per-group differences.

**The cap stays caller-tunable**, as [#58](https://github.com/AZX-PBC-OSS/ribo/pull/58) made it —
`maxNullableUnionsPerGroup` on both `PerGroupOptions` and `ScopedFillOptions`, defaulting to the
constant. A host bound by a different limit (this repo's own OpenAI-compatible route is a byte cap,
not a union count) should not inherit a number sized for another provider. The rename carries that
knob to the new unit rather than removing it.

## 4. Decision 3 — the group/envelope test moves to `isExtractedSchema`

`splitExtractionSchema` decided whether a schema was "an object of groups" by testing that every
property of a candidate was itself a `ZodObject`. That separated a group (whose properties are
envelopes) from an envelope (whose `confidence` is a bare number) without naming the envelope's keys.

**That reading breaks the moment a group declares row provenance**, and it breaks quietly and
globally: a row group's properties are plain leaves, so the test calls the group an envelope,
concludes the whole schema is not grouped, and returns everything as a single `key: ""` entry —
collapsing the per-group split for **every** group, not just the row one, into one over-cap call.
The symptom appears nowhere near the option that caused it.

**Decision:** ask the question directly. `isExtractedSchema` is new in `ribo-core`, beside the
`extractedSchema` it recognises, and matches the key set **and** each key's kind — the names alone
are ordinary enough that a real field set could carry them, and a row's own `sourceSpan` does.
Predicate and constructor have to change together, so they sit together.

## 5. Decision 4 — a row's citation is shared by its fields in review

**Decision:** a `"row"` group presents exactly as a `"leaf"` group does — every leaf its own
`ReviewField` with its own verdict — except that the fields of one row all show that row's span,
and `isGrounded` is computed from it.

**Why not a new node kind.** A `ReviewRowNode` would let a UI draw the citation once per row, which
is the nicer rendering. It was declined: `ReviewField` is what every host already renders,
`resolveReview` is keyed by leaf path, and a second presentation shape would have to be handled by
every UI before any of them could show a row group at all. Sharing the span leaves the contract's
surface unchanged and `resolveReview` untouched — a plain value is normalised into an `Extracted` on
the way in, so the decision path, the leaf schema and the patch reassembly never learn about
granularity.

**A plain leaf's `confidence` is `1` when present, `0` when absent.** There is no model-reported
number to carry. The `0` is not arbitrary — it is `omittedLeaf()`'s, and keeping the two apart is
what stops "the model answered null" from reading identically to "the model never emitted this key".

**A `"none"` group reads as ungrounded.** Honest: there is no citation to check.

## 6. Decision 5 — `spanGroundedness` gains a near-miss tier

Discovered alongside this work rather than caused by it. `layoutPageText` pads columns to align
them, so a document transcript holds `"$       5,250.00"` while a model quoting that line reports
`"$ 5,250.00"`. `isSpanGrounded` reports that as ungrounded — the same answer it gives for text the
model invented. Once a fabricated citation and a re-spaced one are indistinguishable, the flag stops
being worth acting on, which is precisely how `confidence` became useless.

**Decision:** `spanGroundedness` returns `"grounded" | "near-miss" | "ungrounded"`, surfaced
additively as `ReviewField.groundedness`. `isSpanGrounded` still means verbatim and is unchanged, so
no existing card changes.

The extraction spike's scorer (`docs/spikes/0001-extraction-snuggpro/score.mjs`) already draws this line, and
this is that rule — case, whitespace runs and quote characters. It draws two more that are
**deliberately not adopted**: a punctuation-insensitive match, and a "some 4-word fragment appears"
match. Both are right for grading a corpus, where the question is whether the model found the
answer. Neither is right for a review card, where the question is whether the auditor can check the
quote against the document — and a paraphrase sharing four words cannot be checked that way.

## 7. What changes where

- `ribo-core` — `enveloped()`'s `provenance` option and its type-level mirror; `Enveloped<V, P>`;
  `ToolAdapter<V, C, P>`; `ExtractionTarget<V, P>`; `isExtractedSchema`; `spanGroundedness` and
  `ReviewField.groundedness`; `buildReviewRequest`'s `provenance` option.
- `ribo-extractor-openai` — union counting and the constant rename in `splitExtractionSchema`; the
  group/envelope test; the granularity type parameter through all three strategies.
- `ribo-extractor-ondevice` — `threePhaseExtractor` refuses a coarser-provenance group (§8).
- `ribo-ui-react` — `useReview`'s `provenance` option, passed straight through.
- No adapter changes. Snugg Pro stays entirely at `"leaf"`, and its frozen fixture is untouched.

## 8. Out of scope, recorded so it is not rediscovered

- **`threePhaseExtractor` does not support row provenance, and now says so.** It is per-leaf
  provenance by construction: phase 1 asks for one verbatim span **per leaf** and phase 2 classifies
  that leaf's value out of that span. Given a row group it found no leaves, asked the model about
  nothing, and emitted an empty object that only the closing `extractionSchema.parse()` rejected —
  after every other group's calls had been spent. It now throws at construction instead. Teaching it
  row provenance (phase 1 asking for one row span, phase 2 classifying every leaf out of it) is a
  coherent design and, given §1's fabrication measurement, probably a good one — but it is a
  different strategy, not a patch to this one.
- **Any Abode- or HVAC-specific schema.** The Turnkey targets live in the consuming app, the way
  `ribo-adapter-snuggpro` holds Snugg Pro's knowledge.
- **Changing the default.** Every existing caller keeps today's behaviour with no edit.
- **Retuning `DEFAULT_WORD_GAP_PT`.** Wrightsoft's letter-spaced header comes back as
  `"Rig ht-Su ite® U niv er sal"` — real, cosmetic, and a separate question.

## 9. Open question — should review derive the granularity instead of being told it?

The granularity map is passed twice: once to `enveloped()` and once to `buildReviewRequest` /
`useReview`. It is **one declaration referenced twice** (a host constant handed to two consumers),
not two things to keep in sync, and the drift §2 forbids — two schemas describing the same fields —
is eliminated regardless. So this is a question of taste, not correctness.

It exists because review walks the **values** schema, which is identical at every granularity, so it
cannot see what the extraction was derived at. Told nothing, it reads a row group's plain leaves as
envelopes, every one falls back to the omitted-leaf sentinel, and the card renders a table of blanks
— a failure that looks like a bad extraction rather than a mismatched option.

Two alternatives were considered:

- **Hand review the derived extraction schema** and read the granularity off it with
  `isExtractedSchema`. Genuinely derived, nothing to pass twice. Declined for now because it
  recouples review to the extraction side that R1.5 deliberately separated: `useReview` takes a
  values schema precisely so a review UI needs no extraction knowledge.
- **Detect it from the data** — if the node at a leaf path is an envelope, read it as one; otherwise
  read a plain value and look for a sibling row span. Needs no extra argument at all. Declined
  because it is a heuristic where the current code is a fact: a malformed envelope would be
  presented as a plain value rather than as the sentinel, silently reversing today's behaviour for
  the `"leaf"` case that must not change.

Revisit if a third consumer of the map appears.
