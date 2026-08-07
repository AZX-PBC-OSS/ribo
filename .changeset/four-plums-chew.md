---
"@azx/ribo-core": minor
"@azx/ribo-adapter-snuggpro": minor
"@azx/ribo-extractor-openai": minor
---

`ToolAdapter` now carries two field shapes instead of one — a writable patch and a
derived extraction schema — because one type parameter was doing both jobs and nothing had
ever run the review-to-write path against a real adapter to notice.

**Breaking, `@azx/ribo-core`:**

- `ToolAdapter<F, C>` is now `ToolAdapter<V, C>`. **`schema` kept its name and changed
  meaning** — this is the migration hazard, because code built against the old contract
  still compiles and can now be silently wrong. It used to be the envelope-shaped extraction
  schema (`z.object({ rValue: Extracted(z.number()) })`); it is now the **writable patch**
  (`z.object({ rValue: z.number().nullable().optional() })` — every leaf optional, nullable
  where a null is meaningful). If your adapter's `schema` was written for extraction, move
  that schema to the new `extractionSchema` field and write (or derive) a patch schema for
  `schema` instead. The easy path: declare only the patch and derive the other with
  `enveloped(schema)` — this is what makes the two shapes agree by construction rather than
  by hand-maintained parallel structure.
- `ToolAdapter` gains two required fields: `extractionSchema` (what the model must produce —
  build it with `enveloped(schema)`) and `ctxSchema` (parses `Recording.ctx` into `C`;
  `Recording.ctx` crosses IndexedDB, so a type alone can't validate it).
- `write`'s signature is now `write(fields: V, ctx: C, meta: WriteMetadata): Promise<void>`,
  a required third parameter carrying `meta.idempotencyKey`. Send it as the
  `Idempotency-Key` header (or equivalent) on every write — it is stable across retries of the
  same queue item and is what lets a host tell a retried write from a duplicate one.
- `toWriteStep(adapter): WriteStep` is new. Per queued item it parses `item.recording.ctx`
  against `adapter.ctxSchema`, parses the reviewed values against `adapter.schema`, and calls
  `adapter.write` — this is where `schema.parse` finally runs as an actual trust boundary
  before a write, rather than only being documented as one. Any parse failure is terminal
  (not retried), since a bad ctx or a bad patch will fail identically next time.
- Review now addresses **flat dotted leaf paths** (`"healthSafety.ambientCo"`), not
  top-level schema keys. `ReviewFields` / `FieldDecisions` are `Record<FieldPath, ...>` rather
  than mapped types over your fields' keys, and each `ReviewField` carries its own leaf's zod
  schema for rendering and validating an edit. `buildReviewRequest` and `resolveReview` no
  longer take a type parameter for your field shape; `resolveReview` now validates every
  accepted/edited value against its leaf schema and rejects a submission whose path set
  doesn't match the request's (a decision-per-path guarantee the type system used to give for
  free and now has to be checked at runtime).
- **`ReviewOutcome` loses its type parameter.** Its `fields` is the reassembled nested
  `Record<string, unknown>` patch; your adapter's `schema.parse` (via `toWriteStep`) is what
  turns it into `V`. **`ReviewedValues<F>` is deleted** — it described the top-level-key model
  this replaces.

**Breaking, `@azx/ribo-adapter-snuggpro`:** the exported schema is split into a patch
(`snuggValuesSchema`) and a derived extraction schema (`snuggExtractionSchema`, built with
`enveloped()`); the local `Extracted()` helper is gone in favor of the derived one.
`snuggProAdapter.write` takes the new three-argument signature, and the adapter now exports a
`ctxSchema`.

**`@azx/ribo-extractor-openai`'s generics move.** `singleShotExtractor<V>` still takes your
patch type `V`, but everywhere the old code said `V` it now says `Enveloped<V>` — `normalize`,
the returned `Extractor`, and `ExtractionResult` all speak the enveloped shape, because that's
what actually comes back from the model. If you called `singleShotExtractor` with your
extraction-shaped type before, pass your patch type now and let the envelope be derived.

None of this changes the JSON Schema sent to the model — that's pinned byte-for-byte by a
characterisation test, specifically so this refactor couldn't also become a quiet
extraction-quality change.
