---
"@azx/ribo-adapter-snuggpro": minor
---

The `window` group now carries doc 20 §5.5's verdicted capture surface of
`POST /jobs/{jobId}/window` — every `capture`/`capture?` field of its base and
improved tables, verbatim wire names and enum members. Orientation is a FIELD
SUFFIX, not an instance: the area, percent, overhang and exterior-treatment
fields are quadrupled North/East/South/West as separate leaves, and the four
exterior-treatment fields plus their four `*Improved` twins share one exported
enum (`WindowExteriorTreatment`, doc 20's WINDOW-EXTERIOR-TREATMENT). The
`*Improved` area fields are kept per the foundation design's decision 3 — they
are how the vendor encodes WHICH windows get replaced (dictated intent), not
retrofit echoes of the base side. `windowHesSpecs` stays excluded: it is a
product-mode flag the writer sets, never a transcript observation. The
`capture?` leaves carry descriptions reflecting doc 20's caveats (percentages
are alternatives to the absolute areas; SHGC is never adjusted for screens or
shades; improved specs only when stated).

`descriptions.generated.ts` was regenerated via `pnpm snugg:refresh` — the
vendor describes every new leaf — and the frozen extraction fixture was
deliberately re-captured for this field-set change (the diff is confined to the
window group's properties and required list). The window group now exceeds the
8-enveloped-leaf per-call cap and partitions into four pieces; the ground-truth
corpus is untouched by design — unannotated leaves score as unmentioned.
