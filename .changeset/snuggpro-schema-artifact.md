---
"@azx/ribo-adapter-snuggpro": minor
---

The package publishes its extraction schema as a JSON Schema document at the new subpath
`@azx/ribo-adapter-snuggpro/extraction.schema.json` (OpenAPI 3.0 form — `nullable: true`, the
dialect `@azx/ribo-cli`'s `ribo schema inspect` takes). The file is generated during the
package's own build from `snuggExtractionSchema` with
`z.toJSONSchema(schema, { target: "openapi-3.0" })` — the zod module stays the single source of
truth and the file is never hand-edited. A round-trip test
(`acceptance/schema-artifact-round-trip.test.ts`) guards the artifact: it asserts the generated
file and the live zod schema produce one identical `inspectSchema` report, and is the guard to
run on any zod bump (ADR 0039).
