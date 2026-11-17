# Writing a schema for ribo

Every `ribo` command reads the same input: a JSON Schema document in **OpenAPI 3.0 form**. The CLI
converts it with zod's own importer — `z.fromJSONSchema(document, { defaultTarget: "openapi-3.0" })` —
so there is one implementation of the dialect, and it is not ribo's. If you keep your schema in
zod, the matching exporter is `z.toJSONSchema(schema, { target: "openapi-3.0" })`, and
[From a Schema](/guide/from-a-schema) is the guide for that side of the fence.

## Nullability: `"nullable": true`, never the draft-2020 forms

Write a leaf that may hold no value as `"nullable": true`:

```json
{ "type": "number", "description": "The year the home was built.", "nullable": true }
```

The draft-2020-12 spellings are refused, both of them:

- `anyOf` with a `null` arm is refused **loudly, by name**, before conversion — nullability is the
  one rendering that shifts between schema dialects, and a document that speaks the wrong one is
  never silently converted.
- `type: ["number", "null"]` converts, but to a union — and a union is not a leaf kind the field
  inventory can walk, so the document is refused as unwalkable with the union named.

Either way the fix is the same: rewrite the leaf as `"nullable": true`.

## Groups and leaves

The CLI's whole vocabulary is two shapes:

- A **leaf** is a scalar field: `string`, `number`, `boolean`, an `enum`, or a `const` literal.
- A **group** is a top-level object (or a top-level array of objects) holding leaves.

```json
{
  "type": "object",
  "properties": {
    "heating": {
      "type": "object",
      "description": "The home's heating system.",
      "properties": {
        "fuel": {
          "type": "string",
          "enum": ["gas", "oil", "electric", "heat-pump"],
          "description": "The heating fuel."
        }
      },
      "required": ["fuel"]
    }
  },
  "required": ["heating"]
}
```

Groups are the unit ribo splits calls over, so they are a modelling decision: one group per subject
the document talks about. A schema whose top-level keys are **all** groups takes the grouped split
path; a single loose top-level leaf sends the whole schema down the flat path, one call carrying
everything. The report's `keys` and `split path` lines state which you got.

## Collections: arrays of objects

An array of objects is a collection — one entry per thing the document mentions. The inventory
addresses a collection's leaf once, at its element-relative path: `upgrades.measure`, not
`upgrades[0].measure`. An array of scalars is not a supported shape; the walk refuses it, naming
the path.

## Enums

`"enum": [...]` constrains a leaf to a closed set. The scorer matches an enum answer against the
members the schema declares — never a hand-kept list — and an expectation naming no member the
schema declares is `unscorable`, not quietly wrong.

## `description` is the model's field guidance

A leaf's `description` is not documentation for humans alone: it is the guidance the extraction
prompt carries for that field. Write it as an instruction to the reader of the document — what the
field means and where in the text to find it — not as a type restatement. `schema inspect`'s
**guidance coverage** line counts the fields carrying one.

Two rules follow:

- A description that asks the model to **reformat** ("as YYYY-MM-DD", "in lowercase") is a
  **reformat finding**: the answer should arrive as the source stated it, because review and the
  span check read the source's own words. State the format you accept in review instead.
- A description on a wrapper counts. A leaf that is absent from `required`, nullable, and
  described keeps its description whichever wrapper carries the text.

## `required` — and why leaving a leaf out is fine

`required` lists the properties that must be present in the JSON document. A leaf left out of it
converts to an _optional_ field — ribo's "may not have been said" state — which is the natural
state of an extraction field: the model answers it when the document says it and stays silent when
it does not. Requiring every leaf asks the model to fill every field of every document, including
the ones the document never mentioned. Require what every input genuinely carries; leave the rest
out.

## What `schema inspect`'s report lines mean

`ribo schema inspect` renders the same report for humans or as `--json`; the lines are:

- **schema fingerprint** — SHA-256 over the document's canonical JSON; two documents with the same
  fingerprint are the same schema.
- **fields** — the schema-field count, one per field (provenance envelopes are unwrapped before
  counting, so an enveloped schema is not inflated by its envelope members).
- **groups / split path / call shape** — the top-level keys by kind, whether the grouped or flat
  split applies (and why), and the call shape `schemaExtractor` would select.
- **whole / worst piece / pieces** — the serialized size, nesting depth and nullable-union counts,
  for the whole schema and per piece the split produces; the worst piece is what a provider's
  schema-size ceiling bites first.
- **split caps** — the caps the partition was computed under: the nullable-union cap and the byte
  cap (off unless `--max-serialized-chars-per-group` sets one).
- **single-shot / per-group / presence-narrowed / consensus / retry budget** — the call counts per
  attempt each strategy costs, read off the same call model the spend estimate reads. A count of
  "unavailable" is the model's own answer (a flat schema has no per-group bound), never a zero.
- **guidance coverage** — described fields over walked fields. Anything short of full coverage is
  fields the model reads unguided.
- **reformat findings** — one per field whose description asks for reformatting (see above).
- **granularity violations** — groups not derived at leaf provenance granularity. Over a JSON
  Schema document every group reports `"none"`, because the document form cannot carry provenance
  envelopes; a zod-authored schema derived with `enveloped()` at leaf granularity is what clears
  the list, and the judging combinators need it. Read it as "what this document cannot express",
  not as a defect to fix in the JSON.
- **not visible in the input** — the construct classes a document can never carry: zod
  refinements and zod transforms. Always listed, never detected — if the source schema had them,
  they exist only in your zod copy.
- **refusal** — the refusal constructing the extraction would raise, carried as a finding in the
  report, not a failure. Exit codes are unaffected by it.
- **threshold** — one line per supplied `--max-depth` / `--max-piece-chars`, within or breached.

## What cannot be converted

A document `z.fromJSONSchema` cannot convert is a could-not-run fault (exit 2), with the
converter's own message naming the construct. Rewrite the construct out of the document — or keep
the schema in zod and use the library directly, per [From a Schema](/guide/from-a-schema).
