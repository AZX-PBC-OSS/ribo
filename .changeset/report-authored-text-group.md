---
"@azx/ribo-adapter-snuggpro": minor
---

New `report` group — the homeowner-facing report's authored text, as a job-collection SINGLETON
(doc 20 §5.3; job-collections foundation design), modeled the same flat-object way as `basedata`,
`health` and `stage` rather than as a per-instance array: `POST /jobs/{jobId}/report` terminates at
the resource name with no `{reportUuid}` sub-path, its one verb is a `POST` summarised "Update
Report" (upsert-on-the-job), and there is no delete and no list. It carries only doc 20's (a1)+(a2)
verdicted `capture`/`capture?` surface: the three genuine long-form prose fields — the only strings
in `#/definitions/report` with no vendor `maxLength` (`coverTextArea`, `additionalNotesOverview`,
`safetyOverview`) — and five short single-line labels (`titleCover`, `concernsSidebar`,
`solutionsTitle`, `titleCustom1`, `titleCustom2`). The (b1)/(b2) `element*` display-mode and
`page*` visibility flags are a separately deferred tranche and are absent; the presentation-only
titles doc 20 verdicts `exclude` stay out. The API's character caps are copied into the leaf
descriptions, including the two that look wrong at a glance: `concernsSidebar` reads like it wants
the homeowner's concerns in prose but is capped at 32 characters, and `solutionsTitle` is uncapped
yet is a subheader — treated as short. A new instruction rule pins the group's central hazard:
report fields hold dictated words only, never prose the model composes itself, and the labels never
take paragraph-length output. `descriptions.generated.ts` was regenerated (the vendor describes
every new leaf) and the frozen extraction fixture was re-captured for this deliberate field-set
change.
