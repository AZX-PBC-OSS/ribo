# Provenance

Every field Ribo extracts arrives with a claim about where it came from, and that claim is checked
against the source rather than taken on trust. This page covers the mechanism — the envelope, the
check, and the knob that controls its unit. The measurement behind the design decisions is a
separate page: [Provenance: Measured](/deep-dives/provenance-measurement) has the numbers; this page
has the shape.

::: warning This page is about citation fidelity, not field accuracy
Everything below answers "is the quote real, and how much did it cost to get one" — never "is the
extracted value correct." Those are different questions. A span that is verbatim in the source
tells you the model didn't invent its citation; it tells you nothing about whether it picked the
right cell to cite in the first place. Extraction accuracy has no current number in this repo — see
[Comparison](/guide/comparison)'s "What is not measured" section.
:::

## What the envelope is

[Typesafety](/guide/typesafety) covers `enveloped()` deriving a closed, fully-required extraction
schema from the patch you write by hand. Provenance is _why_ that derived shape looks the way it
does: by default, every leaf of the patch schema doesn't survive into the extraction schema as
itself. The leaf's own key now holds an object of three properties — `value`, `confidence`, and
`sourceSpan` — so the schema expands by four properties overall where the patch declared one.

`packages/ribo-core/src/provenance.ts`'s `extractedSchema(inner)` is that wrapper:

```ts
import { z } from "zod";
import { extractedSchema } from "@azx/ribo-core";

extractedSchema(z.string());
// { value: z.string().nullable(), confidence: z.number(), sourceSpan: z.string().nullable() }
```

- **`value`** is `inner.nullable()`. `null` means "not stated in the transcript" — never a guess,
  never an inference.
- **`confidence`** is the model's self-reported score. Every key here is required and nullable, not
  optional, which is the anti-hallucination rule: an omitted key would be indistinguishable from a
  field the model never considered, so the model has to explicitly emit `null` rather than leave a
  key out.
- **`sourceSpan`** is the verbatim quote justifying `value`, or `null`. It's what a review card shows
  the reviewer, and it's the one property this page is about, because unlike `confidence` it's
  checkable.

`isExtractedSchema` is the matching predicate — it recognizes a schema `extractedSchema` built by
checking the key set and each key's kind, not just the names, because a `"row"`-granularity group
(below) can legitimately have a plain field named `sourceSpan` of its own.

## Why a span beats a confidence score

`confidence` is the model grading its own work. Nothing external checks it, and nothing forces it to
mean anything: `provenance.ts` documents an internal spike where mean confidence on correct answers
and mean confidence on correct nulls were both close to the ceiling, with no computable gap between
right and wrong answers. A "flag anything under some threshold" rule against that distribution flags
nothing — it reads as "the extraction is clean" when the real story is "the signal is absent."

A `sourceSpan` is different in kind, not just in degree: it's a factual claim about the source text,
and factual claims can be checked without asking the model anything else.

```ts
import { isSpanGrounded } from "@azx/ribo-core";

isSpanGrounded(fields.company.sourceSpan, transcript.text); // true or false, by string comparison
```

`isSpanGrounded(span, transcript)` is a pure predicate: strip trailing whitespace from the span (it
arrives trimmed; the transcript keeps its own line breaks), then check that the transcript contains
it verbatim. No model, no human, no I/O — a citation the model invented fails this exactly the way a
forged quote fails a search for it.

**The near-miss tier.** A verbatim check is strict enough to catch a real problem in document
transcripts: a source layout sometimes pads a line with extra spaces to align a column, so the
transcript holds one run of whitespace where a model's quote of the same line holds another. Before
`spanGroundedness` existed, that read identically to a fabricated citation — both failed the same
verbatim check, and a reviewer got sent hunting for a hallucination that was actually a formatting
artifact. `spanGroundedness` reports three tiers instead of two:

```ts
import { spanGroundedness } from "@azx/ribo-core";
// type SpanGroundedness = "grounded" | "near-miss" | "ungrounded"
```

- **`"grounded"`** — verbatim. Exactly what `isSpanGrounded` checks.
- **`"near-miss"`** — the quote is in the document, differing only in case, whitespace runs, or
  quote-character style (a curly quote versus a straight one).
