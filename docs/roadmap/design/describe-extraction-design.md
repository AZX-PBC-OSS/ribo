# Design: `describeExtraction` — a dry run of the schema split

Status: Draft — for review, no implementation plan written yet.

A caller points ribo at their own zod schema, optionally reshapes it with shape operations
(`deriveExtractionShape`), and builds an extractor over the result. Whether that extractor will
construct, and how it will split the schema into calls, depends on facts the caller cannot see
without running it — and the failures for not knowing are silent or arrive at the provider as an
unreadable `400`. Spike 0006's investigations of the managed route's caps were paid for in probe
scripts (`docs/spikes/0006-managed-three-phase/` — `cap-probe.mjs`, `group-probe.mjs`,
`phase-cap-probe.mjs`, `property-cap-probe.mjs`, `root-probe.mjs`, `anyof-probe.mjs`), each asking a
slightly different slice of one question: what will this schema actually become?

This design answers that question with one synchronous, model-free helper — working name
`describeExtraction` — that reports, without constructing an extractor or calling a model:

- the schema's top-level keys, and for each whether it is a group or a loose leaf;
- which split path will be taken (grouped / flat) and, when flat, why — naming the loose keys;
- the piece count, and each piece's key, part index, nullable-union count and serialized size
  under the options given;
- whether construction will succeed, and if not, the same refusal construction would raise;
- when operations are supplied, the result of applying them first.

## 1. The problem, against the source

`splitExtractionSchema` (`packages/ribo-extractor-openai/src/schema/split-schema.ts:636-714`) takes
the grouped path only when **every** top-level key is a group: the `everyKeyIsGroup` test at
`split-schema.ts:656-659` peels each key's array wrapper (`groupCandidate`, `split-schema.ts:396-399`)
and asks `isGroupObject` (`split-schema.ts:591-592`). One loose top-level leaf makes that false, and
the whole schema goes down the flat fallback (`split-schema.ts:661-682`) — without a byte cap, one
entry keyed `""` carrying everything (`split-schema.ts:675-677`); silently, in both cases. A caller
who nested fourteen groups and left one leaf loose gets none of the grouping benefit, no complaint
says so, and the error they eventually see — a provider `400` about size or depth, or nothing at all
on a small schema — is never about nesting.

The caps behave the same way. The union cap is a library constant the presets always apply —
`MAX_NULLABLE_UNIONS_PER_CALL = 16` (`split-schema.ts:168`), defaulted by `perGroupPlan`
(`strategies/per-group.ts:354`), `schemaExtractor` (`strategies/schema-extractor.ts:254`) and
`scopedInstanceExtractor` (`scoped-instance/instance-fill.ts:459-465`) alike. The byte cap is an
option with no library default (ADR 0015), and a group over either cap is partitioned into pieces
sharing one key (`split-schema.ts:334-386`, `420-489`). A leaf that fits no piece fails the split at
construction (ADR 0013) — but only where the caller supplied the corresponding cap, and the
presets' defaults count as supplied. A caller cannot know which of these fires without reading the
splitter's source or scripting a probe.

## 2. Where it lives

In `@azx/ribo-extractor-openai`, as `src/schema/describe-extraction.ts`, exported from the package
root beside `splitExtractionSchema` (`index.ts:20-21`). No new package.

The deciding fact is §5's crux: the helper must share the split's code, and dependencies point
inward — core cannot import the extractor package, so a helper in core could only re-implement the
rules it exists to report. Core is also the wrong owner by ADR 0010's own bar: core takes what every
strategy over any transport needs (the chat seam, the phases, `groupedExtractor`'s engine — which
consumes an already-built `GroupMap` and has no notion of an `ExtractionGroup`); the split and its
piece vocabulary are this package's strategies' concern. ADR 0020 already schedules those strategies
to converge into `ribo-extractor-chat` on rename day; the helper moves with them, which is one more
reason it must not be a package of its own.

## 3. Inputs

