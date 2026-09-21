---
"@azx/ribo-extractor-openai": patch
---

Four refusals in `@azx/ribo-extractor-openai`'s shape apply to mappings and
movements that were previously accepted (or accepted-then-blame-crash) by the
derivation or reversal:

- **An entry's two sides may not run under different collections.** A mapping
  whose extraction path crosses a collection its source path doesn't (or
  vice versa) used to slip past `assertShapeMapping`'s whole-array-set check
  on any pair of paths where the schemas' array SETs agreed, and reach
  reversal, where it crashed at the leaf-write merge with a `SchemaParseError`
  that falsely blamed bijection. The check is now per-entry, comparing the
  two sides' structural array-depth pattern (depths-from-leaf, in the right
  order). False-blame is gone; the construction refusal names both paths and
  the two disagreeing patterns. Direction: array-depth pattern.
- **A `regroup` may re-hang a subtree that contains an array.** The applier
  refused a move only when the move's own source or destination path passed
  _through_ or landed _on_ an array; re-hanging a subtree that merely
  _contained_ one was accepted, then crashed at the post-condition with a
  message about a different pair of schemas. The docs already promise
  "deepen, flatten or rename". Move is now supported as long as the
  array travels intact under its new prefix, and the post-condition follows
  the rename (its check is structural, not by path name).
- **Reversal's two structural failures throw `SchemaParseError` with the
  offending path, not bare `Error`.** A collection crossing the patch path
  has already passed, and a length-mismatch between two arrays that
  converged on one patch key, both used to throw plain `Error` — invisible
  to the same extractor ladder that falls through on `SchemaParseError`.
  Names the path the data stopped matching the schema, the same convention
  the leaf-envelope and leaf-collision throws use.
- **Two moves to the same destination is its own error, not "one under the
  other".** `isPrefixOf` says equal arrays prefix one another, so two
  distinct moves to the same destination tripped the prefix rule for moves
  whose indent paths happened to look nested, which is the wrong shape of
  failure. Add an independent same-destination check in `applyRegroup`'s
  destination loop, before the prefix check, that fails the pair with its
  own message naming both moves and the destination collision. The
  composition rule in `shape-operation.ts`'s header now lists "pairwise
  distinct" as its own line, with a paragraph explaining why an
  independent check is required (the `isPrefixOf` equal-arrays quirk).
