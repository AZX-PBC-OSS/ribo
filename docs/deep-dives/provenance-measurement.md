# Provenance: Measured

Every extracted leaf carries a claimed quote from the source, and `isSpanGrounded` checks it against
the actual text — no human, no second model, just a string comparison. What turned out to matter as
much as that check existing is what a citation should be **the citation of**: one leaf, one row, or
nothing at all. This page is the measurement behind that decision, and the full working behind
[Comparison](/guide/comparison)'s provenance row.

::: warning What this page does and does not measure
This is a page about **citation fidelity and call economics** — whether a quoted span is actually in
the source text, and how many calls and citations it costs to get one. It is not a page about
extraction accuracy. None of the numbers below say anything about how often an extracted **value**
is correct, and this repo does not currently have that number at all — see
[Extraction: Measured](/deep-dives/accuracy) for why. Do not read a low fabrication rate here as a
high accuracy rate; they are different questions with different answers.
:::

## The problem: a wide table costs a citation nobody reads

`enveloped()` wraps every leaf of a patch schema in `{ value, confidence, sourceSpan }` — exactly
the right unit when a human reviews one field at a time, which is what it was built for. It's the
wrong unit for a **repeated row** of a wide table. Running a real load-calculation report through
`perGroupExtractor` against the managed gateway, its `componentLoads` table ran up to 67 rows by 9
leaves. Compared at that shape:

| provenance shape                   | nullable unions per row | calls needed | JSON values | citations produced |
| ---------------------------------- | ----------------------: | -----------: | ----------: | -----------------: |
| every leaf enveloped (the default) |                      18 |    2 (split) |       1,809 |                603 |
| plain leaves, no provenance at all |                       9 |            1 |         603 |                  0 |
| plain leaves, one span per row     |                      10 |            1 |         670 |                 67 |

Fully enveloped, the table produces 603 verbatim citations that no reviewer will ever individually
click through, and it costs the group two calls to deliver them rather than one — two failures were
hit getting even that far: a rolling-hour rate limit at default concurrency, and a `finishReason:
"length"` truncation of one of the two calls at its output-token cap.

## Row citations aren't just cheaper — they're more accurate

Per-cell citations weren't only expensive; they were wrong more often than they were right. On the
same class of table, the model fabricated **37% of per-cell citations** on a load-calculation report
(17 of 46) and 18% on an invoice. Switching the unit of citation to one span per row, measured on a
full 15-leaf, 14-row table from a separate report, came back **14 of 14 row spans verbatim** — zero
near-miss, zero fabricated, in a single call.

That's the finding worth sitting with: the unit of citation wasn't only fighting the token budget,
it was fighting the model. A row span is one line of the source document. A cell span, on a wide
table, asks the model to isolate a fragment of a line it's already citing nine other times — and it
did that badly.

## The fix: a group declares its own granularity

`enveloped()` takes a `provenance` option, keyed per top-level group: `"leaf"` (the default, one
citation per field), `"row"` (plain leaves, one citation per row), or `"none"` (no citation at all).
A group absent from the map stays at `"leaf"` — nothing changes for a schema that doesn't ask for
anything different.

The granularity is **derived** into the extraction schema, not a second schema a caller maintains by
hand. A hand-built mixed schema — a `rowSourceSpan` field declared directly on a row object — already
worked before this; what was missing was the ability to get there from one declaration instead of
two schemas that are free to drift apart. That's the same reason `enveloped()` exists at all for the
leaf case, applied to the row case too.

## Partitioning by nullable-union weight is what makes the call count real

Declaring a group `"row"` doesn't save a call by itself unless the partitioning rule also stops
counting by leaf. Every field in a `"leaf"` group costs two nullable unions (`value` and
`sourceSpan`, both nullable); every field in a `"row"` or `"none"` group costs one, plus one more for
the row's own span. A 15-leaf row group plus its row span comes to 16 nullable unions — exactly the
managed route's per-call ceiling documented on
[Schema at Scale](/deep-dives/schema-scale) — and fits in a single call. A partitioning rule that
still counted by leaf would have split that same group into two calls anyway, buying nothing from
the coarser citation. Moving the constant from a leaf count to a nullable-union count is what turns
"fewer citations" into "fewer calls," not just a smaller response.

Nothing moves for a schema that's entirely `"leaf"` already: run side by side against the real Snugg
Pro extraction schema, the leaf-counting and union-counting versions of the partitioner produce the
same split, call for call.

## What review does with a shared citation

A `"row"` group renders in review exactly like a `"leaf"` group — every field gets its own
reviewable entry — except every field belonging to one row points at that row's single span, and
groundedness is computed from it. A plain leaf's confidence reads as `1` when the model supplied a
value and `0` when it didn't, which is deliberately the same sentinel review already uses to mark a
leaf the model never considered, rather than a new state a reviewer has to learn. A `"none"` group
reads as ungrounded outright: there's no citation to check, so there's nothing to claim is grounded.

## A citation can be almost right without being fabricated

Building this out surfaced a second gap: a source document's layout sometimes pads a line with extra
spaces to align columns, so the text a model quotes and the text on the page can differ only in
whitespace. Before this, that read identically to an invented citation — both failed the same
verbatim check. Groundedness now has three states instead of two: grounded, near-miss (differs only
in case, whitespace, or quote characters), and ungrounded. The strict, verbatim check `isSpanGrounded`
performs is unchanged; the near-miss tier is additive, so it doesn't change what any existing card
reports.

## What this doesn't settle

Everything above is about whether a citation is real and how many calls it costs to get one. It is
not, and was never designed to be, a measurement of whether the value next to that citation is
correct. That number — extraction accuracy, field by field — is not currently available in this
repo; see [Extraction: Measured](/deep-dives/accuracy) for the state of that gate and why it's
declining to publish a stale one rather than a misleading one.