The options mirror the split-affecting members of the real constructors — `perGroupExtractor`
(`strategies/per-group.ts:197,205`) and `scopedInstanceExtractor`
(`scoped-instance/instance-fill.ts:136,147`) — plus the derivation options, because the helper
applies operations first. The input schema comes in `schemaExtractor`'s two shapes
(`strategies/schema-extractor.ts:124-159`): a raw patch schema (derivation inside) or an
already-derived extraction schema (used as-is — enveloping twice double-wraps).

| Option                                                              | Mirrors                                                               | Notes                                                                                                                                                                                                                               |
| ------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema` XOR `extractionSchema`                                     | `schemaExtractor`'s two option shapes (`schema-extractor.ts:124-159`) | Exactly one. `operations` and `provenance` are only valid on the raw shape; supplying `operations` with `extractionSchema` is refused the same way `schemaExtractor` refuses both-or-neither (`schema-extractor.ts:213-218`).       |
| `operations`, `provenance`, `requiredOnCreate`, `identifyingFields` | `DeriveExtractionShapeOptions` (`shape/shape-operations.ts:37-56`)    | Forwarded whole to the real applier. `operations` and `provenance` affect the split through the schema they produce; the two declarations affect no splitting but ride the derived artifact so the report stays a complete dry run. |
| `maxNullableUnionsPerGroup`                                         | `PerGroupOptions.maxNullableUnionsPerGroup` (`per-group.ts:197`)      | Defaulted to `MAX_NULLABLE_UNIONS_PER_CALL` exactly as the presets default it (`per-group.ts:354`, `schema-extractor.ts:254`, `instance-fill.ts:459-465`).                                                                          |
| `maxSerializedCharsPerGroup`                                        | `PerGroupOptions.maxSerializedCharsPerGroup` (`per-group.ts:205`)     | Pass-through; absent means off (ADR 0015).                                                                                                                                                                                          |

No `chat`, no `model`, no timing knobs — the same cut `perGroupPlan` draws: the timing knobs are the
combinator's business and ignored at plan time (`per-group.ts:330-333`). An optional `name` is an
open question (§8).

## 4. The report

One result value, `ExtractionDescription`:

| Field       | Contents                                                                                                                                                                                                                                                                                      |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shape`     | The `DerivedExtractionShape` the real applier returned (`shape/derived-shape.ts:24-65`), when the raw input shape was used; absent for a passthrough schema. A describe-then-build caller wires this straight into `schemaExtractor`'s `extractionSchema` passthrough or `reshapedExtractor`. |
| `keys`      | One row per top-level key of the schema described (post-derivation): the key, and `group` or `loose` — answered by the shared classifier of §5, never by the helper's own walk.                                                                                                               |
| `path`      | `grouped` or `flat`; when flat, `flatReason`: "not an object", "empty", or the loose keys named.                                                                                                                                                                                              |
| `callShape` | `single-shot` or `per-group` — the selection `schemaExtractor` makes at construction by measuring the whole schema against both caps (`schema-extractor.ts:255-258`). Single-shot is a split answer too: one call, no pieces.                                                                 |
| `whole`     | The whole schema's nullable-union count, serialized character count and depth — the first two are the exact numbers the `wholeFits` selection reads (`schema-extractor.ts:255-258`); depth rides beside them, measured, never decided on (§6).                                                |
| `pieces`    | One row per piece: `key`, `part`, `parts` read off the split's own `ExtractionGroup` entries (`split-schema.ts:133-142`), plus `nullableUnions`, `serializedChars` and `depth` measured on each entry's schema. One row on the single-shot path — the whole schema, no part.                  |
| `refusal`   | Absent when construction would succeed. Present as `stage` plus `message`: the real error text verbatim, from the applier (`stage: "derive"`) or the split (`stage: "split"`). `pieces` is absent whenever `refusal` is present.                                                              |

Refusals are reported, not thrown (§8, question 3). Everything else in the report is present in
every case.

## 5. The crux: share the split, never re-implement it

A diagnostic that drifts from the real split is worse than none. The design rule is absolute:
**the helper may only report facts read off values the real path produced, measured by functions the
real path also uses, and refusals raised by code the real path runs.** Concretely, the helper is a
composition of things that already exist, in construction order:

1. **Derivation** (raw input only): `deriveExtractionShape` — the same applier, the same options
   bag, the same refusals (`shape/shape-operations.ts:100-103`). There is no second implementation of
   the operations to drift from, because there is only one.
