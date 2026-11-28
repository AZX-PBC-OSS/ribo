# @azx/ribo-cli

## 0.1.0

### Minor Changes

- 751402d: `ribo schema init` accepts a bare PDF as a sample: it loads as a one-input document sample named
  after the file, with `pageCount` measured from the file through the same pdf.js path eval uses and
  `capturedAt` stamped with the run instant (one per run) or an explicit `--captured-at <iso>`. An
  encrypted or unreadable PDF is refused naming the file; a file with PDF magic bytes but no `.pdf`
  extension is refused with a rename fix; with `--corpus`, one stderr line names the stamped files,
  the instant and the flag. No file timestamp and no PDF metadata date is ever read, and a case
  folder's declared capture block is passed through untouched.
- 5302513: The schema-inspect report contract is v5: every nullable call count carries the reason it is null, present exactly when the count is null, and a non-null count carries none. The single-shot reason is rendered from core's single-shot exclusions with the measured value and limit; the presence-narrowed reason is stated beside the missing bound and the spend guard reads it from the report; the human rendering prints `not selected — ` for single-shot and `unavailable — ` plus the reason for the rest.
- edaeb9b: The corpus's expectation entries gain optional `proposal` and `review` members (ADR 0049): a
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
- c9d5d1b: Adds `ribo corpus propose <corpus-dir> [case-id...]`: for every selected case, each schema leaf
  with no explicit entry and no covering default gets a pending expected-answer proposal — a value
  with evidence verified by code against the case's inputs, or a proposed absence — written into
  `case.json` in place, additively and atomically (only `expected` gains keys, every existing entry
  and default untouched, publication temp-file-then-rename). One model call per case that needs
  one; repeatable `--only <scope>` narrows the leaves asked; an upper-bound estimate summed over
  each case's own measured prompt goes to stderr before any backend is prepared, and `--max-spend`
  and `--yes` behave as on schema init — an over-ceiling run makes no request and writes nothing,
  with cheaper-fix advice selected by the backend (the CLI backends are never pointed at
  `--response-cap`). stdout is a versioned JSON report naming every selected case's outcome
  (proposed, nothing-to-propose, or failed with its unanswered leaves and reasons); stderr ends
  with the `ribo corpus review` handoff. Completed runs exit 0 even when cases fail; faults that
  stop the run exit 2 with stdout empty.
- 2f0c9b2: `ribo corpus review` records the review half of the proposal pass: with no action flag it prints
  the pending sheet — every pending proposal's value, quote and input, re-verified (`grounded`) and
  marked `literal` when the value itself occurs in its quote, collections row-major with proposed
  absences in their own block — and `--json` emits it as a versioned document for an agent
  reviewer. Decisions need a case id and exactly one action: `--confirm` (narrowable with
  repeatable `--leaf`) confirms only entries whose every value is literal in a still-grounded
  quote, printing what it left pending and why; a correction is an edit to `value` in `case.json`
  then `--confirm --leaf`; `--mark-absent --leaf` sets the entry declared-absent and confirms it;
  `--reject --leaf` removes the pending entry so the leaf resolves as the corpus otherwise would —
  through a covering default if one exists, else unmentioned. The `proposal` block is never
  modified, and every write goes through the guarded case writer, so only `expected` changes and
  only atomically. Ships a worked example corpus with proposals in every review state and a new
  "Reviewing proposed answers" section on the corpus page.
- 533fcd3: Eval records and reports disclose judged expectation origins and circularity (R8). A
  proposal-bearing corpus's record cells carry a `review` member — the review class and, for a
  proposal-bearing entry, the proposer's backend and model — and the record carries an
  `expectations` summary: judged cells by review class summing to the judged total, judged cells
  per proposer, and the count of accepted-unchanged cells whose proposer is the record's own
  backend and model. The stdout report's per-arm block carries the same summary, and stderr states
  that for the same-model cells the run measures agreement with the scored model's own proposal.
  Both members are additive at record version 1 and written only over a proposal-bearing corpus, so
  every existing record stays byte-identical.
