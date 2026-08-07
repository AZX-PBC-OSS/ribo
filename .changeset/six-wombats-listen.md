---
"@azx/ribo-ui-react": patch
---

`useStoragePersistence` fixes, round two: the mirror case and a concurrency gap.

A plain `persisted() === false` read now downgrades a known `"granted"` to `"unknown"`, not just
preserves a known `"denied"` — the previous fix handled the first case but, by the same merge
mechanics, could let the UI go on claiming protected storage after the browser had revoked or lost
the grant. Also: concurrent `request()` calls are now ordered so the most recently invoked one's
result wins regardless of which `persist()` promise settles first — `StoragePanel` calling
`request()` from a mount effect means React StrictMode's double-invoke makes this a real, not
theoretical, race.
