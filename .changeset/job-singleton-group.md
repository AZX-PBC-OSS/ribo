---
"@azx/ribo-adapter-snuggpro": minor
---

New `job` group — the job itself as a job-collection SINGLETON (doc 20 §5.1; job-collections
foundation design), modeled exactly like `stage`/`basedata`/`health`: a flat object,
`.optional()` at the top level, no roster/instance-identity wiring — one job per recording
session. It carries every field doc 20 verdicts `capture`/`capture?` across `POST /jobs`
(createJob) and its `PUT /jobs/{jobId}` update twin (a strict subset of the create, so one
group covers both): the customer's name, address and contacts; the nine-field
`propertyOwner*` singleton sub-group; scheduling (`serviceTime`); workflow and program
wiring (`stageId`, `jobType`, `accountId`, `programId`); `renterOwner`, `altId`,
`buildingId`, `auditType`, `note`, `useStrictBpi2400Calibration` and `householdIncomeTier`.
The two `exclude` fields are skipped: `fromTemplateId` (setup-time template fk) and
`companyId` (tenancy fk, fixed per credential).

Doc 20 §5.1's STATES vocabulary is declared ONCE as `UsState` and reused by both fields that
carry it (`state`, `propertyOwnerState`); the INCOME-TIERS vocabulary is `HouseholdIncomeTier`.
The group's numeric enums follow the `hasEv`/`energyStarColdClimateHeatPump` precedent —
`enveloped()` has no numeric-enum leaf, so `stageId`, `jobType`, `renterOwner` and
`useStrictBpi2400Calibration` are `z.number()` with their label→code vocabularies in their
descriptions; `auditType`'s declared-but-empty `enum: []` is free-text-into-review per
convention. `accountId` and `programId` are captured as PLAIN FREE TEXT (the spoken
assignee/program name) despite their integer wire type, per
`runtime-reference-resolution-design.md` — the name→id lookup is a review/write-time step,
the treatment `incentive.fromTemplateUuid` established.

`POST /jobs` is the one job-collection resource with genuinely required fields (doc 20 §4.6),
so `requiredOnCreate` gains a `job` entry naming every required field in the capture surface —
the repo's existing per-group mechanism, surfaced at review, not a new one. Rule 17 of the
instructions carries the group's normalization intent: occupant-vs-owner contact
disambiguation, full-state-name→code mapping, explicit-statement-only toggles, names-not-ids,
and absolute-date-only scheduling. `descriptions.generated.ts` was regenerated via
`pnpm snugg:refresh`, and the frozen extraction fixture was deliberately re-captured for this
field-set change (the diff confined to the new group and the top-level required list); the
ground-truth corpus is untouched by design — as a singleton, `job` scores as flat unmentioned
leaves.
