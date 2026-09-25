---
"@azx/ribo-core": major
---

`projectTarget` narrows an `ExtractionTarget` to one top-level group key, returning an `ExtractionTarget<Pick<V, K>>` whose schema, examples, and instructions are projected to that group.

`buildGroupMessages` is re-expressed over `projectTarget` so a projected target can be handed to any strategy rather than only the internal per-group loop. The messages it emits remain byte-identical across partitioned pieces, singleton mode, and the non-grouped fallback.
