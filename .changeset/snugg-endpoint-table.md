---
"@azx/ribo-adapter-snuggpro": minor
---

Generate a machine-readable description of Snugg Pro's write endpoints —
`SNUGG_ENDPOINTS` in `endpoints.generated.ts`, keyed by the twenty group names of
`snuggValuesSchema`, carrying each group's kind (collection, singleton or job), the
verb and path template of its write operations (`{jobId}`/`{uuid}` left as
placeholders), the accepted parameter names with their declared spec types, the
required-on-create names, and the create-only names.

The table is derived from the vendor's live OpenAPI spec by
`pnpm snugg:refresh`, which now regenerates both generated artifacts from one spec
fetch; `pnpm snugg:check` fails if either has drifted. The derivation matches
operations to groups by path shape, so the vendor's irregularities land in the data
rather than in a hand-maintained table: `incentive` creates at
`POST /jobs/{jobId}/incentives` and updates at `PUT /jobs/{jobId}/incentives/{uuid}`,
the singleton groups' single `POST /jobs/{jobId}/<group>` serves both create and
update, and `PUT /jobs/{jobId}` is the `job` group's update endpoint alone.
