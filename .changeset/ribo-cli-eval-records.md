---
"@azx/ribo-cli": minor
---

The package grows the run record (design §4): the versioned, zod-parsed JSON document a run
persists, one per arm, under `./ribo-eval-runs/` beside the working directory or the directory
`--out` names. A record carries the corpus's identity — its name, its fingerprint over the cases
only, and its declared provenance — the run fingerprint, the backend, the model as its own field,
the run's settings as one object, the scorer's totals, the leaf set, the dense per-leaf-per-case
grid, and the lineage of the earlier records of the same measurement in the same directory. The
record is parsed on read and never cast, and a malformed record fails loudly rather than dropping
out of a lineage.

Three exported functions answer the freshness questions, and they are the one copy of that
arithmetic in the tree: `runFingerprint` hashes the schema document together with the prompt
inputs — canonically, so JSON key order and formatting never move it, and exactly, so even a
whitespace-only edit to the instructions does; `corpusFingerprint` hashes the corpus's cases only,
so it says "the same questions" where the run fingerprint says "asked the same way"; and
`recordIdentity` forms the key the backend, the model, the settings and the run fingerprint make,
which is what `isRecordCurrent` compares. A record is current only when all four match: a
fingerprint-only key would let a stale baseline pass as fresh, and a strategy-only key would call
two different measurements the same.