2. **Classification**: the one genuinely new function, and it is extracted, not copied — a
   `topLevelKeyKinds(schema)` beside the split in `split-schema.ts` that answers, per top-level key,
   group or loose, and "not an object" / "empty" for the two pre-key fallbacks
   (`split-schema.ts:642-650`). `splitExtractionSchema` is refactored to derive its
   `everyKeyIsGroup` from that same function; the helper reports its answer. The question the split
   asks is asked once.
3. **The split itself**: `splitExtractionSchema`, called with the caller's caps under the presets'
   defaulting rule. A throw is caught and reported verbatim — ADR 0013's refusals
   (`split-schema.ts:354-362`, `446-465`, `531-545`) reach the caller through the same code that
   raises them, so the report cannot paraphrase a refusal into wrongness.
4. **Measurement**: per returned entry, `nullableUnionCount` and `serializedCharCount`
   (`split-schema.ts:222-234`) — the exported measures the packers themselves pack against
   (`split-schema.ts:437-441`) — plus the depth walk of §6. The packer measures the entry's own
   serialized form; the helper measures the same entry after the fact, so the numbers are the same
   numbers by construction.
5. **Call shape**: the `wholeFits` measurement (`schema-extractor.ts:255-258`) recomputed from the
   same two measures, in construction order — before the split, so a single-shot schema never
   reports a split refusal construction would never reach.

What the helper does not do: re-derive the group list, classify any key the shared classifier did
not answer, measure with its own walker, or build an entry of its own.

### The agreement test

`describe-extraction-agreement.test.ts`, in `packages/ribo-extractor-openai/src/schema/` beside the
other split suites. Its corpus covers every branch the split takes — object of groups, mixed groups
plus one loose leaf, flat object, non-object, empty object, collection groups, each across no caps /
union cap only / byte cap / both — and for each input asserts, against the real construction:

- no refusal: `perGroupPlan` over a fake chat (the `fakeChat` pattern of
  `strategies/per-group-plan.test.ts:97`) constructs, and its per-key piece counts match the
  report's; a `schemaExtractor` built over a counting fake chat runs one extraction, and its request
  count is one on the single-shot path and the reported piece count on the per-group path;
- refusal: the real construction throws, and the message equals the report's.

This is the test that fails if helper and split ever disagree — including the defaulting rule, since
it compares against `perGroupPlan`'s actual construction rather than the helper's reading of it.
Because the extractor package cannot import the adapter (dependencies point inward), the corpus is
synthetic; a second half of the same test lives beside the adapter's cap suite
(`packages/ribo-adapter-snuggpro/src/per-group-cap.test.ts`), which already imports the split
(`per-group-cap.test.ts:4`) and runs the identical comparison over the real `snuggExtractionSchema`.

## 6. Depth: measured, never capped

The report carries depth — per piece and for the whole schema — but takes no depth option.

**What is measured.** The depth of the piece's serialized JSON Schema rendering — the same
rendering `serializedCharCount` measures (`split-schema.ts:222-224`) — counting one level per
`properties` descent. That counting method already exists once in the repo, as the adapter cap
test's `maxNestingDepth` walk (`packages/ribo-adapter-snuggpro/src/per-group-cap.test.ts:46-57`);
the design lifts it beside `serializedCharCount` as an exported measure (`serializedNestingDepth`),
so library and adapter agree on what a "level" is instead of two walks diverging.

**A correction to the brief.** The brief describes a `schemaNestingDepth`/`SCHEMA_NESTING_DEPTH_CAP`
pair in the adapter's `schema.ts`. The source has the constant pair `SCHEMA_SERIALIZED_CHAR_CAP` and
`SCHEMA_NESTING_DEPTH_CAP = 12` (`packages/ribo-adapter-snuggpro/src/schema.ts:4544,4551`); the
depth walk lives in the adapter's test file, and no `schemaNestingDepth` symbol exists. The
constants are real and adapter-specific; the source wins, and nothing in the design depends on the
missing symbol.

