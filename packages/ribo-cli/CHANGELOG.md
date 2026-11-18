# @azx/ribo-cli

## 0.1.0

### Minor Changes

- d1683dc: A corpus case now declares its input files as a non-empty, ordered `inputs` list (each entry
  `{ file, kind }`, with a `capture` block on a document entry), joined into one text by core's
  transcript combiner and extracted once against the corpus's schema. **This is a breaking corpus
  format migration**: the old case-level `kind` with its implied single `input.txt`/`input.pdf` is
  refused, not auto-migrated, and every case must declare `inputs`. Capture markers
  (`===== CAPTURE seq:N kind:K id:I =====`) are prefixed to every input by default — one-input
  cases included — which changes the model-facing text and the corpus fingerprint of every
  migrated corpus; set `"combine": { "markCaptures": false }` in `manifest.json` (the option lives
  there, never on the CLI, because it changes what the model reads and so is corpus identity) to
  join with a single space and no markers. The corpus fingerprint now covers every input's bytes
  in list order plus the effective `markCaptures`, so reordering inputs or flipping the option
  stales a record. `ribo corpus text --json` emits contract version 2 with `{ caseId, text }`
  entries — a mixed-kind case has no singular kind — and the multi-case headers dropped the
  parenthesized kind for the same reason. The Snugg acceptance corpus is migrated to the new
  shape (its published adapter API is unchanged).
- c8c5461: The CLI-backed chat transport is now part of this package's public API. `cliChat` — with its `CliChatOptions`, `CliBackendName` and `CliShapeResult` types — moves here from the Snugg adapter's unpublished acceptance tree, where it was unreachable to a consumer; it shells the operator's own installed `claude` or `codex` binary, under the operator's own login, with no credential. `ajv` becomes a runtime dependency of this package, bundled into the single-file bin.

  `ribo eval --backend` now accepts `claude-cli` and `codex-cli` beside `openai-compatible`, and an unrecognised value is a usage error naming the three accepted ones. The two CLI backends need no credential: `OPENAI_API_KEY` is required by `openai-compatible` only. Before a CLI run starts, the command preflights the binary with `<binary> --version` and refuses up front — exit 2, a diagnostic naming the binary and the fix — when it is missing or does not answer, so a missing binary is never reported as a corpus fault or as a run in which every case failed. The run's report and every case's usage now name the backend that produced them.

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
- d873acc: Three fixes from dogfooding the CLI against a folder of PDFs.

  `ribo corpus text <corpus-dir> [case-id]` is a new command that prints the text each case's
  prompt carries — transcript and text cases verbatim, document cases transcribed through the same
  `transcribeDocumentCases` path `ribo eval` uses (one implementation, never a second pdf.js
  route). With a case id it prints that case alone; without one it prints every case under a
  per-case header; `--json` emits a versioned document of `{caseId, kind, text}` entries. It makes
  no model call and needs no credential, and it owns the same two exit codes (0 success, 2
  could-not-run). It is a `corpus` command group rather than an `eval` flag because it reads a
  corpus without running anything — the same reason `schema` is a group beside `eval`.

  `ribo eval --response-cap` with a CLI backend (`claude-cli`, `codex-cli`) is now refused up
  front — exit 2, naming the flag and the backend and saying to drop the flag, before the
  preflight, the corpus load and any model call. A CLI cannot cap generated tokens, and the
  capability is read from the transport's own descriptor, the same source `cliChat`'s own refusal
  reads, never a second hard-coded list. Behaviour without `--response-cap`, and with it on
  `openai-compatible`, is unchanged.

  The spend estimate now prices the run's `--model`. The price table gains dated per-model rows
  keyed by backend and model id for the models the help and docs mention, each with a source and a
  `pricedOn` date; a model with no row falls back to the backend's reference row, and the printed
  estimate says it fell back and names the reference it used — a model is never silently priced.
  The estimate remains an upper bound.

