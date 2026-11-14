# @azx/ribo-adapter-snuggpro

## 0.2.0

### Minor Changes

- 85e3505: Follow @azx/ribo-core's renames: `Recording` is now `AudioCapture`, `recordingSchema` is now `audioCaptureSchema` (and `baseRecordingSchema` is now `baseAudioCaptureSchema`), and `ChatRequest.response_format` is now `ChatRequest.responseFormat`. The wire schema types that model Snugg Pro's JSON keep their snake_case spelling, and persisted data is unchanged.
- 1683bf9: The package publishes its extraction schema as a JSON Schema document at the new subpath
  `@azx/ribo-adapter-snuggpro/extraction.schema.json` (OpenAPI 3.0 form — `nullable: true`, the
  dialect `@azx/ribo-cli`'s `ribo schema inspect` takes). The file is generated during the
  package's own build from `snuggExtractionSchema` with
  `z.toJSONSchema(schema, { target: "openapi-3.0" })` — the zod module stays the single source of
  truth and the file is never hand-edited. A round-trip test
  (`acceptance/schema-artifact-round-trip.test.ts`) guards the artifact: it asserts the generated
  file and the live zod schema produce one identical `inspectSchema` report, and is the guard to
  run on any zod bump (ADR 0039).

### Patch Changes

- dc5cd1c: `inspectSchema` no longer counts a row unit's own `sourceSpan` citation as a schema field: under row granularity the report's leaf count and guidance coverage now cover the real fields only, matching core's own field notion. The row-citation key is core's exported `ROW_SOURCE_SPAN_KEY`, dropped only on a row unit where core skips it, so a leaf field that happens to be named `sourceSpan` still counts. The adapter's entry covers the schema-artifact round-trip test's explicit timeout — no runtime change.
- a39efc5: `presenceNarrowedExtractor`'s fill phase now honours the same split caps the per-group strategy honours. It previously sent exactly one value-extraction call per group with present leaves, however large the group's narrowed schema — so under a byte-capped route (the Helix vendor cap of 32,768 serialized characters on the real Snugg Pro schema) it could send an over-cap call the per-group path would have partitioned, and the route refused it. The fill now narrows first and then splits each group's narrowed schema through the same `splitExtractionSchema` the per-group plan partitions with: `presenceFillPhase` (and the preset, which forwards it) takes `maxNullableUnionsPerGroup` (same default, `MAX_NULLABLE_UNIONS_PER_CALL`) and `maxSerializedCharsPerGroup` (same pass-through, off when absent). One fill item per piece, so a failed piece nulls only its own leaves under `onItemFailure: "skip"`, and a collection group's pieces zip back by instance index — presence still decides which leaves, never how many instances. Narrowing runs before the split, so a group with few present leaves still costs one call.

  `ribo schema inspect`'s `presenceNarrowedAtMost` moves with the fix: it is now the group count (presence, one call per group always) plus the split's own grouped-piece count under the reported caps — the all-present worst case the agreement test pins, partition included — instead of the old `2 × groupCount`. The JSON contract's shape is unchanged, so `contractVersion` stays at 3.

  The adapter's entry covers its new presence-narrowed cap test against the real schema and vendor cap — no runtime change.

- 34526b4: Refresh the Snugg Pro endpoint table from the live vendor spec: the report upsert now accepts `pageThermostatAuthorization`, `titleThermostatAuthorization`, `pageThermostatAuthorizationSigned` and `titleThermostatAuthorizationSigned`. The extraction schema is unchanged, so nothing new is sent unless a host supplies those values.
- Updated dependencies [a39efc5]
- Updated dependencies [85e3505]
- Updated dependencies [e76e1db]
  - @azx/ribo-core@0.2.0

## 0.1.0

### Minor Changes

- 7fba323: First release.

### Patch Changes

- Updated dependencies [7fba323]
- Updated dependencies [48c0647]
- Updated dependencies [c6e52d8]
  - @azx/ribo-core@0.1.0
