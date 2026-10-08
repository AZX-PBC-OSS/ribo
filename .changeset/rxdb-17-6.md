---
"@azx/ribo-storage-rxdb": patch
---

**rxdb 17.4.0 → 17.6.0.** Fixes only for the parts this package uses. One of them matters here:
`addCollections()` no longer throws `DB6` for an unchanged schema after the device language changes.
The schema hash used `localeCompare()`, so a Czech or Slovak locale produced a different hash. The
storage format is unchanged.
