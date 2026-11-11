# Design: `ribo schema inspect` — sizing a schema before the first call

Status: Draft — the Tier 1 build tickets (T2–T6) implement this document; ADR 0037 ratifies the
package it ships in and ADR 0038 ratifies the input it takes.

A person adopting ribo arrives holding a JSON Schema document — exported from their host tool, an
OpenAPI spec, a database — and the first questions are all sizing questions: how many leaves and
groups does this schema carry, how deep is it against the route's depth cap, how will the split
partition it, how big is the worst piece, how many model calls will each strategy make. Today
those questions are answered by reading `split-schema.ts` or by scripting a probe against
`describeExtraction`. The library already answers them synchronously and without a model; what is
missing is a surface for the person who is not writing TypeScript against the library. This design
pins that surface: one command, `ribo schema inspect`, plus one importable entry with the same
input contract, a versioned JSON report, an exit-code table a script can act on, and — because a
sizing report that lies is worse than none — a provenance rule naming the core symbol behind every
number, and an agreement test per strategy proving the call counts are the counts a real run pays.

The Tier 1 invariant is stated here once and holds everywhere: **the inspect command makes no
model calls.** Everything it reports is computed from `describeExtraction` and `walkLeafInventory`,
both model-free by construction, and the call-count tests run strategies against stub chats, never
a transport (§10).

## 1. The command surface

The command path is `ribo schema inspect` (package and bin name: ADR 0037).

**Input.** One positional argument: a path to a file holding the JSON Schema document. When the
argument is absent, or is exactly `-`, the document is read from stdin. Both routes feed the same
parser; there is no third source and no flag selects the source.

**Flags.**

