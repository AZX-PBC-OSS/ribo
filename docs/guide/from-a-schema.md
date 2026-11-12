# From a Schema

You have a zod schema — one you wrote, or generated from a database, an OpenAPI spec, a TS
interface. This page is the path from that schema to a parsed extraction, using nothing but public
exports. The two places people get stuck — the derivation step and a route's schema caps — are
handled for you or named plainly below.

## The short path

Hand the **plain patch schema** (leaves written `X.nullable().optional()` — "may not have been
said"), a chat client, and a model, to `schemaExtractor`:

```ts
import { z } from "zod";
import { isSpanGrounded, schemaExtractor } from "@azx/ribo-core";
import { openAiChat } from "@azx/ribo-chat-openai";

const visitSchema = z
  .object({
    visit: z
      .object({
        summary: z.string().nullable().optional(),
        durationMinutes: z.number().nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const extractor = schemaExtractor({
  schema: visitSchema, // the schema YOU wrote — the derivation runs inside
  name: "service-visit", // the structured-output name; see the charset rule below
  instructions: "Extract the visit fields. Quote spans verbatim.",
  chat: openAiChat({ apiKey, baseUrl }),
  model: "gpt-5.6-sol",
  // Your route's serialized-schema ceiling, from its own error text. See "The caps".
  maxSerializedCharsPerGroup: 32_768,
});

const transcript = { text: "Checked the furnace, took about 45 minutes.", annotations: {} };

const { fields } = await extractor.extract(transcript);

// Every leaf arrives as { value, confidence, sourceSpan }, and the span is checkable:
isSpanGrounded(fields.visit.summary.sourceSpan, transcript.text); // true
```

One wiring wrinkle: a Helix dev token is **origin-scoped** — the route rejects a request without
its registered `Origin` header — and `openAiChat` has no origin option, because a deployed app's
edge derives it from the session. For a dev token, inject it through the `fetchImpl` option:

```ts
const chat = openAiChat({
  apiKey,
  baseUrl,
  fetchImpl: (url, init) =>
    fetch(url, { ...init, headers: { ...init?.headers, origin: "http://localhost:5173" } }),
});
```

What ran inside that one constructor:

- **The `enveloped()` derivation.** A plain zod schema is not a valid extraction schema — every
  leaf must carry its provenance envelope (`{ value, confidence, sourceSpan }`), and every group
  key must be required so a model cannot omit a field and masquerade absence as an answer. The
  entry point derives all of it from your patch. If you already hold a derived schema, pass it
  under `extractionSchema` instead of `schema` — it is used as-is, because enveloping twice
  double-wraps. Per-group provenance granularity (`"row"`/`"none"`) is the `provenance` option;
  [Provenance](/guide/provenance) explains the trade.
- **The call-shape selection.** If the whole derived schema fits under the caps, one call does the
  work (single-shot measured at the accuracy floor on our Snugg Pro corpus, route and model —
  a measurement, not a general law). Past the caps, the schema is split per top-level group and
  one call runs per piece, merged back into one result. The selection happens at construction, by
  measurement — no model call is spent deciding.

Already have an `ExtractionTarget` (from a [`ToolAdapter`](/guide/write-back))? The presets below
it — `singleShotExtractor`, `perGroupExtractor` — take one directly;
[Per-Group Composition](/guide/per-group) starts there.

## The caps

Two caps bind a structured-output call, and they fail differently:

- **Nullable unions** — one model family on the managed route rejects a response schema carrying
  more than 16 (`16 accepted, 18 rejected`); an enveloped leaf costs two. This cap has a default
  (`MAX_NULLABLE_UNIONS_PER_CALL`), measured on that route, honestly labelled as not an
  established vendor limit. Override it with `maxNullableUnionsPerGroup`.
- **Serialized size** — the route rejects a schema whose JSON Schema serializes past a character
  ceiling with `400: schema must serialize to <= 32768 characters and nest <= 12 levels`. This
  number is named by ONE route's error text and differs by route, so **the library carries no
  default for it** — you supply it (`maxSerializedCharsPerGroup`), because you chose the chat
  client that knows the route. The example above passes the Helix route's own number.

Either cap being exceeded partitions the schema into pieces that each fit. A single leaf that
cannot fit any piece — its own serialized size over the cap — fails at construction, naming the
group, the measured size, the cap and the option: there is no partition that could have worked,
and a construction error beats a `400` from the route that reads identically to every other
schema rejection.

Three caps exist that the split does NOT pack against, because no partition of a schema helps
them the way it helps bytes and unions: the structured-output **property-count** and
**enum-value** caps (documented in [Schema at Scale](/guide/schema-at-scale)) and the
**nesting-depth** cap named in the same error text. If your schema trips one of those, narrow
it — no call shape fixes it.

To know which side of every cap your schema lands on before building anything,
`describeExtraction` dry-runs all of it — the split, the call-shape selection, the per-piece
measurements, and the refusal construction would raise — synchronously and without a model.
[Schema at Scale](/guide/schema-at-scale#ask-before-you-build-describeextraction) has the
walkthrough.

## Sizing a document: `ribo schema inspect`

The `ribo` bin takes a JSON Schema **document**, not a zod schema — the form a host tool, an
OpenAPI spec or a code generator produces. The inspect command takes that document in the
**OpenAPI 3.0 form**: nullability written as `nullable: true`, not as `anyOf` with a `null` arm
(the draft-2020-12 rendering). Zod's own exporter emits that form under the matching target
option, so the path from a zod schema to a document is one line:

```ts
const document = z.toJSONSchema(schema, { target: "openapi-3.0" });
```

Write it to a file and size it before the first call:

```sh
ribo schema inspect schema.json
```

A document that speaks draft-2020-12 nullability is refused loudly rather than converted — the
message names the form and points back at this page. The refusal is deliberate: nullability is
precisely the rendering that shifts between zod versions, and silently guessing at what a null
arm means would size a schema the caller does not have.

The `target` is the whole difference: without it, zod emits the draft-2020-12 form — a nullable
leaf as `anyOf` with a `null` arm — which the CLI refuses outright, and which
`z.fromJSONSchema` would read back as unions, so the document would no longer describe the
schema's nullability at all. With it, the same leaf renders as `"nullable": true`, the form
OpenAPI 3.0 and this CLI share.

### The Snugg adapter's published document

`@azx/ribo-adapter-snuggpro` ships its extraction schema as exactly this kind of document:
`@azx/ribo-adapter-snuggpro/extraction.schema.json`. It is generated during the package's own
build from `snuggExtractionSchema` (the zod module is the single source of truth — the file is
build output and is never hand-edited), with the target written explicitly in
`generate-extraction-schema.mjs` (ADR 0039). If you need the same document for a schema of your
own, the same one line produces it.

### Sizing the shipped file in CI

The same command sizes the **installed** document, which makes it a CI gate for schema fit: a
schema edit that pushes the document past a route cap reddens CI instead of surfacing as a `400`
in the field. Resolve the file through the package's own export subpath — never hardcode a
`node_modules` path, which rots across package managers:

```js
import { fileURLToPath } from "node:url";

const schemaPath = fileURLToPath(
  import.meta.resolve("@azx/ribo-adapter-snuggpro/extraction.schema.json"),
);
```

Then run the command with both thresholds supplied:

```sh
ribo schema inspect "$schemaPath" --max-depth 14 --max-piece-chars 32768
```

The thresholds are comparisons the CLI makes on the reported numbers — supplying them never
changes the partition. The two **split caps** do: `--max-serialized-chars-per-group <n>` and
`--max-nullable-unions-per-group <n>` are forwarded into the same split the extraction runs under,
so the command reports the partition your route would actually produce. Both are validated as
positive integers (anything else is a usage error, exit 2), and the `--json` report records the
caps the partition was computed under (`splitCaps`, the union default included), so the numbers can
be reproduced without re-deriving the defaults.

The report's `leafCount` counts schema **fields**: on an enveloped extraction schema, each
`{ value, confidence, sourceSpan }` envelope is one field — the same count core's group machinery
splits by — and `guidanceCoverage` is described fields over that count, never envelope members.

The exit codes are the contract for wiring it into your CI: **0** — the report was computed and
neither threshold was breached, the schema fits; **1** — a threshold was breached, with a one-line
diagnostic per breach on stderr and the full report still on stdout, so the log names the measured
number against the limit; **2** — the command could not run (unreadable file, malformed JSON, not
an OpenAPI-3.0-form document, a usage error), which in CI means a broken input, not an over-cap
schema.

One honest caveat before you copy the numbers: the route's documented caps (`nest <= 12 levels`,
`<= 32768 characters`) bind the **per-call pieces** the split produces, while `--max-depth`
measures the **whole derived schema** the report describes — a different measure that can read a
couple of levels deeper than the per-piece number. Take your CI pin from a first measured run of
the command against your document, not from the vendor's per-piece figure. This repo's own
`snugg:inspect` stage in `check.sh` is the worked example: it runs the built bin against the
Snugg adapter's generated document with the pins on the stage line, and fails the build on a
breach.

### The zod pin, and the guard to run on a bump

Zod is held at `4.4.3` in `pnpm-workspace.yaml`'s catalog — from 4.6, `toJSONSchema` renders a
nullable leaf as `type: [x, "null"]` instead of `anyOf`, which changes the wire schema and its
measured depth (see the hold comment at the pin itself). Because `z.fromJSONSchema` is marked
semi-experimental upstream, any zod bump must run the round-trip guard that pins this document:
`packages/ribo-adapter-snuggpro/acceptance/schema-artifact-round-trip.test.ts`, which asserts
the generated file and the live zod schema produce one identical `inspectSchema` report. If it
goes red after a bump, the rendering changed — re-pin deliberately, with the wire form and the
depth tests that pin the new shape.

## The name is on the wire

A structured-output schema name is constrained to `[A-Za-z0-9_-]` by at least one platform route —
Helix rejects a colon with a generic `400 validation_failed`, which reads identically to an
over-cap schema and costs an afternoon to tell apart. Every name sent to the route is built from
your `name` plus the schema's own group keys, and each is checked at construction: a colon in
either throws immediately, naming the character. Per-group calls append `-<groupkey>` and a
partitioned piece `-<part>`; a schema property named `hvac:system` is therefore also refused —
rename it.

## Collections, and the inventory callback

A collection in your schema — `z.array(GroupSchema)` — needs no special handling on the short
path: it is one group, extracted as an array in its own call. When a collection grows and the
model starts confusing its instances (values bleeding between systems), the scoped per-instance
strategy fills one record per call — and that strategy needs one thing the library cannot write
for you: the **inventory callback**, `(transcript) => Promise<Roster>` — the house-wide pass that
decides how many instances exist before any fill runs.

Here is a worked one, using the exported `extractInventory` for the call itself:

```ts
import { z } from "zod";
import { extractInventory, type Roster } from "@azx/ribo-core";

// What one candidate looks like. Every span field must quote the transcript
// verbatim — the response is parsed against this schema, so a fabricated
// mention is rejected at the trust boundary.
const rosterSchema = z.object({
  hvac: z.union([
    z.array(
      z.object({
        mentionSpan: z.string(),
        discriminator: z.string(),
        distinguishedBy: z.string().nullable(),
        eligibility: z.string(),
        eligibilitySpan: z.string().nullable(),
      }),
    ),
    // "none stated" — the model can say the speaker said there are none.
    z.object({ stated: z.literal("none"), span: z.string() }),
  ]),
});

const inventory = async (transcript: string): Promise<Roster> => {
  const roster = await extractInventory(
    {
      name: "hvac-inventory",
      instructions:
        "List each HVAC system the speaker describes in the house. " +
        "Quote the words that mention it verbatim as mentionSpan. " +
        'eligibility is "current" for a system present in the house; ' +
        "anything else (removed, hypothetical, a neighbour's) puts the record out of scope. " +
        "The transcript follows.",
      schema: rosterSchema,
      chat,
      model,
    },
    transcript,
  );
  return roster;
};

const extractor = scopedInstanceExtractor({
  target, // { name, extractionSchema: enveloped(visitSchema), instructions }
  chat,
  model,
  inventory,
  // The scope block each per-instance fill call carries: the adapter (here, you)
  // renders it in the host tool's natural language.
  buildFillInstructions: (groupKey, scope) =>
    `Extract the ${groupKey} fields for ONE system only: ${scope.positive.discriminator} ` +
    `(${scope.positive.mentionSpan}). Other systems in this house — ${scope.siblings
      .map((s) => s.discriminator)
      .join(", ")} — are OUT of scope; do not report their values. ` +
    `Records marked excluded were rejected and belong in no field.`,
});
```

The roster is scaffolding — each `current` candidate gets its own fill call with the others held
out of scope, the results assemble into the array your schema declares, and a `stated: "none"`
entry seeds the group empty with its span recorded. A roster naming more current instances than
`instanceCap` throws rather than truncating.

Per-instance is the default (`fill: "per-instance"`) and the safe choice: each fill sees one
instance with its siblings held out of scope. When a collection has many instances,
`fill: "batched"` asks for every current one in a single call per part, each reply element
carrying its roster `instanceId` and merged by id, so the order the model answers in cannot
mispair values; `fill: { batchAbove: n }` batches only collections with more than `n` current
instances (ADR 0035). The mode each collection used lands on the result's `fillModes` — a live
report of how the run's calls were cut, never persisted.

## Letting a model propose shape operations

The `schemaExtractor` example above uses the schema as-is: every leaf becomes a fillable field, and
the model's job is to map a dictation onto it. For unfamiliar schemas — anything the user's domain
tuned against a fill-rate corpus — that misses the auditing scope the corpus produced. Asking a
human to write out the operations by hand works; asking a model to propose the same operations also
works, and is one call.

`proposeExtractionShape` is a model-driven counterpart to `deriveExtractionShape`. Same inputs, same
applier — the model emits the operations, and the same Stage 1 applier applies them:

```ts
import { proposeExtractionShape } from "@azx/ribo-core";
import { openAiChat } from "@azx/ribo-chat-openai";

const chat = openAiChat({ apiKey, baseUrl, fetchImpl: /* origin-injecting, see above */ });

const shape = await proposeExtractionShape(visitSchema, {
  chat,
  model: "gpt-5.6-sol",
  context: "visit-propose",
  instructions:
    "Audit a service-visit dictation. Drop any field that is virtually never dictated.",
});

// Wire straight into the rest of the pipeline:
const extractor = schemaExtractor({
  name: "service-visit",
  instructions: "Extract the visit fields. Quote spans verbatim.",
  chat,
  model: "gpt-5.6-sol",
  extractionSchema: shape.extractionSchema,
  partitions: shape.partitions,
});
```

The model sees the schema's leaves and kinds — paths, the closed set of leaf kinds (string, number,
boolean, enum, literal), each leaf's `.describe` text verbatim — and proposes a list of `drop`,
`retype string→number`, `regroup` (re-nest leaves within one top-level group), or `nest` (create a
new top-level group and move top-level leaves into it — how a flat schema gains structure)
operations. The cap is **not** in the prompt — proposing as many or as few operations as warranted
is the model's call; the schema packing is `schemaExtractor`'s downstream concern. The wave's ADR
(0016) records the cap-policy argument.

