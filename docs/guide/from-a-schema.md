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
import { isSpanGrounded } from "@azx/ribo-core";
import { openAiChat, schemaExtractor } from "@azx/ribo-extractor-openai";

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
import type { Roster } from "@azx/ribo-core";
import { extractInventory } from "@azx/ribo-extractor-openai";

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

## Letting a model propose shape operations

The `schemaExtractor` example above uses the schema as-is: every leaf becomes a fillable field, and
the model's job is to map a dictation onto it. For unfamiliar schemas — anything the user's domain
tuned against a fill-rate corpus — that misses the auditing scope the corpus produced. Asking a
human to write out the operations by hand works; asking a model to propose the same operations also
works, and is one call.

`proposeExtractionShape` is a model-driven counterpart to `deriveExtractionShape`. Same inputs, same
applier — the model emits the operations, and the same Stage 1 applier applies them:

```ts
import { proposeExtractionShape, openAiChat } from "@azx/ribo-extractor-openai";

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
  schema: visitSchema,
  name: "service-visit",
  instructions: "Extract the visit fields. Quote spans verbatim.",
  chat,
  model: "gpt-5.6-sol",
  extractionSchema: shape.extractionSchema,
});
```

The model sees the schema's leaves and kinds — paths, the closed set of leaf kinds (string, number,
boolean, enum, literal), each leaf's `.describe` text verbatim — and proposes a list of `drop`,
`retype string→number`, `regroup` (re-nest leaves within one top-level group), or `nest` (create a
new top-level group and move top-level leaves into it — how a flat schema gains structure)
operations. The cap is **not** in the prompt — proposing as many or as few operations as warranted
is the model's call; the schema packing is `schemaExtractor`'s downstream concern. The wave's ADR
(0016) records the cap-policy argument.

A `nest` buys extraction-side structure only: the extraction schema carries the new group as a
subject rather than as loose fields. It also becomes its own `splitExtractionSchema` entry — its
own call and prompt assembly — but only if the nests cover **every** top-level key; one unmoved
top-level leaf collapses the whole schema to the flat fallback, nest groups included. The derived
patch is unchanged by a nest, so review still renders the moved leaves at their flat paths, and
`requiredOnCreate`, `identifyingFields` and provenance cannot be declared on the new group. ADR
0022 records the decision and its limits.

How it lands on a working extraction at every failure mode:

- **A successful proposal returns the operations**; the applier's `assertShapeMapping` post-condition
  fires on the same path the hand-written call takes, so the proposed shape and a hand-written shape
  are interchangeable from the rest of the pipeline's perspective.
- **A proposal the applier refuses is repaired on the next turn** — the applier's own precise
  refusal text becomes the user-turn feedback, the model's previous (rejected) answer becomes the
  assistant turn, and the schema's pre-`strict` JSON path travels unchanged.
- **At exhaustion (no repair budget, transport verdict repeats) the function returns `[]`** — a
  valid operation set, just unshaped. The applier accepts it as pure normalization, and the
  extraction runs end-to-end without dropping on a model verdict the host cannot inspect mid-talk.
  The argument for `[]` over a thrown error is a newcomer: handing them a working extraction either
  way is the goal the wave locked.

Two entry points are exposed for hosts that want different lifecycles:

- **`proposeShapeOperations(schema, …)`** returns the operations array — pure data, cacheable,
  diffable, persistable.
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

## Next

[Schema at Scale](/guide/schema-at-scale) explains why the caps bind and what the measurements
found. [Per-Group Composition](/guide/per-group) covers giving one group its own model, strategy
or wrapper. [Review](/guide/review) picks up once the extracted fields land — a human accepts or
corrects each one with its quote in view.
