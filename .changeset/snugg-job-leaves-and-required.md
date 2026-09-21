---
"@azx/ribo-adapter-snuggpro": minor
---

Drop the 26 unwritable `job` leaves; the `job` group is now update-only.

Measured against the vendor's public OpenAPI spec, `PUT /jobs/{jobId}` — the only
way to update an existing job — accepts exactly `serviceTime`, `accountId`,
`note`, `householdIncomeTier` (plus `companyId`, the tenancy fk that was never
in the capture surface). Snugg Pro launches the app with an existing `jobId`, so
job creation is out of scope and the `POST /jobs` leaves — customer name, the
address block, `zip`, `jobType`, `programId`, the property-owner block and the
rest — are write-once at creation with no update path. They are removed from
`snuggValuesSchema` and therefore from `snuggExtractionSchema`.

**The extraction shape changed**: a consumer regenerating prompts or caching the
JSON Schema must regenerate against the new field set. The extracted leaf count
drops accordingly, and prompts stop spending budget on data with nowhere to go.

`requiredOnCreate` loses its `job` entry (`PUT /jobs/{jobId}` requires nothing)
and gains `incentive: ["fromTemplateUuid"]` — `POST /jobs/{jobId}/incentives`
marks it `required: true`, so an incentive create is now asked of the auditor at
review time instead of failing at the API. The declaration holds even though the
incentive group is excluded from writing in this release: it declares what the
API refuses, not what ships.

`snuggCtxSchema.assessmentId` is now digits-only (still a string): the spec
types the job's `id` an integer and the value interpolates into
`/jobs/{jobId}`, so a malformed context fails the trust boundary instead of
building a URL that 404s at write time.

The few-shot example in `examples.ts` is trimmed to the same four leaves, so a
consumer regenerating prompts regenerates the schema and the example together.
