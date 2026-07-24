# Storage & Eviction

The durable outbox lives in RxDB on the free Dexie storage. `navigator.storage.persist()` asks the
browser not to evict it; when the browser reclaims space anyway, the user is **told** rather than shown
a silently empty list.

::: info Content coming
Full narrative lands in the content pass. See
[`workSafety`](/reference/ribo-core/src/functions/workSafety) and
[`summarizeWork`](/reference/ribo-core/src/functions/summarizeWork).
:::
