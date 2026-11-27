---
"@azx/ribo-cli": minor
---

The corpus's expectation entries gain optional `proposal` and `review` members (ADR 0049): a
case file can now record that a model proposed an expectation — the proposing backend, model and
instant, the proposed status, and for an asserted proposal the proposed value with its
quote-plus-input evidence — and whether a reviewer has confirmed it. The two members must appear
together; either without the other is refused naming the leaf, and the loader refuses evidence
naming an input the case does not declare, a collection leaf whose evidence is not ordinal-keyed,
and a scalar leaf whose evidence is ordinal-keyed. `resolveExpectation` classifies each explicit
entry as `hand-written`, `pending`, `accepted-unchanged` or `corrected` — decided with the
scorer's own `sameAnswer` fold, in one place — and surfaces the proposer's backend and model.
The corpus fingerprint already hashed the expected map whole, so it now covers provenance and
review state with no fingerprint code change; a proposal-free corpus loads, scores and
fingerprints exactly as before, and the new schemas and types are exported from the package's
public surface.
