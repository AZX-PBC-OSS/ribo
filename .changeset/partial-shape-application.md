---
"@azx/ribo-extractor-openai": minor
---

**Adds `deriveExtractionShapePartially` — the shape applier's collecting surface — plus the
`PartiallyDerivedShape`, `ShapeRefusal`, `ShapeRefusalCause` and `ShapeRefusalClass` types.** The
throwing applier stopped at the first bad operation and zeroed the set; the partial surface reports
every refusal it can find in one pass, each carrying the caller's verbatim operation, its index, its
class, and the applier's own message — and applies the operations that survived, returning a full
`DerivedExtractionShape` (never a schema with holes: `assertShapeMapping` still runs). Applied and
refused partition the input exactly; `refusals` is empty if and only if the artifact is what
`deriveExtractionShape` returns.

Refusals are classified by what they are defeasible against: `local` (defective against the schema
alone), `consequential` (defective only because an applied operation removed or occupied the target
— `cause` names the culprit drop, or the caller's declaration when the conflict is with
`requiredOnCreate` / `identifyingFields` / `provenance`), or `set` (duplicates, a doubly-claimed
nest source, drops that together empty an object). The live-run motivation: one bad `retype` out of
91 proposed operations cost fourteen good nests, and the refusal named the retype rather than the
drop it conflicted with — the consequential class exists so a repair loop can tell which to retract.
Schema defects and declaration defects no applied operation explains still abort the derivation in
both surfaces: no operation subset repairs them, so no partial artifact can exist.

Behaviour changes to existing exports, honestly stated:

- **`deriveExtractionShape` is now a thin wrapper over the partial surface** — it throws the
  canonically-first refusal's message. Every single-refusal set (every case the suite pins) throws
  a byte-identical message; a multi-refusal set may name a different refusal than input order used
  to reach first, because the canonical order decides. That is a determinism fix, not a regression:
  the operations are documented as a set, and sequential drop application had a live
  order-dependence (`drop "a.b"` before `drop "a"` applied both; after, it threw not-found) that is
  now impossible.
- **`proposeShapeOperations`' repair turn carries every refusal at once** (one line per refusal, the
  applier's own message prefixed with the operation it names), so N bad operations cost one repair
  turn, not N.
- **`proposeShapeOperations` at repair exhaustion returns the final proposal's surviving operations
  instead of `[]`** — the exhaustion amendment ADR 0024 records against ADR 0016's pin. `[]` remains
  the value when nothing survived, and on the two transport-exhaustion exits (no proposal arrived to
  partially apply). The cost, accepted in the ADR: the check-the-array-for-`[]` diagnostic weakens,
  because a mostly-good proposal no longer announces itself as empty.
