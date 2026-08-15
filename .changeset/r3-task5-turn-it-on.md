---
"@azx/ribo-adapter-snuggpro": minor
---

Turn on the per-group extractor and guard the platform-route caps (R3 Task 5).

Export `SCHEMA_SERIALIZED_CHAR_CAP` (32,768) and `SCHEMA_NESTING_DEPTH_CAP`
(12) from `schema.ts`, carrying the vendor's own HTTP 400 error text in
their doc comments. A new test (`per-group-cap.test.ts`) asserts every
per-group schema serializes under the character cap and nests within the
depth cap — turning a production HTTP 400 into a failing build. The
nesting limit was checked before only against a different, stricter source
(OpenAI's documented 10-level ceiling); both limits named in the vendor's
error are now guarded against the vendor's own numbers.

The playground's live extraction path now constructs `perGroupExtractor`
with `snuggGroupInstructions`, not `singleShotExtractor`. The extractor
construction is factored into a testable `buildExtractorStep` factory; the
module singleton is preserved (both relays still share one step).
`singleShotExtractor` stays reachable as the alternative strategy and
Task 6's corpus baseline via `strategy: "single-shot"`. The
`ExtractorStatus` type gains a `strategy` field, surfaced in the UI banner.

No schema field-set change, no derivation change — the frozen JSON Schema
fixture in `extraction-shape.test.ts` does not move.
