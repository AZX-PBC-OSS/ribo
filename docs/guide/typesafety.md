# Typesafety

Ribo declares one schema and derives everything else from it. That is the whole story, and it is
worth being precise about, because the derivation is what keeps three very different consumers — a
model, a review UI, a write-back call — from quietly drifting apart from each other.

## One schema you declare: the values schema

You write exactly one zod object: the plain values a write actually needs. [Quick Start](/guide/quick-start)'s
`contactSchema` is one of these — four leaves, each `.nullable().optional()`:

```ts
import { z } from "zod";

const contactSchema = z.object({
  name: z.string().nullable().optional(),
  company: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
  followUpDate: z.string().nullable().optional(),
});
```

Internally this is called a **patch**, and both wrappers on every leaf are load-bearing, not
boilerplate. `.optional()` because a rejected field is simply absent when a write happens — the
patch has to tolerate a missing key. `.nullable()` because `null` is itself a meaningful value to
write: "there is nothing to record here," distinct from "leave this field alone." This is the only
schema you hand-write. Everything downstream is derived from it.

## The extraction schema is derived, never hand-written

What a model is asked to produce cannot be the same shape as the patch. `provenance.ts`'s
anti-hallucination rule needs every key present and every leaf wrapped in `{ value, confidence,
sourceSpan }`, with an explicit `null` where the model found nothing — an omitted key would be
indistinguishable from a field the model never considered. That is a **closed, fully required**
shape, which is the opposite of a patch's open, all-optional one.

`enveloped()` is the one supported way to get from one to the other:

```ts
import { enveloped } from "@azx/ribo-core";

const extractionSchema = enveloped(contactSchema);
```

It walks the patch's shape, strips the `.optional()`/`.nullable()` wrapper off each leaf, wraps
enum/literal/string/number/boolean leaves in the provenance envelope, and recurses into nested
objects and arrays — rebuilding every level as closed and required. Anything it can't express this
way (a record, a union of objects) throws immediately, naming the field path, rather than producing
a schema that fails opaquely once it reaches the model's structured-output API.

The reason this has to be a derivation and not a second hand-written schema is that a
hand-maintained pair drifts. Nothing stops someone updating `contactSchema` and forgetting the
extraction schema beside it — until the two disagree and extraction quietly stops covering a field
that review still asks about. `enveloped()` makes that drift structurally impossible: there is only
one place the extraction shape comes from.

`enveloped()` also takes a `provenance` option — per top-level group, `"leaf"` (the default),
`"row"`, or `"none"` — covered in [Important Defaults](/guide/important-defaults). Whichever
granularity a group is derived with, it's still one call, one schema, no second declaration.

## Review addresses flat leaf paths, each carrying its own schema

Once extraction produces a result, review needs to show a human every leaf, one at a time, with the
right editor and the right validation for that leaf specifically — not one editor for the whole
object. [`buildReviewRequest`](/guide/review) turns the values schema plus an extraction into exactly
that: a flat map
of dotted paths (`health.healthGasLeak`, `hvac[k1].hvacSystemEquipmentType` for a collection
instance) to a `ReviewField`, each one holding its own `schema: z.ZodType<unknown>` — the _declared_
type of that leaf, taken straight from the values schema you wrote, not the extraction schema and
not anything an adapter computed separately.

```ts
import { buildReviewRequest } from "@azx/ribo-core";

const request = buildReviewRequest(extractedValues, transcript, contactSchema);

// request.fields["company"].schema is the same z.string().nullable().optional()
// that contactSchema declared for `company` — nothing else.
```

This is what lets a review UI be generic: it renders a `ReviewField` by asking `field.schema` what
kind of editor to show, and it validates an edit by calling `field.schema.parse(...)` — without
importing a single line from any [`ToolAdapter`](/guide/write-back). A text leaf, a number leaf and
an enum leaf each
render themselves off their own schema; the UI never special-cases a tool's name or shape.

## Why `ToolAdapter` carries two field-shape parameters, not one

This is the part most likely to trip you up writing your own adapter, so it's worth spelling out why
it looks the way it does rather than the simpler way you might reach for first.

The real signature, from `@azx/ribo-core`:

```ts
export interface ToolAdapter<V extends Record<string, unknown>, C, P = NoProvenance> {
  readonly schema: ValuesSchema<V>;
  readonly extractionSchema: ZodType<Enveloped<V, P>>;
  readonly ctxSchema: ZodType<C>;
  readonly write: (fields: V, ctx: C, meta: WriteMetadata) => Promise<{ readonly uuid: string }>;
  // ...instructions, examples, requiredOnCreate
}
```

An earlier version of this design had a single field-shape parameter doing double duty: one schema
serving as both what gets written and what the model is asked to produce. It doesn't work, because
two genuinely different things happen to an adapter's fields, and one shape can't be both at once.
`schema` is the patch — the write-time trust boundary a reviewed submission is parsed through, open
and optional everywhere a rejected field needs to disappear cleanly. `extractionSchema` is the
model-facing shape — closed, fully required, every leaf enveloped. A single schema forced into both
roles is either too loose for the write boundary or too rigid for the model, and in practice it was
neither cleanly — the shapes only coincidentally look similar until you add provenance, at which
point they diverge on every leaf.

Splitting them into two parameters — with `extractionSchema` **derived** from `schema` via
`enveloped()` rather than declared independently — is what makes the two impossible to drift apart:
there's no second by-hand declaration for them to disagree in.

**What you'll get wrong if you don't know this:** writing `extractionSchema` by hand instead of
computing it with `enveloped(schema)`. It will typecheck if you're not careful (both are `ZodType`s),
and it will work fine until the day `schema` changes and `extractionSchema` doesn't — at which point
extraction and write-back silently disagree about what a field looks like, and nothing catches it
until a write fails or a review card shows the wrong editor. Always derive; never hand-declare the
second schema.

The third parameter, `P`, exists only because `extractionSchema`'s exact type depends on which
provenance granularity each group was derived with — a `"row"` group produces plain leaves plus a
row-level `sourceSpan`, which is a different shape than `Enveloped<V>`'s default all-`"leaf"` case.
Declaring it lets the adapter's `extractionSchema` type match what `enveloped(schema, { provenance })`
actually produced, instead of forcing a cast at the one boundary this whole design exists to keep
cast-free.

## Next

[Important Defaults](/guide/important-defaults) covers the behavior these types make possible —
what the [review gate](/guide/review) does with a `ReviewField`, and what governs the granularity
`enveloped()` derives with.
