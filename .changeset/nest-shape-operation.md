---
"@azx/ribo-extractor-openai": minor
---

**Adds `nest` to the shape-operation set** — `regroup`'s counterpart for a flat schema. Where
`regroup` re-nests leaves inside an existing top-level group, `nest` creates a NEW top-level group
and moves top-level leaves into it:

```ts
const shape = deriveExtractionShape(flatSchema, {
  operations: [
    {
      op: "nest",
      group: "construction",
      moves: { yearBuilt: "yearBuilt", squareMeters: "area.squareMeters" },
    },
  ],
});
```

The evidence is spike 0009: pointed at a real 294-property flat POST body, the model proposed 19
`regroup`s and 18 were refused because a flat schema has no group to move anything into. The
structural intuition was right; the vocabulary could not express it.

What a nest buys is extraction-side structure: the extraction schema carries the new group as a
subject instead of loose fields. The new group also becomes its own `splitExtractionSchema` entry
— its own call, its own prompt assembly — but **only when the nests cover every top-level key**:
the split's gate is `everyKeyIsGroup`, so one unmoved top-level leaf collapses the whole schema to
the flat fallback. ADR 0022 records that limit and names the splitter work that would lift it.

The derived patch is byte-identical after a nest, so review
still renders the moved leaves at their flat paths, and `requiredOnCreate`, `identifyingFields`
and provenance cannot be declared on the new group (the derivation refuses the last, naming it).

Sources are restricted to top-level LEAVES — never a group, a collection, or a nested path — which
is what makes the top-level-boundary crossing safe: a top-level leaf has no group and no row span
to strand. `assertShapeMapping` relaxes its top-key check for exactly this case (single-segment
source, both tops `"leaf"`-granular, the extraction top synthetic) and refuses every other
crossing as before, and `reverseShapedFields` now roots patch-side writes at the source's
top-level key — a correction any hand-written cross-top mapping needs.

`proposeShapeOperations` can emit `nest` too: the proposal schema carries it with the same
wire-format `moves` array as `regroup`, and the directive tells the model the restriction.

ADR 0022 records the decision.