A `partition` splits one group's extraction calls by meaning instead of by size: the model
proposes labels, each naming the group's direct fields (`heating`, `cooling`), and every call for
that group covers exactly one part, titled with a line like "This call covers the heating fields
of hvac." Fields no part names form a `remainder` part, so nothing goes unextracted. A partition
changes no schema, no mapping and no identity — the group keeps its key, and the merge and
write-back never see the cut (ADR 0034). Review is the one consumer that can: handing the shape
back to `buildReviewRequest` or `useReview` as a `reviewPlan` lays the review tree out by the
same record — one labelled section per part, fields no part names collected under "Other" (ADR
0036). Without a plan, review never sees the cut either. The cut lives on the derived shape, not
in its schema, so forward `shape.partitions` to the extractor as the example above does; an
extractor built from `shape.extractionSchema` alone extracts the group unpartitioned.

A `nest` buys extraction-side structure only: the extraction schema carries the new group as a
subject rather than as loose fields, and it becomes its own `splitExtractionSchema` entry — its
own call and prompt assembly. Top-level leaves no nest moved are not stranded by that: they ride
one or more pieces of the unwrapped portion, keyed `""` (ADR 0023), beside the named groups. The
derived patch is unchanged by a nest, so review still renders the moved leaves at their flat
paths, and `requiredOnCreate`, `identifyingFields` and provenance cannot be declared on the new
group. ADR 0022 records the decision and its limits.

