---
"@azx/ribo-extractor-openai": patch
---

Fix `renderLeafInventory` on a flat schema.

`renderLeafInventory` bucketed entries by `entry.path.split(".")[0]` and
emitted a `- <bucket> (object|array)` header per bucket; a leaf whose
path had no dot ended up as a single-entry bucket of its own name, so
the renderer produced `- yearBuilt (object)` followed by
`    -  (string) — "..."` — a phantom header asserting the leaf is an
object and a leaf line with no name. On a real flat Snugg Pro schema
that was 294 phantom headers and 294 nameless lines, the prompt a model
reads to choose what to drop and retype.

Ground-level leaves (no dot in `path`) now render flat at the
inventory's top level: `- leafName (kind) — "description"`. Grouped
leaves (with a dot in `path`) keep the structural header. The renderer
no longer confuses "this is a group you can address" (the header's
purpose) with "this is a leaf at the root".
