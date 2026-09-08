---
"@azx/ribo-adapter-snuggpro": minor
---

The `health` group now covers the last two `formData` fields of `POST /jobs/{jobId}/health` (doc 20 §5.8, job-collections tranche 1): `healthDrainageSystemCondition` (`healthRoofCondition`'s sibling on the `Good`/`Potential Issues`/`NA` condition enum) and `healthSafetyQuestionsDisclosed` (a `Yes`/`No` disclosure attestation — a compliance statement about a conversation with the homeowner, described so it is set only from an explicit statement, never inferred from the safety tests having been run). The endpoint is now complete at 16 of its 17 fields — every `formData` parameter but the malformed `customFields`. The schema totals 209 leaves, up from 207; `descriptions.generated.ts` was regenerated (the vendor describes both new leaves), and the frozen extraction fixture was re-captured for this field-set change.
