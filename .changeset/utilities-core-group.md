---
"@azx/ribo-adapter-snuggpro": minor
---

New `utilities` group — the job's utility-billing record as a job-collection SINGLETON (doc 20
§5.2; job-collections foundation design), alongside `basedata`, `health` and `stage` rather than
as a per-instance array: `POST /jobs/{jobId}/utilities` is an upsert keyed by the job itself, with
no `utilityId` segment, and multiple fuels are modelled by name-mangled fields rather than
repetition. The group carries the endpoint's CORE subset only (doc 20 §8.3): the mode/provenance
selectors, the three provider names, the simple-bill scalars, the units and primary-fuel enums, the
per-fuel price overrides, and the rate plans. The delivered-fuel windows and the detailed 12-month
bill series are separate, out-of-scope tranches (the series is an import path, never dictation);
the account-number fields are left out as identifier-shaped, high-ASR-error captures rather than
names; and `utilityRatePlanPriceElectricity` is held per doc 20's own "do not map until confirmed"
(§9). The rate-plan fields are free text — the spec declares them with `enum: []`, the
`hvacDuctLocation` precedent. `descriptions.generated.ts` was regenerated and the frozen extraction
fixture re-captured for this deliberate field-set change; the diff is confined to the utilities
group.