- 7785113: `ribo eval` — the command surface over the eval runner (design §6). It parses the run's flags into
  the settings object the runner takes, loads the corpus through the only loader that validates it,
  drives the run against the openai-compatible backend and writes the run's report to stdout.

  The flags are `--corpus <dir>`, `--backend <name>` (only `openai-compatible` today), the required
  `--model <id>`, the repeatable `--strategy <ids>` and `--out <dir>`, plus the run-settings flags
  `--consensus <n>`, `--consensus-arbiter <policy>`, `--max-retries <n>`, `--response-cap <n>` and the
  split caps `--max-nullable-unions-per-group <n>` and `--max-serialized-chars-per-group <n>` — the
  split caps reuse `ribo schema inspect`'s own flag spellings and its `parseCap` parser, so a bad
  cap value is refused the same way in both commands. One `--strategy` occurrence is one arm; a
  comma-separated value is that arm's ordered fallback ladder (`--strategy single-shot,per-group`).
  An absent flag is not forwarded, so the strategies' own defaults stand and the bin copies no table
  of defaults into the settings it builds. There is no `--schema` flag: the corpus manifest's schema
  reference is the only schema source.

  The command owns exactly two exit codes — 0 success, 2 could-not-run (a usage error, an unreadable
  corpus, an invalid setting, a missing credential) — with the diagnostic on stderr naming which and
  stdout empty on every exit-2 path. The endpoint and the credential come from the environment
  (`OPENAI_BASE_URL`, `OPENAI_API_KEY`); no credential-bearing option exists, and none may. A case
  whose extraction failed is report content, not an exit code. The report's shape is provisional
  until the scored contract and the run records land.

