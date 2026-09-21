---
"@azx/ribo-extractor-openai": patch
---

Group the flat `src/` into directories by concern, and split the oversized shape module.

`packages/ribo-extractor-openai/src` was one flat pile of 47 files covering
seven concerns. Files now sit in `shape/` (the derived-shape feature: the
operation vocabulary, the tree it runs over, the applier, the artifact pair,
the mapping, its reversal, the generator and the reversal combinator), `chat/`
(the two transports), `strategies/` (single-shot, per-group, schema-extractor,
schema-retry, instance-ladder), `scoped-instance/` (the Task 9/10 port:
inventory, instance-fill and its two phases), `gap-fill/` (the preset and its
phase), `prompt/` (extraction-common and project-target) and `schema/`
(split-schema). The grouping follows the dependency edges: `gap-fill-phase`
and `gap-fill`, and the scoped-instance trio, are mutually dependent, so each
port is one directory rather than split across a strategy/phase line.
`index.ts` and its test stay at the `src/` root.

`shape-operations.ts` (722 lines) splits along its own seams into
`shape-operation.ts` (the `ShapeOperation` union, with the original file
header verbatim), `shape-tree.ts` (the node tree and the zod rebuild) and
`shape-operations.ts` (the `deriveExtractionShape` entry point and the
operation-application helpers). The barrel still exports every name from
`shape-operations.ts`'s neighbourhood, repointed; `ShapeOperation` now comes
from `shape-operation.ts`.

No behaviour change, no renamed identifiers, no new exports: the barrel's
export list is identical (verified name-by-name against the pre-restructure
tree with the TypeScript compiler API — 102 names, both sides), and the
package's `exports`, `sideEffects` and tsdown entry map are untouched.
