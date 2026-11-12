---
"@azx/ribo-cli": minor
---

New package `@azx/ribo-cli` (ADR 0037): the workspace's first CLI tier package, shipping the `ribo`
bin as a single-file ESM Node bundle with zod and `@azx/ribo-core` inlined. The skeleton implements
`ribo schema inspect <path>` at skeleton depth: it reads a JSON Schema document in OpenAPI 3.0 form
(from a file or stdin), converts it with `z.fromJSONSchema`, computes the `leafCount` measure with
core's `walkLeafInventory`, and prints a versioned JSON report (`contractVersion`, `cliVersion`,
`coreVersion`, `leafCount`) on stdout. Unreadable, empty, malformed or non-schema input is the
could-not-run class: exit 2 with a diagnostic on stderr and nothing on stdout.