- 1a91bc9: The package grows the comparison: `compareEvalRunRecords` lines two run records up and reports
  which of the four identity fields — backend, model, settings, run fingerprint — they differ on
  (the axes, never refused and never silently equated), the leaf intersection with each side's
  exclusion counts, and every differing cell pair with both sides' persisted cells. It is the one
  comparison behind the new `ribo compare a.json b.json` command and behind a multi-arm `ribo eval`
  run's cross-arm summary, which the first arm's record is compared against each later arm's in.

  `ribo compare` reads exactly the two record files it is named, renders the terminal table by
  default and the versioned `--json` contract (its own `EVAL_COMPARE_CONTRACT_VERSION`, independent
  of the run record's) under `--json`, and owns the same two exit codes the other commands own — 0
  success, where a difference is a finding; 2 could-not-run, for a usage error, an unreadable or
  malformed record, differing corpus fingerprints without `--allow-corpus-mismatch`, or an empty
  leaf (and, under the override, an empty case) intersection. The comparison reads no corpus, no
  schema and no extraction internals: records only.

- 4109ca5: `ribo eval` runs document cases. Each case's `input.pdf` is transcribed under Node once per run — through the real `PdfjsTranscriber` over pdf.js's legacy build, resolved from the installed `pdfjs-dist` — before the spend estimate and any model call; every arm shares the text, and the estimate prices it like a transcript. A PDF with no text layer, or one pdf.js cannot open, refuses the whole run (exit 2) naming the case. New exports: `transcribeDocumentCases`, `DocumentTexts`, `DocumentTranscriptionOptions` and `RunEvalOptions`.
- 8cd38cc: The package grows the run record (design §4): the versioned, zod-parsed JSON document a run
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

- 2868ea3: The package grows the generic scorer (design §2): `scoreEvalRun(corpus, results)` judges one run
  against one loaded corpus, leaf by leaf, and returns a dense grid of per-cell verdicts beside the
  run-level totals. The corpus enters only through `loadCorpus`, and the leaf set is the one field
  inventory reports, so the scorer never carries a second field walk; the expectation precedence is
  the corpus's own rule, so a blanketed statement and a per-leaf statement resolve the same way
  everywhere. Each cell carries one of the verdicts in the exported `EVAL_VERDICTS` vocabulary —
  `correct`, `wrong`, `missed`, `hallucinated` and `unscorable` — with the expectation, the value
  the run produced, the corpus's own source span and where the expectation came from. Two values are
  the same answer when they are the same after a small, declared set of folds: case, whitespace and
  trailing punctuation; numbers, in digits or in words; booleans, and the string that spells one. An
  enum's members come from the schema, never from a hand-kept list, and a leaf's acceptable
  alternatives are honoured.

  The totals always carry the rates together — the answer rate, the accuracy over answered and
  the accuracy over all — because each of them reads as a contradiction when another is missing;
  a rate is null when its denominator is zero, never NaN and never absent. A failed case is scored as
  an empty extraction, so a run that produced nothing can never score better than a run that tried.
  `RETIRED_VERDICT_TRANSLATION` publishes the design's §3 table — the retired spike verdicts
  and the generic verdict each landed on — as the boundary that names the retired vocabulary
  once.

- fffcefa: Two fixes from the first real Snugg baseline, whose ~300K-token prompts timed every call out —
  and whose all-failed run still printed a high accuracy.

  `ribo eval --timeout <seconds>` sets the per-call timeout of the CLI backends (`claude-cli`,
  `codex-cli`), passed through `createCliBackendChat` to `cliChat`'s `timeoutMs`. The eval
  command's CLI-backend default rises from 120 s to 600 s; `cliChat`'s own default and the
  playground's `CLI_TIMEOUT_MS` are deliberately unchanged — they are the transport's and the dev
  server's knobs, not the eval command's. A non-positive or non-numeric value is a usage refusal
  (exit 2) naming the flag, and on `openai-compatible` the flag is refused up front — the HTTP
  transport has no per-call timeout to set — the mirror of `--response-cap`'s refusal on the CLI
  backends. The timeout error message names `--timeout` as the fix.

  A failed case no longer earns credit for silence: its declared-absent leaves are judged `missed`
  (they were `correct`), so every judged cell of a failed case stays in accuracy-over-all's
  denominator and never in its numerator, and a run where every case failed scores
  `accuracyOverAll` 0 instead of reading as accurate. Extracted cases score exactly as before. The
  record schema's shape is unchanged and `contractVersion` stays 1: no field's name or meaning
  changed — only the verdict a failed case's silent absence earns.

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
- 82b9701: Make `@azx/ribo-cli` workable from the installed tarball alone. The CLI's docs pages now ship inside the package (`docs/cli/`, a generated, drift-checked copy of the docs site's CLI section — the site sits behind a login), and the README and every command's `--help` name the installed pages first, the site URL second. Corpus and manifest enum refusals now name the allowed values and the value the file carried (`the field "provenance": expected one of real, synthetic, got "real-world"`). The shipped example corpus gains a document case (a one-page PDF with a text layer, its `capture` block and its expectations). `ribo eval`'s read of `--out` now skips files that are not run records — unparseable JSON, or a JSON value carrying neither `contractVersion` nor `capturedAt` — with one stderr line naming each, instead of refusing the run; a record-shaped file that fails the schema (a newer contract version or the retired old format included) is still refused exactly as before. The CLI's document transcription runs pdf.js at errors-only verbosity, so its harmless `Warning: …` lines no longer print; a genuine transcription failure still refuses the run. And `ribo schema inspect`'s granularity-violations line points at the shipped doc section that explains it.
- bc16f64: `ribo eval` — a pre-flight spend guard, and the secrets it reads.

  Every run now prints an upper-bound cost estimate to stderr before the first model call, and
  refuses the run — exit 2, the could-not-run code — when the estimate is above the ceiling. The
  two new flags are `--max-spend <usd>` (the ceiling; USD 10.00 by default) and `--yes` (proceed
  even when the estimate is above it). On a terminal the command asks instead of refusing outright;
  with no terminal it refuses rather than hanging on a question nobody can answer.

  The estimate's call model is inspect's own `describeCalls`, called once per run under the run's
  own split caps, so a tight byte cap changes the bound the guard reads. Every rung of an arm's
  ladder is counted (each rung can run and fail before the next starts), the consensus modifier
  multiplies the whole ladder, and the retry budget multiplies the result by `1 + maxRetries`. A
  bound the call model cannot state — a null `presenceNarrowedAtMost`, over a schema with no groups
  or a split that cannot fit a piece — refuses the run rather than coercing the null to zero or
  substituting another strategy's count, and no flag overrides that refusal. The tokens are measured
  from the prompts the run really sends, and priced from a dated per-backend table in this package;
  the two subscription CLI backends carry a stated token-equivalent assumption.

  The credential comes from the environment, or from the working directory's gitignored `.env.local`;
  the environment wins. A missing credential names the key and both places the CLI looked. No
  credential-bearing flag exists, and none may.

### Patch Changes

