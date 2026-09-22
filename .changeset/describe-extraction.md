---
"@azx/ribo-extractor-openai": minor
---

**Adds `describeExtraction`** — a synchronous, model-free dry run of the schema split, answering
before an extractor is constructed: the schema's top-level keys and their group/loose kinds, which
split path applies (and, when flat, which loose keys forced it), the single-shot-vs-per-group
selection, the per-piece nullable-union count, serialized size and nesting depth, and whether
construction would succeed — with the refusal (`derive`, `name` or `split` stage) carried
verbatim when it would not.

```ts
const report = describeExtraction({
  extractionSchema: target.extractionSchema, // or `schema` plus shape `operations`
  maxSerializedCharsPerGroup: 32_768,
});
if (report.refusal === undefined) {
  report.pieces; // one row per call the extractor would make
}
```

Everything reported is read off the code construction runs: the real `deriveExtractionShape`, the
split's own classifier, `splitExtractionSchema` itself under the presets' 16-union defaulting, and
the measures the packers pack against — so the answer cannot drift. A differential test suite
holds report and construction together over a corpus covering every split branch, with a second
half over the real Snugg Pro schema.

Two supporting exports land beside the split: `topLevelKeyKinds`, the classification
`splitExtractionSchema` now derives its grouped/flat gate from (behaviour unchanged), and
`serializedNestingDepth`, the nesting-depth measure lifted out of the adapter's cap suite so
library and adapter share one definition of a level. Depth is measured, never capped — the split
does not pack against it, so a route's depth limit stays the caller's comparison to make.

Implements `docs/roadmap/design/describe-extraction-design.md`; motivated by the live run that
paid six probe scripts for these answers (`nest-live-run-evidence.md` §8).
