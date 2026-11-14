# @azx/ribo-cli

## 0.1.0

### Minor Changes

- 37dc625: The package grows the corpus surface (design §1): the generic, tool-agnostic corpus format a run
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
- ad22fb1: The package grows the eval runner (design §4): `runEval(corpus, chat, settings)` runs one arm over a
  validated corpus and resolves with one result per case — the extraction's own `fields`, its `raw`
  output and its `ExtractionUsage` (whose `calls` counts the retries), or the failure that ended the
  case. The corpus enters only through `loadCorpus`: the runner reads no corpus files itself and
  accepts no other corpus representation, so a run can never happen over a corpus that was not
  validated. An arm is an ordered ladder of core's `single-shot`, `per-group` and `presence-narrowed`
  strategies, optionally wrapped in the consensus modifier — the ladder is core's own
  `fallbackExtractor` over `terminalFallsThrough`, and the modifier is core's `consensusExtractor`
  over `unanimousValues`/`majorityValues`, so the runner holds no fall-through logic of its own. The
  settings are one plain JSON-able object (the ladder, the model, the consensus count and policy, the
  retry budget, the response cap, the split caps), passed in by the caller and stored verbatim by the
  records ticket; an absent option is not forwarded, so the strategies' own defaults apply. The
  prompt inputs are assembled from the corpus manifest: the instructions verbatim, the few-shot
  examples translated from the manifest's flat dotted-path map into the extraction target's shape
  (nested by group, each leaf enveloped), the `groupInstructions` map honoured per group, and the
  field-descriptions mode forwarded.

  `createOpenAiCompatibleChat` builds the backend client over `@azx/ribo-chat-openai` — the first
  runtime dependency this package takes, inlined into the single-file bin like the rest (ADR 0037).
  The refusals — an invalid settings object, a corpus holding a document case (document inputs are
  deferred to the T11 spike's follow-up, and a partially-run corpus would measure nothing), a schema
  the arm cannot drive, an example naming no leaf — fire before any model call and raise `EvalError`,
  which extends the package's could-not-run class, so the exit-2 mapping T9b wires covers them.

- 1683bf9: The `schema inspect` report counts schema **fields**, not provenance-envelope members: on an
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
- 1683bf9: The `ribo schema inspect` command grows its command surface (design §1/§4/§5/§8): a human
  rendering is the default and `--json` opts into the versioned JSON contract (byte-stable
  regardless of TTY or `NO_COLOR`); `--max-depth <n>` and `--max-piece-chars <n>` drive the
  report's threshold rows; a breached threshold is a new ran-and-failed-threshold exit code 1
  with the full report still on stdout and a one-line breach diagnostic on stderr; usage errors
  (unknown flag, surplus argument, non-integer threshold value) remap from commander's exit 1 to
  exit 2, keeping the could-not-run class distinct; no path with a TTY stdin is refused with
  guidance instead of a blocking read; every could-not-run message names the fault and its remedy
  — the unconvertible-document message now names `z.fromJSONSchema` as the limit and points at
  `docs/guide/from-a-schema.md` — and `--help` teaches the flags, examples and exit-code meanings.
- 1683bf9: The `ribo schema inspect` engine grows from the four-field skeleton report to the full sizing
  report of the schema-inspect design: leaf and group counts, the split path and call shape, whole
  and per-piece measures with the worst piece, per-strategy call counts (single-shot, per-group from
  a real `perGroupPlan`, the presence-narrowed upper bound, consensus per candidate), guidance
  coverage, a reformat-description lint, the full leaf-granularity violation list, a not-visible
  report, threshold comparisons, and a canonical schema fingerprint. `CONTRACT_VERSION` bumps to 2
  with the new fields. The loader now refuses a draft-2020-12-form document loudly — naming the form
  and `docs/guide/from-a-schema.md`, which gains the OpenAPI 3.0 export section — and the library
  zod-parses the serialized report (`SchemaInspectReportSchema`, exported) before returning it.
  `@azx/ribo-adapter-snuggpro` joins as a dev-only dependency for the conversion round-trip guard.
- 1683bf9: New package `@azx/ribo-cli` (ADR 0037): the workspace's first CLI tier package, shipping the `ribo`
  bin as a single-file ESM Node bundle with zod and `@azx/ribo-core` inlined. The skeleton implements
  `ribo schema inspect <path>` at skeleton depth: it reads a JSON Schema document in OpenAPI 3.0 form
  (from a file or stdin), converts it with `z.fromJSONSchema`, computes the `leafCount` measure with
  core's `walkLeafInventory`, and prints a versioned JSON report (`contractVersion`, `cliVersion`,
  `coreVersion`, `leafCount`) on stdout. Unreadable, empty, malformed or non-schema input is the
  could-not-run class: exit 2 with a diagnostic on stderr and nothing on stdout.

### Patch Changes

- dc5cd1c: `inspectSchema` no longer counts a row unit's own `sourceSpan` citation as a schema field: under row granularity the report's leaf count and guidance coverage now cover the real fields only, matching core's own field notion. The row-citation key is core's exported `ROW_SOURCE_SPAN_KEY`, dropped only on a row unit where core skips it, so a leaf field that happens to be named `sourceSpan` still counts. The adapter's entry covers the schema-artifact round-trip test's explicit timeout — no runtime change.
- a39efc5: `presenceNarrowedExtractor`'s fill phase now honours the same split caps the per-group strategy honours. It previously sent exactly one value-extraction call per group with present leaves, however large the group's narrowed schema — so under a byte-capped route (the Helix vendor cap of 32,768 serialized characters on the real Snugg Pro schema) it could send an over-cap call the per-group path would have partitioned, and the route refused it. The fill now narrows first and then splits each group's narrowed schema through the same `splitExtractionSchema` the per-group plan partitions with: `presenceFillPhase` (and the preset, which forwards it) takes `maxNullableUnionsPerGroup` (same default, `MAX_NULLABLE_UNIONS_PER_CALL`) and `maxSerializedCharsPerGroup` (same pass-through, off when absent). One fill item per piece, so a failed piece nulls only its own leaves under `onItemFailure: "skip"`, and a collection group's pieces zip back by instance index — presence still decides which leaves, never how many instances. Narrowing runs before the split, so a group with few present leaves still costs one call.

  `ribo schema inspect`'s `presenceNarrowedAtMost` moves with the fix: it is now the group count (presence, one call per group always) plus the split's own grouped-piece count under the reported caps — the all-present worst case the agreement test pins, partition included — instead of the old `2 × groupCount`. The JSON contract's shape is unchanged, so `contractVersion` stays at 3.

  The adapter's entry covers its new presence-narrowed cap test against the real schema and vendor cap — no runtime change.

- Updated dependencies [a39efc5]
- Updated dependencies [85e3505]
- Updated dependencies [85e3505]
- Updated dependencies [e76e1db]
  - @azx/ribo-core@0.2.0
  - @azx/ribo-chat-openai@0.2.0