- **`"ungrounded"`** — the text isn't there at all. This is the tier worth interrupting a reviewer
  for.

The strict check `isSpanGrounded` performs doesn't change; the near-miss tier is additive, so
nothing that already reads a boolean groundedness needs to change to benefit from it. A `null` or
blank span is always `"ungrounded"`, never near — every string contains `""`, so a normalized
`.includes` would otherwise call an empty span a near miss of anything.

## Why granularity is a knob

Wrapping every leaf is the right unit when a human reviews one field at a time — a health-check
matrix where an auditor accepts one reading and corrects the next is exactly that case. It's the
wrong unit for a **repeated row** of a wide table, and the reason is measured, not theoretical:
running a real 67-row × 9-column table through extraction, fully-enveloped citations cost **603**
citations that no reviewer will ever individually click through, and getting all of them back cost
the group **two calls instead of one** — every leaf-envelope citation costs two nullable unions
against the per-call ceiling covered in [Schema at Scale](/deep-dives/schema-scale), and a 67×9 table
of them blew past it. Switching that same shape to one citation per row rather than one per cell
fit the whole table in a single call.

Row citations weren't only cheaper. They were also more accurate: per-cell citations on that table
came back **37% fabricated**, while a separate 14-row table measured with row-level citations came
back **14 of 14 verbatim**. A cell span asks the model to isolate one fragment of a line it's
already citing several other times over; a row span is one line, quoted once. The unit of citation
was fighting the model, not only the token budget. Full numbers and the partitioning mechanics are
in [Provenance: Measured](/deep-dives/provenance-measurement).

`enveloped()` exposes the fix as a per-group option, not a second schema to hand-maintain:

```ts
import { enveloped } from "@azx/ribo-core";

const extractionSchema = enveloped(patchSchema, {
  provenance: { componentLoads: "row" },
});
```

`ProvenanceGranularity` is `"leaf" | "row" | "none"`, declared per top-level group key via the
`ProvenanceMap` you pass as `EnvelopedOptions.provenance`. A group absent from the map stays at
`"leaf"` — the default is unchanged, so nothing about an existing schema moves unless you name it.

- **`"leaf"`** (default) — every leaf wrapped in the full envelope, one `sourceSpan` per field.
- **`"row"`** — leaves become plain nullable values (the envelope's `value`, without the wrapper),
  and one shared `sourceSpan` is added per row: the group object itself for a singleton group, or
  each element for a collection. That span is written under the fixed key `ROW_SOURCE_SPAN_KEY`
  (`"sourceSpan"`) — fixed rather than configurable, because the split, review, and every other
  consumer have to agree on the name of the one thing there is to agree on. A row also carries no
  `confidence`: the model isn't asked for one, and every key added is a key it spends tokens on.
- **`"none"`** — plain leaves, no citation anywhere. There's nothing to check, so nothing is claimed
  as grounded.

Declaring `"row"` on a group that isn't shaped like a row — a bare leaf with no object to hang a
shared span on, or a group that already declares its own field named `sourceSpan` — throws at schema
build time, naming the group, rather than silently falling back to something else.

## What it buys downstream

Review addresses every leaf by its own dotted path and requires an explicit decision for each one —
accepted, edited, or rejected — before a submission is allowed through at all; a leaf with no
decision is indistinguishable from a leaf the reviewer never saw, and the two must not read the
same. `spanGroundedness` is what a review card uses to decide how to present a leaf: an ungrounded
or near-miss citation is exactly the case that flag exists to surface, and because no decision can
be silently defaulted to "accepted," an ungrounded leaf can't simply pass through unactioned — a
human has to look at it and make a call, the same as any other leaf.

A `"row"` group reviews the same way a `"leaf"` group does — every field still gets its own
reviewable entry — except every field in one row points at that row's shared span, and its
groundedness is computed from it. `"none"` reads as ungrounded outright: there's no span to check,
so there's nothing to claim is grounded.

## Next

[Typesafety](/guide/typesafety) covers the derivation this page assumes — how `enveloped()` turns a
patch into an extraction schema in the first place. [Schema at Scale](/deep-dives/schema-scale)
covers the per-call ceiling that granularity interacts with, and
[Provenance: Measured](/deep-dives/provenance-measurement) is the full measurement behind everything
above.