- ebc3154: `ribo eval` now refuses to measure unreviewed proposals (ADR 0049's review gate, made binding). An
  expectation entry whose proposal is still `review: "pending"` scores as `unscorable` with the new
  reason `unreviewed-proposal` — a new member of the record schema's reason vocabulary, derived from
  the scorer's one list — while the cell still carries the proposed value and what the run produced,
  labelled with the reason. A pending proposal enters no rate, in extracted and failed cases alike.
  A corpus with no judgeable expectation at all — every entry pending, or no entries (a fresh
  scaffold) — is refused before transcription, the spend estimate and any model call (exit 2),
  naming `ribo corpus review` when proposals are pending and `ribo corpus propose` when the corpus
  holds none. A partly reviewed corpus still runs, printing one stderr line counting its pending
  cells and fully pending cases. This changes today's behaviour for an expectation-free corpus,
  which previously ran, spent and recorded nothing judged; corpora with at least one judgeable
  expectation load, score, fingerprint and record exactly as before.
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
- 6122497: `ribo schema init` reads a directory without `case.json` as one plain-folder sample named after the
  directory: its `.pdf`, `.txt` and `.md` files are its inputs, ordered byte-wise by file name
  (dotfiles skipped; any other extension, a subdirectory, an empty folder and a corpus root are
  refused by name, the corpus root with the fix "pass its case folders"). A folder's PDFs get the
  bare-PDF capture rule, and the command prints one stderr line per such sample stating the inferred
  order — `inputs` in the scaffolded `case.json` is where to change it. A directory with `case.json`
  behaves exactly as before.
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
- f469418: Add `ribo schema inspect --plan` for model-free planned reports, layout-aware thresholds and diagnostics, and ship a current plan with the basic example corpus.
- a98521c: Version the schema-inspection report as v4, adding core-identified planned semantic and packed-call measurements and explicit rule-based, planned, or shared threshold layouts while preserving synchronous no-plan inspection.
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
- 2019f7a: Add `ribo eval --plan` with shared reviewed-plan loading, early freshness and construction
  refusals, and runner-derived plan identity in version-1 records. Planned spend now uses core's
  cap-sensitive dry-run call counts and actual projected prompts, compare enforces planned identity,
  and the accuracy page displays that identity without changing ordinary eval startup or comparison
  axes.
- 1a350e9: Persist runner-issued semantic plan fingerprints in planned eval settings while keeping run records
  at contract version 1. Caller settings omit the runner-owned member, strict record reads enforce
  planned identity without changing existing non-planned records, and planned execution refuses
  before any model call until its execution path is available.
- 8898ebf: Execute planned eval ladders through core's `plannedExtractor`, with parsed plans supplied separately from JSON settings. The runner validates plan coverage and layout before transcription, derives the effective settings' fingerprint through core, and exposes `runEvalWithSettings` so record-building callers receive that identity; `runEval` remains the results-only wrapper.
- 4353be8: Add evidence-grounded schema initialization over named samples, with bounded repairs and deterministic OpenAPI 3.0 rendering verified through inspect.
- 072c3da: Install `ribo schema init` for evidence-linked schema drafting over text and case-folder samples, with conservative pre-chat spend ceilings, non-destructive schema output, atomic optional corpus scaffolds and explicit review/eval handoffs.
- 0366f24: Add a pure, model-injectable schema-planning API with validated repairs, incremental updates, and deterministic freshness guidance.
- 22c0ccc: Add the built `ribo schema plan` command for creating and incrementally updating schema plans, with non-destructive stdout/new-file output, local CLI or OpenAI-compatible backends, and shared worst-case spend ceilings.
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

- 73d4dc1: `ribo schema init` gains repeatable `--draft-from <sample>`: name the samples the draft reads, by
  loaded sample name and matched exactly as passed, while every passed sample still loads,
  transcribes and scaffolds as a case — draft from a few representative samples, scaffold the whole
  corpus in one command. Requires `--corpus`; a name matching no passed sample is refused before any
  spend, as is an unreadable non-drafting sample (every sample loads and transcribes before the
  estimate). Only drafting samples reach the prompt, the spend estimate and evidence validation, so
  evidence can never cite a sample the model was not shown; an estimate above `--max-spend` that drafts
  from more than one sample names
  `--draft-from` as a fix alongside raising the ceiling. Without the flag, prompts, estimates and
  output are unchanged.
- 283cfe8: `ribo schema init` now loads a case folder with any number of declared inputs as one sample, in
  the case's declared order — the multi-input corpus format ADR 0042 made standard, which init
  previously refused. A sample's text is the same marked join eval's `caseTextOf` produces, from
  one shared join function in `eval/case-text.ts`, so init drafts from exactly the text eval runs.
  **This breaks the `SchemaInitSample` shape**: the singular `source` (with its `file`, `bytes` and
  `capture`) and sample-level `kind` are replaced by an ordered `inputs` list, each entry carrying
  `file`, `kind`, `text`, `bytes` and an optional `capture`; `SchemaInitSampleSource` is removed and
  `SchemaInitSampleInput` is exported in its place. Evidence is matched per input under that
  input's own rule — exact for text and transcript inputs, the layout fold for documents — so a
  quote is accepted when any one input matches it, never against the joined text, never across
  inputs, and never on a capture marker line. A duplicate declared input file is refused before
  transcription, the same way the corpus loader refuses one. The scaffold writes every input in
  order, each document with its own capture block, and publication stays one all-or-nothing rename.

### Patch Changes

- 3ac16de: The handoff and the docs lead expected answers through propose and review (ADR 0049). `ribo schema
init`'s stderr handoff replaces "author them explicitly" with the expected-answers path — `ribo
corpus propose` (prefer a proposer that is not the model you will score) then `ribo corpus review`
  — keeps prompt instructions on their own line as the author's to write, and conditions eval on
  review; the command's help text and the root `--help` "Start here" line follow. The CLI overview
  drops its command count, adds `corpus propose` and `corpus review` to the command table, adds
  propose-and-review steps to both walkthroughs, and says to keep the drafted schema whole — a leaf
  the reviewer cannot judge is rejected and stays unmentioned. The planning and corpus pages' "what
  init scaffolds" passages now lead expected answers to propose and review while prompt instructions
  stay author-written, and the author's-judgement sentence becomes "confirmed by the author before it
  is scored". The README carries the same distinction.
- 3aea45a: The CLI docs lead with the authoring path: the overview and the README open with a "start from
  what you have" list (bare PDFs, a folder per job, an existing case folder, a hand-written schema;
  `--draft-from` to draft from a few while scaffolding all), and three decision guides join the
  shipped pages — when a plan is worth trying, what to author when a case's inputs disagree
  (`alternatives`, naming the authoritative input by marker id, or two leaves), and comparing across
  a corpus edit (what the corpus fingerprint covers, what it does not, and the clean fix). The root
  `--help` gains a "Start here" line naming `ribo schema init`.
- 8606411: Add the versioned schema-plan contract, exact inventory coverage validation and canonical browser-safe plan identity. Move the provenance-aware field inventory into core while retaining the CLI's existing import surface.
- 49f434d: Adds the guarded case writer the corpus proposal and review work will build on:
  `writeCaseExpected` edits an existing case.json's `expected` map and nothing else — every other
  member and key order survives, the result must re-parse as a case, an add-only mode refuses to
  change or drop an existing entry, and publication is a temp file then a rename, so a failed write
  leaves the original bytes intact with no stray file.
- e2267cb: The corpus gains its proposal engine and its collection-path walk. `proposeCase` asks a model,
  over an injected chat transport, for one case's unanswered answers and returns pending
  expectation entries: the model speaks a flat, code-owned proposal language (scalar items and
  collection rows — deliberately not the enveloped extraction schema, so the response format's
  depth and size never depend on the user's schema), code validates every item against the leaf
  inventory and grounds every quote against each input under the one rule `schema-init/validate.ts`
  applies, recording the earliest declared input whose own rule matches — the input name is always
  derived, never taken from the model. Collection cells pivot to the ordinal-keyed, leaf-major
  shape the scorer reads, with a leaf missing from one row omitting that ordinal and an empty
  collection a proposed absence. One bounded repair round answers an unparseable reply; after it
  a still-unparseable reply fails that case alone, while item-level problems drop their leaf into
  the result's unproposed list with a reason instead. `walkCollectionPaths` walks the corpus's zod
  schema and returns, for every leaf, the path of its nearest array ancestor (absent for a scalar
  leaf) — the one CLI-side answer to "which collection is this leaf under?", reused by the review
  sheet. The new exports are on the package's public surface.
- dc5cd1c: `inspectSchema` no longer counts a row unit's own `sourceSpan` citation as a schema field: under row granularity the report's leaf count and guidance coverage now cover the real fields only, matching core's own field notion. The row-citation key is core's exported `ROW_SOURCE_SPAN_KEY`, dropped only on a row unit where core skips it, so a leaf field that happens to be named `sourceSpan` still counts. The adapter's entry covers the schema-artifact round-trip test's explicit timeout — no runtime change.
- 13616f9: `stripOptionalNullable` now carries the description of the outermost optional/nullable wrapper that HAS one, at any depth of the chain — previously it read only the outermost wrapper. `z.fromJSONSchema` renders a property that is absent from its parent's `required` list and carries `"nullable": true` plus a `description` as `ZodOptional(ZodNullable(leaf))` with the text on the middle `ZodNullable`, so that description was silently dropped: `walkLeafInventory` reported the leaf as undescribed, and everything built from the walk — the field-guidance block rendered into extraction prompts, and `ribo schema inspect`'s guidance coverage figure — lost the text with it. The outer-described-wins rule is unchanged: when several layers carry a description, the outermost-described wrapper's text still wins. Schemas whose descriptions were already found (the outermost wrapper, or the inner type itself) behave exactly as before.
- a39efc5: `presenceNarrowedExtractor`'s fill phase now honours the same split caps the per-group strategy honours. It previously sent exactly one value-extraction call per group with present leaves, however large the group's narrowed schema — so under a byte-capped route (the Helix vendor cap of 32,768 serialized characters on the real Snugg Pro schema) it could send an over-cap call the per-group path would have partitioned, and the route refused it. The fill now narrows first and then splits each group's narrowed schema through the same `splitExtractionSchema` the per-group plan partitions with: `presenceFillPhase` (and the preset, which forwards it) takes `maxNullableUnionsPerGroup` (same default, `MAX_NULLABLE_UNIONS_PER_CALL`) and `maxSerializedCharsPerGroup` (same pass-through, off when absent). One fill item per piece, so a failed piece nulls only its own leaves under `onItemFailure: "skip"`, and a collection group's pieces zip back by instance index — presence still decides which leaves, never how many instances. Narrowing runs before the split, so a group with few present leaves still costs one call.

  `ribo schema inspect`'s `presenceNarrowedAtMost` moves with the fix: it is now the group count (presence, one call per group always) plus the split's own grouped-piece count under the reported caps — the all-present worst case the agreement test pins, partition included — instead of the old `2 × groupCount`. The JSON contract's shape is unchanged, so `contractVersion` stays at 3.

  The adapter's entry covers its new presence-narrowed cap test against the real schema and vendor cap — no runtime change.

- 38222c7: The CLI authoring workflow's references are finished and its composed behavior is proved on the
  installed artifact. The docs site's CLI pages (and their shipped copies) now walk the whole path —
  `schema init`'s samples, empty-expectation scaffold and output safety; the corpus-text handoff
  before expectations; both `eval --plan` usage refusals and the stale-then-construction refusal
  order with no artifacts left behind; the runner-derived, reorder-stable `settings.planFingerprint`
  at record version 1 and `compare`'s settings-axis treatment of it; and a planned arm's spend bound,
  derived from core's dry run over the plan under the run's own caps with every ladder rung, retry
  and consensus multiplier applied, refused before backend work when no safe bound exists. The pack
  tier runs the installed single-file bin against the shipped example's schema and plan, asserting
  the v4 report's layout, exact leaf coverage and core's `planFingerprint` — no live model anywhere.
- 869388a: Ship a README in the `@azx/ribo-cli` tarball — self-sufficient for someone with only the installed package: what the CLI is for, install and invoke (with the warning that `npx ribo` resolves an unrelated npm package), every command with its exit codes, and a documents-to-scores walkthrough over the worked example corpus the package now also ships under `examples/basic-corpus/`. Every command's `--help` now ends with a pointer to the new CLI section of the docs site (`/cli/` — overview, schema dialect, corpus format, scoring, spend). No behaviour change to any command.
- 97b5eda: `ribo eval` now unwraps recognised provenance envelopes in a loaded corpus schema through the same field-level walk as `ribo schema inspect`, before core derives the extraction shape. Core therefore adds one envelope per field, leaf descriptions remain available to prompt guidance, plain schemas are unchanged, and the run fingerprint still covers the raw `schemaDocument`. Regression tests over a grouped-and-collection fixture and the real Snugg schema prove that a double-enveloped value cannot arise through the fixed run path, rather than leaving the scorer to mistake one for an abstention.
- c1ba6f1: `ribo eval` no longer refuses a schema with top-level scalar leaves under the `single-shot`,
  `per-group` or `planned` strategies: the presence-group derivation and its refusal now run only
  when the selected arm includes `presence-narrowed`, whose refusal names the selected strategy,
  states the schema fix in operator terms, and says the other strategies can run the schema as-is.
  Per-group prompt sizing reads the split the run packs under instead of the presence walk.
- bf2f40a: Add an internal non-destructive operator output primitive for create and update commands, with artifact-only stdout, isolated review text, input preservation and staged no-clobber file commits.
- b2f759c: Add internal model-free planned schema inspection, including semantic and packed call measurements
  and unambiguous piece-character threshold selection.
- 4dd8330: Document planning and authoring end to end: a new Planning & Authoring CLI page, the installed README's full samples-to-compare walkthrough with the schema init / schema plan commands and the planned strategy, the report-v4 threshold-row contract in the schema page, planning pointers in command help, and the shipped planning page beside the example plan.
- da5479e: The CLI chat transports (`claude` and `codex` backends) now send the prompt to the child's stdin and close the pipe, instead of passing it as one argv argument — a large prompt (a big schema, a long document) no longer fails with `E2BIG` before any model call.
- fb1bd78: Add an internal schema-init sample loader for verbatim direct text and single-input case folders, sharing eval's document transcription path without changing corpus eval behavior.
- db7b3c8: Share operator backend preparation and fixed-call spend controls internally while preserving eval behavior.
- c4e0a8e: The spend estimate's retry multiplier names `--max-retries` and shows the sum it came from
  (`retries ×3 (1 + --max-retries 2)`), the `--max-retries` option help states its default and that
  the estimate multiplies by one plus it, and the spend doc's Retries bullet names the flag and
  default and notes the multiplier overcounts for single-shot rungs in the safe direction.
- Updated dependencies [e49c689]
- Updated dependencies [6fb69fe]
- Updated dependencies [8606411]
- Updated dependencies [5302513]
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
