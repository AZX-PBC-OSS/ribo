---
"@azx/ribo-cli": minor
---

The `schema inspect` report counts schema **fields**, not provenance-envelope members: on an
enveloped extraction schema each `{ value, confidence, sourceSpan }` envelope is one field — the
count core's own group machinery splits by — so `leafCount`, `guidanceCoverage` and the
`reformatFindings` paths no longer inflate to three members per field (the Snugg schema reported a
third of its fields as the whole count, with `.value`-suffixed finding paths, when every field was
described). The command grows the two
split caps the report already accepted from the library: `--max-serialized-chars-per-group <n>` and
`--max-nullable-unions-per-group <n>` are fed into the split (unlike the thresholds, which only
compare), validated as positive integers with a usage error on anything else, named in `--help`,
and recorded in the JSON report as `splitCaps`. That field is a contract shape change:
`contractVersion` is now 3. The human rendering's title line ends its own line, and its labels say
"fields" where they counted leaves.
