---
"@azx/ribo-cli": minor
---

The package grows the corpus surface (design §1): the generic, tool-agnostic corpus format a run
is measured over. `loadCorpus(corpusDir)` reads a corpus directory — a manifest, one directory
per case, a sparse map of expected answers — and returns it fully validated: the manifest, the
schema document as it was loaded, the converted schema, the leaf paths and group keys that schema
declares, and the cases sorted by case id. The manifest's schema reference resolves to a JSON
Schema document in OpenAPI 3.0 form and is converted through the same loader `ribo schema
inspect` uses, so the draft-2020-12 nullability form is refused rather than converted; the leaf
paths the expected answers are checked against are the ones the report's own field inventory
produces, never a second walk's. Every refusal names the file, the offending item and the fix,
and raises `CorpusError` — the could-not-run class the bin already maps to exit 2. The format's
two boundary schemas (`CorpusManifestSchema`, `CorpusCaseSchema`) and `resolveExpectation`, the
one implementation of the expectation precedence rule, are exported beside the loader, so a
writer and the loader cannot drift apart.
