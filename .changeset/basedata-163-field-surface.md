---
"@azx/ribo-adapter-snuggpro": minor
---

`basedata` now covers its full 163-field honest capture surface (doc 17 §Scoping) instead of the 7 fields it carried before, generated from Snugg Pro's live spec with verbatim wire names and enum strings. The six component groups (`hvac`/`attic`/`wall`/`window`/`dhw`/`health`) are unchanged — the schema totals 207 leaves, up from 51. `descriptions.generated.ts` was regenerated to match, including a hand-written `.describe()` for the 7 fields whose vendor description is missing, empty, or unusable text, and `hasEv`/`evEnergyStarCharger`'s integer-enum vocabulary now lives in their description (`enveloped()` has no numeric-enum leaf). The frozen extraction fixture was re-captured for this field-set change.
