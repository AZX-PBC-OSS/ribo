---
"@azx/ribo-ui-react": patch
---

Fix `useStoragePersistence` reverting a real refusal back to "unknown".

`readStorage()`'s mount/`refresh()` path mapped a plain `persisted() === false` read to
`persistence: "unknown"` unconditionally — including when the shared snapshot already held
`"denied"` from an earlier `request()`. Because every component calling the hook triggers its
own `refresh()` on its own mount, a second consumer mounting after the first one's `request()`
settled (the playground's `WorkSafetyPanel`, via `useWorkSafety`, alongside `StoragePanel`) would
silently revert an explicit refusal back to "still checking" forever, with nothing left to correct
it. `false` is ambiguous between "never asked" and "asked and refused"; only `request()`'s own
`persist()` return value can tell the two apart, so a plain read now leaves `persistence` unset on
`false` rather than asserting `"unknown"` over a value it cannot actually know is unknown.