- dc5cd1c: `inspectSchema` no longer counts a row unit's own `sourceSpan` citation as a schema field: under row granularity the report's leaf count and guidance coverage now cover the real fields only, matching core's own field notion. The row-citation key is core's exported `ROW_SOURCE_SPAN_KEY`, dropped only on a row unit where core skips it, so a leaf field that happens to be named `sourceSpan` still counts. The adapter's entry covers the schema-artifact round-trip test's explicit timeout — no runtime change.
- 13616f9: `stripOptionalNullable` now carries the description of the outermost optional/nullable wrapper that HAS one, at any depth of the chain — previously it read only the outermost wrapper. `z.fromJSONSchema` renders a property that is absent from its parent's `required` list and carries `"nullable": true` plus a `description` as `ZodOptional(ZodNullable(leaf))` with the text on the middle `ZodNullable`, so that description was silently dropped: `walkLeafInventory` reported the leaf as undescribed, and everything built from the walk — the field-guidance block rendered into extraction prompts, and `ribo schema inspect`'s guidance coverage figure — lost the text with it. The outer-described-wins rule is unchanged: when several layers carry a description, the outermost-described wrapper's text still wins. Schemas whose descriptions were already found (the outermost wrapper, or the inner type itself) behave exactly as before.
- a39efc5: `presenceNarrowedExtractor`'s fill phase now honours the same split caps the per-group strategy honours. It previously sent exactly one value-extraction call per group with present leaves, however large the group's narrowed schema — so under a byte-capped route (the Helix vendor cap of 32,768 serialized characters on the real Snugg Pro schema) it could send an over-cap call the per-group path would have partitioned, and the route refused it. The fill now narrows first and then splits each group's narrowed schema through the same `splitExtractionSchema` the per-group plan partitions with: `presenceFillPhase` (and the preset, which forwards it) takes `maxNullableUnionsPerGroup` (same default, `MAX_NULLABLE_UNIONS_PER_CALL`) and `maxSerializedCharsPerGroup` (same pass-through, off when absent). One fill item per piece, so a failed piece nulls only its own leaves under `onItemFailure: "skip"`, and a collection group's pieces zip back by instance index — presence still decides which leaves, never how many instances. Narrowing runs before the split, so a group with few present leaves still costs one call.

  `ribo schema inspect`'s `presenceNarrowedAtMost` moves with the fix: it is now the group count (presence, one call per group always) plus the split's own grouped-piece count under the reported caps — the all-present worst case the agreement test pins, partition included — instead of the old `2 × groupCount`. The JSON contract's shape is unchanged, so `contractVersion` stays at 3.

  The adapter's entry covers its new presence-narrowed cap test against the real schema and vendor cap — no runtime change.

- 869388a: Ship a README in the `@azx/ribo-cli` tarball — self-sufficient for someone with only the installed package: what the CLI is for, install and invoke (with the warning that `npx ribo` resolves an unrelated npm package), every command with its exit codes, and a documents-to-scores walkthrough over the worked example corpus the package now also ships under `examples/basic-corpus/`. Every command's `--help` now ends with a pointer to the new CLI section of the docs site (`/cli/` — overview, schema dialect, corpus format, scoring, spend). No behaviour change to any command.
- 97b5eda: `ribo eval` now unwraps recognised provenance envelopes in a loaded corpus schema through the same field-level walk as `ribo schema inspect`, before core derives the extraction shape. Core therefore adds one envelope per field, leaf descriptions remain available to prompt guidance, plain schemas are unchanged, and the run fingerprint still covers the raw `schemaDocument`. Regression tests over a grouped-and-collection fixture and the real Snugg schema prove that a double-enveloped value cannot arise through the fixed run path, rather than leaving the scorer to mistake one for an abstention.
- da5479e: The CLI chat transports (`claude` and `codex` backends) now send the prompt to the child's stdin and close the pipe, instead of passing it as one argv argument — a large prompt (a big schema, a long document) no longer fails with `E2BIG` before any model call.
- Updated dependencies [13616f9]
- Updated dependencies [a39efc5]
- Updated dependencies [85e3505]
- Updated dependencies [85e3505]
- Updated dependencies [c8c5461]
- Updated dependencies [e76e1db]
- Updated dependencies [e76e1db]
  - @azx/ribo-core@0.2.0
  - @azx/ribo-chat-openai@0.2.0
  - @azx/ribo-transcriber-pdfjs@0.2.0
