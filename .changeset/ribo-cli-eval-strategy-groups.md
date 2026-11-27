---
"@azx/ribo-cli": patch
---

`ribo eval` no longer refuses a schema with top-level scalar leaves under the `single-shot`,
`per-group` or `planned` strategies: the presence-group derivation and its refusal now run only
when the selected arm includes `presence-narrowed`, whose refusal names the selected strategy,
states the schema fix in operator terms, and says the other strategies can run the schema as-is.
Per-group prompt sizing reads the split the run packs under instead of the presence walk.