- `--json` — emit the versioned JSON contract of §7 instead of the human rendering.
- `--max-depth <n>` — a depth threshold. The caller supplies the number their route enforces (the
  Helix route's depth cap is the motivating case); the CLI only compares it against the depth
  `describeExtraction` measured. This matches the split's own contract — depth is measured, never
  capped, per the header of `packages/ribo-core/src/extraction/schema/split-schema.ts` — and
  ADR 0015's rule that the library carries no provider cap: the threshold is a comparison made on
  the caller's behalf, never an option fed into the split. Supplying it can no more change the
  reported partitioning than supplying no threshold.
- `--max-piece-chars <n>` — a worst-piece-size threshold, the same shape: compared against the
  largest `serializedChars` any reported piece carries, never fed to the splitter.

A threshold breach is **not** an error. The run still succeeds and the report is still complete —
the breach is a line in the report (and a field in the JSON), naming which measure breached which
threshold on which piece — and it selects the ran-and-failed-threshold exit code (§4), so a CI
step can fail on it while a human still reads the full report.

**Empty input is a failure.** Empty stdin, an empty file, or whitespace only is a could-not-run
error (§4), never a silent empty report: a report with no numbers in it looks like a schema with
no leaves in it, and those are opposite findings.

## 2. The importable library API

The bin is a thin shell over one importable entry, exported from `@azx/ribo-cli`. The entry takes
**the same JSON Schema document the bin takes — never a zod object.** Options carry the thresholds
and nothing else.

The reason is ADR 0038's whole point. A zod object cannot cross a process boundary, so the bin
could only ever see a document; an entry that accepted both would carry inputs with different
honesty properties — a zod object carries refinements and transforms a document cannot, so the
paths would silently report different things about "the same" schema. One input, one conversion
path, one set of caveats (§5). A caller who already holds a zod schema calls `z.toJSONSchema` with
the OpenAPI 3.0 target first — the docs page of §5 shows the one-liner — and then inspects the
document like anyone else.

## 3. What the report carries, and where each number comes from

The report's authority rests on one rule: **every number is read off a core symbol the real
extraction path also uses, and the doc names that symbol.** Nothing is recomputed by the CLI
except the threshold comparisons and the aggregates named below.

| Report number                                                                                                                                 | Source symbol and file                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Split path (`grouped`/`flat`), `flatReason`, `callShape`, refusal                                                                             | `describeExtraction` — re-exported at `packages/ribo-core/src/index.ts:809`, implemented in `extraction/schema/describe-extraction.ts`                                                                 |
| Whole-schema measures and per-piece measures (`nullableUnions`, `serializedChars`, `depth`), the piece list with keys, part indices and parts | `describeExtraction`'s `whole` and `pieces` rows — same symbols as above                                                                                                                               |
| Leaf count, and the description lint (leaves with no description)                                                                             | `walkLeafInventory` — re-exported at `packages/ribo-core/src/index.ts:987`, implemented at `extraction/shape/leaf-inventory.ts:77`; the lint reads each `LeafInventoryEntry`'s `description`           |
| Group count (top-level keys that are groups vs loose)                                                                                         | `describeExtraction`'s `keys` classification — the same shared classifier the split itself reads, so no second walk exists to drift                                                                    |
| Leaf-granularity violations                                                                                                                   | the logic of `assertLeafGranularity` — re-exported at `packages/ribo-core/src/index.ts:54`, implemented in `extraction/assert-leaf-granularity.ts`                                                     |
| Field-guidance coverage (described leaves over walked leaves)                                                                                 | `renderFieldGuidance` — re-exported at `packages/ribo-core/src/index.ts:698`, implemented at `extraction/field-guidance.ts:89`; its described-leaf filter over the walked entries is the coverage rule |
| Per-strategy call counts                                                                                                                      | the models of §9, each anchored in its own symbol                                                                                                                                                      |

Notes on that table.

**The violations list reproduces `assertLeafGranularity`'s logic rather than calling it.**
`assertLeafGranularity` throws on the first non-granular group; the report needs every violation,
so the CLI re-walks the schema with the same predicate (`isLeafGranular`,
`extraction/assert-leaf-granularity.ts:54`) and collects instead of throwing. That is the one
place the report runs logic the real path does not invoke directly, and it is guarded for exactly
that reason — the must-fail test of §11 asserts the CLI's violations list agrees with what
`assertLeafGranularity` refuses on the same schema.

**Coverage is a ratio the CLI computes from `renderFieldGuidance`'s own rule**, not a number that
symbol returns: the described-leaf filter over `walkLeafInventory`'s entries is the exact rule
`renderFieldGuidance` applies when deciding what reaches the prompt, so the coverage number
answers "how much of this schema's descriptions would ride along".

### The barrel question

The split's raw measures are not on core's barrel: `serializedCharCount`
(`extraction/schema/split-schema.ts:299`) and `nullableUnionCount`
(`extraction/schema/split-schema.ts:339`). The barrel re-exports from that module exactly
`MAX_NULLABLE_UNIONS_PER_CALL`, `serializedNestingDepth`, `splitExtractionSchema` and
`topLevelKeyKinds` (`packages/ribo-core/src/index.ts:791-803`), and nothing else.

**Verdict: no re-export is added.** The CLI never calls either raw measure: every reported
measure — nullable unions, serialized characters, depth, per piece and for the whole schema —
flows from `describeExtraction`'s `SchemaMeasures`, which already carries each of them in both
grain. Re-exporting the raw measures would widen core's public surface for a consumer that does
not exist, and the barrel was pruned of exactly that kind of export recently (#119, "Stop
exporting package internals no consumer imports"). If a future report needs a measure
`describeExtraction` does not carry, the fix is to teach `describeExtraction` to report it — the
agreement discipline of `describe-extraction-design.md` §5 then covers it for free — not to reach
past the description.

## 4. Exit codes

Each class below carries its own code, distinct from the others and never shared:

| Exit code | Class                    | When                                                                                                                                                                                                                                   |
| --------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`       | Success                  | The report was computed and no threshold breached. A refusal reported by `describeExtraction` (the split would refuse construction) is still a **successful** inspect: the refusal is a finding, in the report.                        |
| `1`       | Ran and failed threshold | The report was computed, and at least one supplied threshold was breached (§1). The full report is still emitted on stdout in both renderings.                                                                                         |
| `2`       | Could not run            | No report exists: unreadable file, empty input, malformed JSON, valid JSON that is not a JSON Schema document, an unconvertible document, or a refused draft-2020-12 document (§5). The diagnostic goes to stderr, stdout stays empty. |

The split between `1` and `2` is the load-bearing row: a script must be able to distinguish
"your schema is too big for your route" from "I never saw a schema at all" without parsing either
stream.

## 5. The schema-input contract

This section is the design face of ADR 0038.

**Form.** Input is a JSON Schema document in **OpenAPI 3.0 form** — nullability written as
`nullable: true`, not as `anyOf` with a `null` arm — read from a file or stdin per §1.

**Conversion.** The CLI converts the document itself, with `z.fromJSONSchema(document,
{ defaultTarget: "openapi-3.0" })` into its own zod copy, and ships **no custom converter**. The
option is verified against the pinned zod: the catalog holds zod exactly at the version whose
declaration carries `defaultTarget?: "draft-2020-12" | "draft-7" | "draft-4" | "openapi-3.0"`
(`pnpm-workspace.yaml:14`). A hand-rolled converter would be a second implementation of the
dialect to drift from — the same reasoning that bans a second schema walk anywhere else in this
repo. Why the OpenAPI 3.0 form and not the default draft-2020-12 rendering: it is what zod's own
exporter emits under the matching target option, so the round trip schema → document → schema
closes (§6), and it is the form host tools that speak OpenAPI already produce.

**The failure modes, each with an actionable message.** Every message tells the reader what was
wrong with _their input_ — naming the path, position or construct — never an internal stack frame,
never a zod internals dump:

| Fault                                             | The message must                                                                                                        |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| File not found / unreadable                       | name the path and the operating system's reason                                                                         |
| Empty input (empty file, empty stdin, whitespace) | say the input was empty and which source it was read from                                                               |
| Malformed JSON                                    | name the position the parser stopped at and show the offending neighborhood                                             |
| Valid JSON, but not a JSON Schema document        | say what was found instead (a bare array, a bare string, an object with no schema vocabulary) and what the CLI expected |
| A document `fromJSONSchema` cannot convert        | carry the converter's complaint, reworded to the input's vocabulary, with the construct named                           |

**The loud refusal.** A draft-2020-12-style document — nullability as `anyOf` with a `null` arm —
is **refused, never silently converted**. The message names the mismatch plainly (the document
speaks draft-2020-12 nullability; the inspect command takes the OpenAPI 3.0 form, `nullable:
true`) and points at `docs/guide/from-a-schema.md`, which will show the one-liner
`z.toJSONSchema(schema, { target: "openapi-3.0" })`. That page today covers the zod-native path
only — no `openapi-3.0` string appears anywhere in `docs/` (verified by grep) — so the section is
added by the same build ticket that implements the refusal message, in the same change, so the
message never points at a missing anchor. Silence is the enemy here: silently accepting an
`anyOf`-null document would guess at what the null arm means, and nullability is precisely the
rendering that shifts between zod versions — the catalog's own hold comment on zod
(`pnpm-workspace.yaml:14`) exists because the nullable rendering changes at the next minor.

**The honesty rule.** JSON Schema cannot carry zod's refinements and transforms — they do not
survive `z.toJSONSchema`, so the CLI's zod copy does not have them. The report says so: the
affected constructs are marked **not visible in the input**, and are never guessed, never
reconstructed, never silently dropped without a word. A sizing report that pretended the
refinements were there would be reporting on a schema the caller does not have.

## 6. The round-trip guard

The conversion rests on `z.fromJSONSchema`, and zod's own declaration of that function reads, in
the pinned version: "This function should be considered semi-experimental. It's behavior is
liable to change." That warning is the entire premise of the guard: the conversion's behaviour may
shift under us on a routine catalog bump, and nothing else in the suite would notice until a user
schema misreads.

The guard is the **Snugg round-trip equality test**: the adapter's real extraction schema
(`snuggExtractionSchema`, `packages/ribo-adapter-snuggpro/src/schema.ts:4786`) rendered with
`z.toJSONSchema` at the `openapi-3.0` target, re-read with `z.fromJSONSchema` at
`defaultTarget: "openapi-3.0"`, and asserted deep-equal to the original. It runs on **every zod
bump** — which in this repo is always a deliberate one-line catalog change, so the guard has a
review to fail in.

Where it lives: the CLI package's own test suite, with `@azx/ribo-adapter-snuggpro` as a dev-only
(test) dependency. The adapter stays free of CLI knowledge and the CLI stays free of a runtime
adapter import — the layering rule of AGENTS.md §3, with the test as the one legitimate consumer
on the boundary. The test is new work: the closest existing tests —
`packages/ribo-adapter-snuggpro/src/round-trip.test.ts` and the zod-parse round trip in
`schema.test.ts` — are not JSON-Schema round trips (verified).

## 7. The `--json` contract

`--json` emits one JSON document whose shape is **versioned**: a consumer scripts against the
contract version, and fields are added or reworded only with a version bump.

The contract names a version for each producer of its numbers — the contract itself, core and
the CLI — and each version has a stated source:

- **`contractVersion`** — the version of the JSON contract itself, owned by the CLI and bumped
  only when a field's name or meaning changes. Numbers computed by unchanged core symbols do not
  bump it.
- **`coreVersion`** — the version of `@azx/ribo-core` that produced the measures. Its source is
  core's `package.json` version, read at bundle time. Stated plainly, because it was a real
  question: `@azx/ribo-core` exports **no** version constant today — the only version constants
  on its barrel are each storage document version (`packages/ribo-core/src/storage/index.ts`) —
  and no build ticket is assigned to introduce one. If a constant appears later, this contract's source note changes with it; until then the
  `package.json` read is the answer, not an open item.
- **`cliVersion`** — the version of `@azx/ribo-cli` that produced the numbers, from the CLI
  package's own `package.json`, read at bundle time the same way.

Both bundle-time reads happen where the single-file bundle of ADR 0037 is produced, so the
published bin carries its own answers and never reads `node_modules` at run time.

## 8. Rendering: colour, pipes and `NO_COLOR`

The human rendering follows rules that cost nothing to keep:

- Under `NO_COLOR` (set to any non-empty value), no colour is emitted — the de-facto standard,
  same as every CLI the reader already uses.
- When stdout is not a TTY, no colour and no terminal control sequences are emitted, so piping the
  report into a file, a pager or a gist yields plain text.

Coloured and plain renderings carry **the same content**; only the dressing differs. `--json`
output is **byte-identical** regardless of TTY, colour environment or any future verbosity flag —
the JSON contract has exactly one rendering, which is what makes it scriptable (§7).

## 9. The per-strategy call model

The report carries a call count for each of the managed-LLM strategies below, and for no other
strategy; each count is computed from the symbol the real path itself reads — never from a
CLI-side re-derivation.

**Single-shot.** From `describeExtraction`'s `callShape` (`describe-extraction.ts:138`, selected
at `:353` by the same `wholeFits` comparison `schemaExtractor` makes at construction): when the
shape is `single-shot`, the strategy makes one request per attempt. The report says so from the
classification, not from an independent measurement of the schema.

**Per-group.** From the real `perGroupPlan` entry map (re-exported at
`packages/ribo-core/src/index.ts:834`, defined at
`extraction/strategies/per-group.ts:413`): one request per entry in the plan — one per group's
piece, plus the unwrapped `""` entry when the schema is mixed (ADR 0023). The plan is the same
value the real extractor runs from, so the count and the run cannot disagree by construction; the
CLI never re-counts groups itself.

**Presence-narrowed.** An **upper bound**, and worded as one everywhere it appears — the report
says "at most", in prose and in the JSON field's description, and never presents the bound as an
exact count. The composition is `presenceNarrowedExtractor` (re-exported at
`packages/ribo-core/src/index.ts:868`): a presence phase whose plan returns **one item per group,
always** (the file header of `phases/presence-phase.ts` states this as the phase's first named
shape), then a fill phase making one call per group with at least one present leaf
(`phases/presence-fill-phase.ts`). So the bound is: the presence phase contributes exactly one
item per group in the plan; the fill phase contributes at most one call per group, reached only in
the worst case where every group has a present leaf. The common case is cheaper — groups presence
found empty cost nothing in the fill — and the bound exists because the CLI cannot know presence's
answer without making the calls it exists to predict.

**Consensus.** The sum over candidates: `consensusExtractor` (re-exported at
`packages/ribo-core/src/index.ts:136`) runs every candidate and its usage is summed across the
survivors (`extraction/consensus-extractor.ts:330`), with the file's own warning as the rule —
"choosing candidates IS choosing a multiplier" (`:32`). The reported count is that sum's shape:
one attempt's count per candidate.

**Retries are reported separately, never multiplied in.** The report shows the attempt count
(what one successful run costs) and, beside it, the worst-case retry multiplier `1 + maxRetries`
— because `ExtractionUsage.calls` counts failed attempts by contract ("Model calls made,
including retries", `extraction/extractor.ts:42`), the phase engine defaults and per-phase
overrides live at `phases/phased-extractor.ts:198` and `:71-74`, and the schema-retry
combinator's own bound is the `maxRetries` option (`extraction/strategies/schema-retry.ts:103`).
One number that folded retries into the attempt count would be wrong in both directions at once:
too high when nothing retries, opaque about the knob when something does.

## 10. Agreement tests: the counts are what a run pays

The call model is only honest if the reported number equals what the real strategy actually
requests. For **each** strategy of §9, the CLI's suite carries a must-fail agreement test
in the idiom of `describe-extraction-agreement.test.ts` — whose header states the rule the CLI
inherits (§5 of `describe-extraction-design.md` is cited, not restated): run the **real** strategy
to completion over a counting `ChatClient` stub — the idiom of
`extraction/strategies/schema-extractor.test.ts:44`, requests pushed into an array as they arrive
— and assert equality between the CLI's reported count and the stub's observed request count.
Each test asserts a **positive equality**: the stub must have observed at least one request, so a
run that drives nothing can never pass vacuously.

- **Single-shot:** `schemaExtractor` over the counting stub makes exactly the reported one request
  per attempt.
- **Per-group:** `perGroupExtractor` over the counting stub receives exactly one request per entry
  of the reported plan — pieces and the unwrapped entry both.
- **Presence-narrowed:** the real composition (`presenceNarrowedExtractor` over core's
  `presencePhase` and the fill phase) run in the **all-present worst case** receives exactly the
  reported bound — the only case where the bound is an equality, and the case the test pins.
- **Consensus:** the real `consensusExtractor` over the counting stub receives exactly the
  reported sum across its candidates.

These tests run strategies against stubs, never a transport — the Tier 1 no-model-calls invariant
of the preamble holds inside the test suite too.

## 11. Must-fail tests

Beyond the agreement tests of §10:

- Empty stdin produces exit code `2` and a message naming the empty source — never an empty
  report on stdout.
- A malformed JSON document produces exit code `2` with the parser's position; a JSON array where
  a document was expected produces exit code `2` with the "not a JSON Schema document" message.
- A draft-2020-12 `anyOf`-null document produces exit code `2` with the refusal message, and the
  message names `docs/guide/from-a-schema.md` — this test fails if the docs section the message
  points at has not landed with the implementing ticket (§5).
- A schema whose zod form carries a refinement reports that construct as not visible in the input;
  the report never silently omits it.
- The violations-list agreement of §3: over a corpus of groups at each provenance granularity, the
  CLI's leaf-granularity violations list agrees with what `assertLeafGranularity` refuses on the
  same schema — the only place the report re-walks rather than calls, guarded against drift.
- The Snugg round-trip equality test of §6 fails on any zod bump that changes the OpenAPI 3.0
  conversion — it is the tripwire, and the semi-experimental notice is why it exists.
- The `--json` output is byte-identical with and without a TTY, and under `NO_COLOR` the human
  rendering contains no colour escapes.
- A threshold breach yields exit code `1`, the full report on stdout, and the breach named in both
  renderings.