**Why no cap option.** The helper may refuse only where the real path refuses. The split does not
pack against depth — the property-count, enum-value and nesting-depth caps are named in the same
route error and deliberately not packed against (`split-schema.ts:74-76`), and no extractor measures
depth at construction (`docs/guide/from-a-schema.md:100-104`: if your schema trips one of those,
narrow it — no call shape fixes it). A `maxNestingDepth` option that refused would make the helper
report refusals construction never raises — drift by design, the exact failure §5 exists to
prevent. So a caller-supplied depth cap does not fit as an option; it fits as a comparison the
caller makes themselves against the reported number. The adapter's 12 (`schema.ts:4551`) is the
worked example: the report tells them each piece's depth, and their suite already asserts pieces
under their cap (`per-group-cap.test.ts:78-89`). The asymmetry with the union cap is honest, not
inconsistent: the split packs against unions, so the helper reports them where the packing happens;
depth drives no packing, so it is reported as measurement only. ADR 0015's logic extends one cap
farther — the library carries no provider's depth number either.

## 7. If mixed schemas split later

When a future effort makes mixed schemas split properly — loose leaves partitioned beside groups
rather than collapsing the whole schema flat — `describeExtraction` needs no redesign: pieces, part
indices and measurements are read off the shared split, so the report changes with it, and the
agreement test fails until the helper states the new truth, because it compares against the real
construction. The one deliberate edit is to the classifier: a third per-key kind (a loose leaf that
will be carried in a piece of its own), so `flatReason` cannot name keys the new split no longer
treats as fatal. Nothing in this design's surface anticipates or blocks that effort.

## 8. Open questions

1. **An optional `name`.** `schemaExtractor` checks the wire-safe name charset at construction,
   before the split (`schema-extractor.ts:241`); a report that says "construction will succeed" is
   silent about that refusal. _Recommendation:_ accept `name` optionally, run the same
   `assertWireSafeSchemaName` when supplied, report a refusal with `stage: "name"` — the guard is
   shared, so no drift; absent, the report covers the schema-driven facts only.
2. **Carrying the derived artifact in the report.** `shape` makes describe-then-build use one
   derivation, but it also invites using a diagnostic's output as a construction input, widening the
   surface the applier already owns. _Recommendation:_ keep it; the artifact is already built, and a
   caller who re-derives anyway has paid the cost the field exists to avoid.
3. **Derive-stage refusals: report or throw?** They are programming errors in the real path (the
   caller's own `deriveExtractionShape` call throws), so throwing agrees with construction too.
   _Recommendation:_ report them (`stage: "derive"`) — a diagnostic whose first answer to a bad
   operation is an exception is a poorer diagnostic, and the refusals are exactly what a caller
   probing their operations wants spelled out.
4. **Piece leaf keys in the report.** `partitionedLeafKeys` (`per-group.ts:220-228`) is already
   public and reads them off an entry. _Recommendation:_ leave them out until reports are read
   without the entries in hand; add then, not now.

## 9. Must-fail tests

- A schema of two group objects plus one top-level string leaf reports `path: "flat"`, names the
  loose key in `flatReason`, and carries one flat piece holding the whole schema when no byte cap is
  supplied.
- A group whose single leaf costs 17 nullable unions against `maxNullableUnionsPerGroup: 16`
  reports a `stage: "split"` refusal whose message is `splitExtractionSchema`'s ADR 0013 error
  verbatim.
- The agreement test of §5: over the corpus and cap combinations, the report's piece sequence,
  `callShape` and refusal-either-way match what `perGroupPlan` and `schemaExtractor` actually build
  over fake and counting chats.
- A flat schema over a supplied byte cap reports flat pieces sharing `key: ""`, each with `part` /
  `parts` set and its own measured `serializedChars` under the cap.
- A raw schema with a drop removing one group reports the shaped keys without it; a drop naming a
  path the schema does not carry reports a `stage: "derive"` refusal with the applier's message.
- A deep-but-legal schema reports depth per piece and for the whole schema, reports no refusal, and
  the numbers match a hand walk of `z.toJSONSchema` output counting one level per `properties`
  descent.
- Describing with no caps supplied reports partitioning at 16 unions — the same default the presets
  apply (`per-group.ts:354`) — and the agreement test holds with the options bag left empty.