How it lands on a working extraction at every failure mode:

- **A successful proposal returns the operations**; the applier's `assertShapeMapping` post-condition
  fires on the same path the hand-written call takes, so the proposed shape and a hand-written shape
  are interchangeable from the rest of the pipeline's perspective.
- **A proposal the applier refuses is repaired on the next turn** — and the turn is a resume, not a
  re-proposal: operations that apply are committed and never re-sent, the model's previous answer is
  not echoed back, and the request shows the field list as the committed operations left it (tagged
  `[dropped]`, `[retyped → number]`, `[moved → …]`) plus every refusal, one line each. The model
  replies with a delta of new operations only, so a reply containing just the fixes loses nothing.
- **At exhaustion (no repair budget, transport verdict repeats) the function returns the committed
  set — every operation that applied, in commit order** — `[]` only when nothing committed, a valid
  operation set either way. The applier accepts the committed set as a derivation, and the
  extraction runs end-to-end without dropping on a model verdict the host cannot inspect mid-talk.
  The argument for salvaging over a thrown error is a newcomer: handing them a working extraction
  either way is the goal the wave locked. (ADR 0016 pinned `[]`-always; ADR 0024 amended it to the
  surviving subset; ADR 0032 amends both — the committed set holds the same "keep the pipeline
  open" property on every exit path.)

A host applying a model's proposal itself — or diffing, caching, or auditing one — has the same two
surfaces at the applier level: `deriveExtractionShape` throws the first refusal, while its sibling
`deriveExtractionShapePartially` returns `{ shape, refusals }`, the artifact from the surviving
operations plus every refusal, classified `local` / `consequential` / `set` with the consequential
culprit named. The two are the same code path; an empty refusal list is exactly the throwing
surface's success.

Two entry points are exposed for hosts that want different lifecycles:

- **`proposeShapeOperations(schema, options, declarations)`** returns the operations array — pure
  data, cacheable, diffable, persistable. Pass it the same `provenance`, `requiredOnCreate` and
  `identifyingFields` you will derive with: each attempt is validated against them, so a drop that
  would strand one is repaired during the proposal instead of throwing at your `deriveExtractionShape`
  call.
- **`proposeExtractionShape(schema, …)`** composes the operations with `deriveExtractionShape` and
  returns the full `DerivedExtractionShape` artifact, ready for `schemaExtractor`'s
  `extractionSchema` passthrough.

What this does **not** claim to do: a model's first-pass proposal on a fresh schema does not match
what the Snugg Pro pilot adapter produces, because the pilot's scoping was grown from real
fill-rate data — auditors who actually speak which fields, on 14 transcripts. A model that sees
only a schema cannot reproduce that, and the wave pinned the claim to "gets a newcomer to a
**working** extraction over their own schema"; not "matches a tuned-against-corpus shape".

The cached-extractor pattern still applies: call `proposeShapeOperations` once per schema, cache
the `ShapeOperation[]` however you cache other schema-derived data, and pass it to
`deriveExtractionShape` to compose the artifact. The `PluginStorage`-aligned cache this repo uses
for other per-schema derivations is one of many ways; the lifecycle is yours.

**API pages:** [Schema at scale](/api/schema-at-scale) — the split and the shape-derivation
family this page's derivations belong to, on one lookup page.

## Next

[Schema at Scale](/guide/schema-at-scale) explains why the caps bind and what the measurements
found. [Per-Group Composition](/guide/per-group) covers giving one group its own model, strategy
or wrapper. [Review](/guide/review) picks up once the extracted fields land — a human accepts or
corrects each one with its quote in view.
