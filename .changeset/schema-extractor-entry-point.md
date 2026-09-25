---
"@azx/ribo-core": minor
---

**`schemaExtractor`: the entry point that takes a raw zod schema.** Hand it the plain patch schema
you wrote (or generated from a database, an OpenAPI spec, a TS interface), a chat client and a
model, and get an `Extractor` — the `enveloped()` derivation (with the optional `provenance`
granularity map) and the single-shot-vs-per-group selection both run inside. A caller who already
holds a derived schema passes it under `extractionSchema` instead of `schema` and it is used
as-is; the return type is exact either way.

**`splitExtractionSchema` packs against serialized size as well as nullable unions.** The second
parameter now accepts an options bag, `SplitOptions { maxNullableUnionsPerGroup,
maxSerializedCharsPerGroup }` — a bare number keeps meaning the union cap, so every existing
caller is unchanged. A schema with few unions and many bytes previously passed every check the
library made and died at a provider `400: schema must serialize to <= 32768 characters and nest
<= 12 levels`; with the byte cap supplied, such a schema splits into pieces that each fit, each
piece measured on its own rendered JSON Schema. The byte cap carries no library default — the
ceiling is named by one route's error text and differs by route, so the caller whose chat client
chose the route supplies the number (`perGroupExtractor` gained the same option as a
pass-through). A single property that cannot fit any piece now throws at construction, naming the
group, the property, the measured size, the cap and the option — previously it was emitted as an
over-cap piece that failed later at the provider.

**`prepareGroups` is exported** — the one construction site for `PreparedGroup`, lifted out of
`scopedInstanceExtractor` — so a host composing its own phase list builds the same groups the
preset builds. It also guards the wire name: a structured-output schema name is constrained to
`[A-Za-z0-9_-]` by at least one platform route (a colon is rejected with a generic `400
validation_failed` that reads identically to an over-cap schema), and every name built from a
target's name and the schema's group keys — including `singleShotExtractor`'s — is now checked at
construction, throwing and naming the offending character instead of failing at the route.
