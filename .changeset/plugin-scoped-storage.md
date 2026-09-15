---
"@azx/ribo-core": minor
---

Add plugin-scoped storage — a namespaced, capture-scoped key-value handle (`Outbox.pluginStorage(captureId, pluginId)`) that lets a plugin's transcriber and extractor halves share durable state (a document id, a cached upload handle, page annotations) without core learning what it is. Entries live in a new `pluginStorage` RxDB collection (version 0, no migration needed for existing databases). Core sweeps every entry for a capture when the capture is dropped (`remove`/`removeMany`/`clear`) or discarded (`patch` with `status: "discarded"`), removing keys for every plugin that wrote against that capture — not just the one that asked.
